'use strict'

const { EventEmitter } = require('node:events')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

class RemoteJobController extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.telegramBot - TelegramBot instance
   * @param {number|string} opts.chatId - Paired Telegram chat ID
   * @param {object} opts.recordingManager - RecordingManager instance
   */
  constructor({ telegramBot, chatId, recordingManager }) {
    super()
    this._bot = telegramBot
    this._chatId = chatId
    this._recordingManager = recordingManager
    this._state = 'idle'  // 'idle' | 'running' | 'completed' | 'failed'
    this._jobId = null
    this._bridge = null
    this._inputRequester = null
    this._lastStatusUpdate = 0
    this._statusInterval = null
  }

  /**
   * Return the current job state.
   * @returns {'idle' | 'running' | 'completed' | 'failed'}
   */
  getJobState() {
    return this._state
  }

  /**
   * Return the current job ID (null when idle).
   * @returns {string|null}
   */
  getJobId() {
    return this._jobId
  }

  /**
   * Start a new agent job with the given prompt.
   * Creates a recording-enabled DirectBridge, wires InputRequester,
   * sends confirmation, runs the agent loop, and delivers the video on completion.
   * @param {string} prompt
   */
  async runJob(prompt) {
    if (this._state === 'running') {
      await this._bot.sendMessage(this._chatId, 'A job is already running. Use /stop to cancel it first.')
      return
    }

    this._jobId = `job_${Date.now()}`
    this._state = 'running'
    this._lastStatusUpdate = Date.now()

    // Generate recording directory
    const recDir = this._recordingManager.getRecordingDir(this._jobId)

    // Send confirmation (Req 5.3)
    await this._bot.sendMessage(this._chatId, `Job started: ${this._jobId}\nPrompt: ${prompt}`)

    try {
      const { DirectBridge, InputRequester, CallbackSink } = require('./direct-bridge')
      const { createPlaywrightInstance } = require('./playwright-tool')

      this._inputRequester = new InputRequester(this._bot, this._chatId)

      // Sink that emits events for observability
      const sink = new CallbackSink(this, this._jobId)

      // Create bridge with telegram forwarder for screenshot forwarding (Req 7.1)
      this._bridge = new DirectBridge(sink, {
        telegramForwarder: {
          sendPhoto: (filePath, caption) => this._bot.sendPhoto(this._chatId, filePath, caption),
        },
      })

      // Set up periodic status updates (Req 5.4 — ≥30s apart)
      this._statusInterval = setInterval(() => {
        if (this._state === 'running' && Date.now() - this._lastStatusUpdate >= 30000) {
          this._lastStatusUpdate = Date.now()
          this._bot.sendMessage(this._chatId, `Job ${this._jobId} still running...`).catch(() => {})
        }
      }, 30000)

      // Run the agent loop with recording enabled
      await this._bridge.run({
        prompt,
        cwd: process.cwd(),
        permissionMode: 'auto',
        model: 'default',
      })

      this._clearStatusInterval()
      this._state = 'completed'

      // Send recording if available (Req 5.5)
      await this._sendRecordingOrNotify()
    } catch (err) {
      this._clearStatusInterval()
      this._state = 'failed'
      // Req 5.6
      await this._bot.sendMessage(this._chatId, `Job ${this._jobId} failed: ${err.message}`)
    }
  }

  /**
   * Dispatch a Telegram command to the appropriate handler.
   * @param {string} command - Command name without leading slash
   * @param {string} args - Arguments string after the command
   */
  async handleCommand(command, args) {
    switch (command) {
      case 'run': {
        if (!args || !args.trim()) {
          await this._bot.sendMessage(this._chatId, 'Usage: /run <prompt>')
          return
        }
        // Req 6.5 — reject /run while input request is pending
        if (this._inputRequester && this._inputRequester.hasPendingRequest()) {
          await this._bot.sendMessage(this._chatId, 'Agent is waiting for your reply. Please respond to the pending question first.')
          return
        }
        // Fire and forget — don't await so the command handler returns immediately
        this.runJob(args.trim())
        break
      }
      case 'status': {
        // Req 5.7
        const state = this.getJobState()
        if (state === 'idle') {
          await this._bot.sendMessage(this._chatId, 'Status: idle — no job running.')
        } else {
          await this._bot.sendMessage(this._chatId, `Status: ${state} — Job ID: ${this._jobId}`)
        }
        break
      }
      case 'stop': {
        // Req 5.8
        if (this._state !== 'running') {
          await this._bot.sendMessage(this._chatId, 'No job is currently running.')
          return
        }
        if (this._bridge) {
          await this._bridge.interrupt()
        }
        this._clearStatusInterval()
        this._state = 'idle'
        await this._bot.sendMessage(this._chatId, `Job ${this._jobId} stopped.`)
        break
      }
      case 'screenshot': {
        // Req 7.2, 7.3
        if (this._state !== 'running') {
          await this._bot.sendMessage(this._chatId, 'No browser session is active.')
          return
        }
        if (this._bridge && this._bridge._browserInstance) {
          try {
            const result = await this._bridge._browserInstance.execute('browser_screenshot', {})
            const content = result.result || ''
            const b64Match = content.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)
            if (b64Match) {
              const tmpPath = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`)
              fs.writeFileSync(tmpPath, Buffer.from(b64Match[1], 'base64'))
              await this._bot.sendPhoto(this._chatId, tmpPath, 'Manual screenshot')
              return
            }
          } catch { /* fall through to no-session message */ }
        }
        await this._bot.sendMessage(this._chatId, 'No browser session is active.')
        break
      }
      default:
        await this._bot.sendMessage(this._chatId, `Unknown command: /${command}`)
    }
  }

  /**
   * Attempt to send the recording video to Telegram, or a text notification.
   * @private
   */
  async _sendRecordingOrNotify() {
    const recordingPath = this._bridge?._browserInstance?.getRecordingPath?.()
    if (!recordingPath) {
      await this._bot.sendMessage(this._chatId, `Job ${this._jobId} completed.`)
      return
    }

    const validation = this._recordingManager.validateRecording(recordingPath)
    if (!validation.ok) {
      await this._bot.sendMessage(this._chatId, `Job ${this._jobId} completed. Recording unavailable.`)
      return
    }

    const sizeCheck = this._recordingManager.checkSizeLimit(recordingPath)
    if (sizeCheck.withinLimit) {
      await this._bot.sendVideo(this._chatId, recordingPath, `Job ${this._jobId} completed`)
    } else {
      const sizeMB = (sizeCheck.sizeBytes / 1024 / 1024).toFixed(1)
      await this._bot.sendMessage(
        this._chatId,
        `Job ${this._jobId} completed. Recording too large to send (${sizeMB} MB > 50 MB limit).`
      )
    }
  }

  /**
   * Clear the periodic status update interval.
   * @private
   */
  _clearStatusInterval() {
    if (this._statusInterval) {
      clearInterval(this._statusInterval)
      this._statusInterval = null
    }
  }
}

module.exports = { RemoteJobController }
