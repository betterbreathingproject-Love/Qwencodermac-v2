'use strict'

const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot'
const BACKOFF_BASE_DELAY = 2    // seconds
const BACKOFF_MAX_DELAY = 60    // seconds
const PAIRING_TOKEN_EXPIRY = 10 * 60 * 1000 // 10 minutes in ms

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Pure function: calculate exponential backoff delay.
 * @param {number} retryCount - Non-negative retry count
 * @returns {number} Delay in seconds: min(2 * 2^retryCount, 60)
 */
function calculateBackoffDelay(retryCount) {
  return Math.min(BACKOFF_BASE_DELAY * Math.pow(2, retryCount), BACKOFF_MAX_DELAY)
}

/**
 * POST JSON to Telegram Bot API using node:https.
 * @param {string} method - Telegram API method (e.g. 'getMe', 'sendMessage')
 * @param {string} token - Bot token
 * @param {object} [params={}] - JSON body parameters
 * @returns {Promise<object>} Parsed JSON response
 */
function telegramRequest(method, token, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${TELEGRAM_API_BASE}${token}/${method}`)
    const body = JSON.stringify(params)
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 35000,
    }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          reject(new Error(data || 'Empty response'))
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * Upload a file to Telegram Bot API using hand-rolled multipart/form-data.
 * @param {string} method - Telegram API method (e.g. 'sendVideo', 'sendPhoto')
 * @param {string} token - Bot token
 * @param {number|string} chatId - Target chat ID
 * @param {string} fieldName - Form field name for the file (e.g. 'video', 'photo')
 * @param {string} filePath - Absolute path to the file to upload
 * @param {string} [caption] - Optional caption
 * @returns {Promise<object>} Parsed JSON response
 */
function telegramUpload(method, token, chatId, fieldName, filePath, caption) {
  return new Promise((resolve, reject) => {
    const boundary = `----TelegramUpload${crypto.randomBytes(16).toString('hex')}`
    const filename = path.basename(filePath)

    let fileBuffer
    try {
      fileBuffer = fs.readFileSync(filePath)
    } catch (err) {
      return reject(new Error(`Failed to read file: ${err.message}`))
    }

    // Build multipart body parts
    const parts = []

    // chat_id field
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
      `${chatId}\r\n`
    )

    // caption field (if provided)
    if (caption) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="caption"\r\n\r\n` +
        `${caption}\r\n`
      )
    }

    // file field
    const fileHeader =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    const fileFooter = `\r\n`

    // closing boundary
    const closing = `--${boundary}--\r\n`

    // Assemble the full body as a Buffer
    const textParts = Buffer.from(parts.join(''), 'utf8')
    const headerBuf = Buffer.from(fileHeader, 'utf8')
    const footerBuf = Buffer.from(fileFooter, 'utf8')
    const closingBuf = Buffer.from(closing, 'utf8')
    const body = Buffer.concat([textParts, headerBuf, fileBuffer, footerBuf, closingBuf])

    const url = new URL(`${TELEGRAM_API_BASE}${token}/${method}`)
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 120000, // 2 min timeout for file uploads
    }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          reject(new Error(data || 'Empty response'))
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Upload timed out'))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

class TelegramBot extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.configPath] - Path to config JSON file
   * @param {string} [options.appDataDir] - App data directory for defaults
   */
  constructor(options = {}) {
    super()
    this._configPath = options.configPath || null
    this._appDataDir = options.appDataDir || null

    // If no explicit configPath, derive from appDataDir
    if (!this._configPath && this._appDataDir) {
      this._configPath = path.join(this._appDataDir, 'telegram-bot-config.json')
    }

    this._token = null
    this._polling = false
    this._botUsername = null
    this._lastError = null
    this._pairedChatId = null
    this._pairingTokens = new Map()
    this._updateOffset = 0
    this._retryCount = 0
  }

  /**
   * Validate token via getMe, store bot info, begin long-polling.
   * @param {string} token - Telegram bot token
   */
  async start(token) {
    const res = await telegramRequest('getMe', token)
    if (!res.ok) {
      const msg = (res.description) ? res.description : 'getMe failed'
      throw new Error(msg)
    }
    this._token = token
    this._botUsername = res.result.username
    this._polling = true
    this._lastError = null
    this._retryCount = 0
    this._updateOffset = 0
    this.saveConfig()
    // Fire and forget — don't await the poll loop
    this._pollLoop()
  }

  /**
   * Stop polling. The poll loop will exit on its own within the next cycle.
   */
  stop() {
    this._polling = false
    return Promise.resolve()
  }

  /**
   * Return current bot status.
   * @returns {{ connected: boolean, bot_username: string|null, polling: boolean, last_error: string|null }}
   */
  getStatus() {
    return {
      connected: !!this._token && this._polling,
      bot_username: this._botUsername,
      polling: this._polling,
      last_error: this._lastError,
    }
  }

  /**
   * Long-polling loop. Calls getUpdates with 30s timeout, applies
   * exponential backoff on errors via calculateBackoffDelay.
   * @private
   */
  async _pollLoop() {
    while (this._polling) {
      try {
        const res = await telegramRequest('getUpdates', this._token, {
          offset: this._updateOffset,
          timeout: 30,
        })
        this._retryCount = 0
        if (res.ok && Array.isArray(res.result)) {
          for (const update of res.result) {
            this._updateOffset = update.update_id + 1
            this._handleUpdate(update)
          }
        }
      } catch (err) {
        this._retryCount = Math.min(this._retryCount + 1, 10)
        const delay = calculateBackoffDelay(this._retryCount)
        this._lastError = err.message
        this.emit('error', { message: err.message })
        await sleep(delay * 1000)
      }
    }
  }

  /**
   * Send a text message to a Telegram chat.
   * @param {number|string} chatId - Target chat ID
   * @param {string} text - Message text
   * @returns {Promise<{ok: true}|{error: string}>}
   */
  async sendMessage(chatId, text) {
    try {
      const res = await telegramRequest('sendMessage', this._token, { chat_id: chatId, text })
      if (res.ok) return { ok: true }
      return { error: res.description || 'Send failed' }
    } catch (err) {
      return { error: err.message || 'Network error' }
    }
  }

  /**
   * Send a video file to a Telegram chat via multipart upload.
   * @param {number|string} chatId - Target chat ID
   * @param {string} filePath - Absolute path to the video file
   * @param {string} [caption] - Optional caption
   * @returns {Promise<{ok: true}|{error: string}>}
   */
  async sendVideo(chatId, filePath, caption) {
    try {
      const res = await telegramUpload('sendVideo', this._token, chatId, 'video', filePath, caption)
      if (res.ok) return { ok: true }
      return { error: res.description || 'Send failed' }
    } catch (err) {
      return { error: err.message || 'Network error' }
    }
  }

  /**
   * Send a photo file to a Telegram chat via multipart upload.
   * @param {number|string} chatId - Target chat ID
   * @param {string} filePath - Absolute path to the photo file
   * @param {string} [caption] - Optional caption
   * @returns {Promise<{ok: true}|{error: string}>}
   */
  async sendPhoto(chatId, filePath, caption) {
    try {
      const res = await telegramUpload('sendPhoto', this._token, chatId, 'photo', filePath, caption)
      if (res.ok) return { ok: true }
      return { error: res.description || 'Send failed' }
    } catch (err) {
      return { error: err.message || 'Network error' }
    }
  }

  /**
   * Generate a pairing token for QR-code-based Telegram chat linking.
   * @returns {{ token: string, qrDataUrl: string, expiresAt: number }}
   */
  /**
   * Send a message with an inline Web App button.
   * @param {number|string} chatId
   * @param {string} text - Message text
   * @param {string} buttonText - Button label
   * @param {string} webAppUrl - Mini App URL
   */
  async sendWebAppButton(chatId, text, buttonText, webAppUrl) {
    return telegramRequest('sendMessage', this._token, {
      chat_id: chatId,
      text,
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: buttonText, web_app: { url: webAppUrl } }]],
      }),
    })
  }

  generatePairingToken() {
    const token = crypto.randomBytes(32).toString('hex')
    const createdAt = Date.now()
    this._pairingTokens.set(token, { createdAt, consumed: false })
    const qrDataUrl = `https://t.me/${this._botUsername}?start=${token}`
    return { token, qrDataUrl, expiresAt: createdAt + PAIRING_TOKEN_EXPIRY }
  }

  /**
   * Validate a pairing token and associate the chat ID on success.
   * @param {string} token - The pairing token to validate
   * @param {number|string} chatId - The Telegram chat ID to pair
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  validatePairingToken(token, chatId) {
    const entry = this._pairingTokens.get(token)
    if (!entry) return { ok: false, error: 'Invalid token' }
    if (entry.consumed) return { ok: false, error: 'Token already used' }
    if (Date.now() - entry.createdAt > PAIRING_TOKEN_EXPIRY) return { ok: false, error: 'Token expired' }
    entry.consumed = true
    this._pairedChatId = chatId
    this.saveConfig()
    return { ok: true }
  }

  /**
   * Get the paired Telegram chat ID.
   * @returns {number|string|null}
   */
  getPairedChatId() {
    return this._pairedChatId
  }

  /**
   * Persist bot configuration to disk.
   * Writes { token, pairedChatId, botUsername } to this._configPath.
   */
  saveConfig() {
    if (!this._configPath) return
    const dir = path.dirname(this._configPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const data = JSON.stringify({
      token: this._token,
      pairedChatId: this._pairedChatId ? String(this._pairedChatId) : null,
      botUsername: this._botUsername,
    }, null, 2)
    fs.writeFileSync(this._configPath, data, 'utf8')
  }

  /**
   * Load bot configuration from disk.
   * @returns {{ token: string, pairedChatId: string|null, botUsername: string|null }|null}
   */
  loadConfig() {
    if (!this._configPath) return null
    try {
      const raw = fs.readFileSync(this._configPath, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed
    } catch {
      return null
    }
  }

  /**
   * Parse a Telegram update and emit the appropriate event.
   * - 'photo'   → { chatId, fileId, caption, messageId }
   * - 'command' → { chatId, command, args, messageId }
   * - 'message' → { chatId, text, messageId }
   * @param {object} update - Raw Telegram update object
   * @private
   */
  _handleUpdate(update) {
    const message = update.message
    if (!message) return

    const chatId = message.chat.id
    const messageId = message.message_id

    // Photo messages
    if (message.photo) {
      const fileId = message.photo[message.photo.length - 1].file_id
      this.emit('photo', { chatId, fileId, caption: message.caption || '', messageId })
      return
    }

    // Command messages (text starting with '/')
    if (message.text && message.text.startsWith('/')) {
      const spaceIdx = message.text.indexOf(' ')
      const command = spaceIdx === -1
        ? message.text.slice(1)
        : message.text.slice(1, spaceIdx)
      const args = spaceIdx === -1
        ? ''
        : message.text.slice(spaceIdx + 1)

      // Handle /start {token} for pairing
      if (command === 'start' && args) {
        const result = this.validatePairingToken(args, chatId)
        if (result.ok) {
          this.emit('paired', { chatId })
          this.sendMessage(chatId, 'Pairing successful! You can now use /run to start jobs.')
        } else {
          this.sendMessage(chatId, `Pairing failed: ${result.error}`)
        }
        return
      }

      this.emit('command', { chatId, command, args, messageId })
      return
    }

    // Plain text messages
    if (message.text) {
      this.emit('message', { chatId, text: message.text, messageId })
    }
  }
}

module.exports = {
  TelegramBot,
  telegramRequest,
  telegramUpload,
  calculateBackoffDelay,
}
