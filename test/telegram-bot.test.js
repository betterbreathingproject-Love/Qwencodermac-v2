'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { TelegramBot, calculateBackoffDelay } = require('../telegram-bot')

describe('calculateBackoffDelay', () => {
  it('returns 2 for retryCount 0', () => {
    assert.equal(calculateBackoffDelay(0), 2)
  })

  it('returns 4 for retryCount 1', () => {
    assert.equal(calculateBackoffDelay(1), 4)
  })

  it('returns 8 for retryCount 2', () => {
    assert.equal(calculateBackoffDelay(2), 8)
  })

  it('returns 16 for retryCount 3', () => {
    assert.equal(calculateBackoffDelay(3), 16)
  })

  it('returns 32 for retryCount 4', () => {
    assert.equal(calculateBackoffDelay(4), 32)
  })

  it('caps at 60 for retryCount 5', () => {
    assert.equal(calculateBackoffDelay(5), 60)
  })

  it('stays capped at 60 for retryCount 6–15', () => {
    for (let i = 6; i <= 15; i++) {
      assert.equal(calculateBackoffDelay(i), 60, `retryCount ${i} should be 60`)
    }
  })

  it('follows formula min(2 * 2^n, 60) for all 0–15', () => {
    for (let n = 0; n <= 15; n++) {
      const expected = Math.min(2 * Math.pow(2, n), 60)
      assert.equal(calculateBackoffDelay(n), expected, `retryCount ${n}`)
    }
  })
})

describe('TelegramBot._handleUpdate', () => {
  let bot

  beforeEach(() => {
    bot = new TelegramBot()
  })

  it('emits "message" for plain text messages', (t, done) => {
    bot.on('message', (evt) => {
      assert.equal(evt.chatId, 111)
      assert.equal(evt.text, 'hello world')
      assert.equal(evt.messageId, 42)
      done()
    })
    bot._handleUpdate({
      update_id: 1,
      message: { message_id: 42, chat: { id: 111 }, text: 'hello world' },
    })
  })

  it('emits "command" for /run with args', (t, done) => {
    bot.on('command', (evt) => {
      assert.equal(evt.chatId, 222)
      assert.equal(evt.command, 'run')
      assert.equal(evt.args, 'navigate to example.com')
      assert.equal(evt.messageId, 43)
      done()
    })
    bot._handleUpdate({
      update_id: 2,
      message: { message_id: 43, chat: { id: 222 }, text: '/run navigate to example.com' },
    })
  })

  it('emits "command" for /status with empty args', (t, done) => {
    bot.on('command', (evt) => {
      assert.equal(evt.command, 'status')
      assert.equal(evt.args, '')
      done()
    })
    bot._handleUpdate({
      update_id: 3,
      message: { message_id: 44, chat: { id: 333 }, text: '/status' },
    })
  })

  it('emits "command" for /stop with empty args', (t, done) => {
    bot.on('command', (evt) => {
      assert.equal(evt.command, 'stop')
      assert.equal(evt.args, '')
      done()
    })
    bot._handleUpdate({
      update_id: 4,
      message: { message_id: 45, chat: { id: 444 }, text: '/stop' },
    })
  })

  it('emits "photo" for photo messages with largest file_id', (t, done) => {
    bot.on('photo', (evt) => {
      assert.equal(evt.chatId, 555)
      assert.equal(evt.fileId, 'large_file_id')
      assert.equal(evt.caption, 'my photo')
      assert.equal(evt.messageId, 46)
      done()
    })
    bot._handleUpdate({
      update_id: 5,
      message: {
        message_id: 46,
        chat: { id: 555 },
        photo: [
          { file_id: 'small_file_id', width: 90, height: 90 },
          { file_id: 'large_file_id', width: 800, height: 600 },
        ],
        caption: 'my photo',
      },
    })
  })

  it('emits "photo" with empty caption when none provided', (t, done) => {
    bot.on('photo', (evt) => {
      assert.equal(evt.caption, '')
      done()
    })
    bot._handleUpdate({
      update_id: 6,
      message: {
        message_id: 47,
        chat: { id: 666 },
        photo: [{ file_id: 'only_file', width: 100, height: 100 }],
      },
    })
  })

  it('does nothing for updates without message', () => {
    // Should not throw or emit anything
    let emitted = false
    bot.on('message', () => { emitted = true })
    bot.on('command', () => { emitted = true })
    bot.on('photo', () => { emitted = true })
    bot._handleUpdate({ update_id: 7 })
    assert.equal(emitted, false)
  })
})

describe('TelegramBot.getStatus', () => {
  it('returns correct shape before start', () => {
    const bot = new TelegramBot()
    const status = bot.getStatus()
    assert.equal(typeof status.connected, 'boolean')
    assert.equal(status.connected, false)
    assert.equal(status.bot_username, null)
    assert.equal(typeof status.polling, 'boolean')
    assert.equal(status.polling, false)
    assert.equal(status.last_error, null)
  })

  it('returns connected=true when token and polling are set', () => {
    const bot = new TelegramBot()
    bot._token = 'fake-token'
    bot._polling = true
    bot._botUsername = 'test_bot'
    const status = bot.getStatus()
    assert.equal(status.connected, true)
    assert.equal(status.bot_username, 'test_bot')
    assert.equal(status.polling, true)
    assert.equal(status.last_error, null)
  })

  it('returns connected=false when polling is false even with token', () => {
    const bot = new TelegramBot()
    bot._token = 'fake-token'
    bot._polling = false
    const status = bot.getStatus()
    assert.equal(status.connected, false)
  })

  it('includes last_error when set', () => {
    const bot = new TelegramBot()
    bot._lastError = 'Network timeout'
    const status = bot.getStatus()
    assert.equal(status.last_error, 'Network timeout')
  })

  it('always has exactly the four required keys', () => {
    const bot = new TelegramBot()
    const status = bot.getStatus()
    const keys = Object.keys(status).sort()
    assert.deepStrictEqual(keys, ['bot_username', 'connected', 'last_error', 'polling'])
  })
})

describe('TelegramBot.generatePairingToken', () => {
  it('produces a token of at least 32 hex characters', () => {
    const bot = new TelegramBot()
    bot._botUsername = 'test_bot'
    const result = bot.generatePairingToken()
    assert.ok(result.token.length >= 32)
    assert.match(result.token, /^[0-9a-f]+$/)
  })

  it('returns qrDataUrl containing the bot username and token', () => {
    const bot = new TelegramBot()
    bot._botUsername = 'my_bot'
    const result = bot.generatePairingToken()
    assert.ok(result.qrDataUrl.includes('my_bot'))
    assert.ok(result.qrDataUrl.includes(result.token))
    assert.ok(result.qrDataUrl.startsWith('https://t.me/'))
  })

  it('returns expiresAt in the future', () => {
    const bot = new TelegramBot()
    bot._botUsername = 'test_bot'
    const before = Date.now()
    const result = bot.generatePairingToken()
    assert.ok(result.expiresAt > before)
    // Should be ~10 minutes from now
    assert.ok(result.expiresAt <= before + 10 * 60 * 1000 + 100)
  })

  it('produces unique tokens on successive calls', () => {
    const bot = new TelegramBot()
    bot._botUsername = 'test_bot'
    const tokens = new Set()
    for (let i = 0; i < 20; i++) {
      tokens.add(bot.generatePairingToken().token)
    }
    assert.equal(tokens.size, 20)
  })
})

describe('TelegramBot.validatePairingToken', () => {
  let bot

  beforeEach(() => {
    bot = new TelegramBot()
    bot._botUsername = 'test_bot'
  })

  it('accepts a valid, fresh token', () => {
    const { token } = bot.generatePairingToken()
    const result = bot.validatePairingToken(token, 12345)
    assert.deepStrictEqual(result, { ok: true })
    assert.equal(bot.getPairedChatId(), 12345)
  })

  it('rejects a consumed token on second use', () => {
    const { token } = bot.generatePairingToken()
    bot.validatePairingToken(token, 12345)
    const result = bot.validatePairingToken(token, 67890)
    assert.equal(result.ok, false)
    assert.ok(result.error.toLowerCase().includes('used'))
  })

  it('rejects an unknown token', () => {
    const result = bot.validatePairingToken('nonexistent_token', 12345)
    assert.equal(result.ok, false)
    assert.ok(result.error.toLowerCase().includes('invalid'))
  })

  it('rejects an expired token', () => {
    const { token } = bot.generatePairingToken()
    // Manually set createdAt to 11 minutes ago
    const entry = bot._pairingTokens.get(token)
    entry.createdAt = Date.now() - 11 * 60 * 1000
    const result = bot.validatePairingToken(token, 12345)
    assert.equal(result.ok, false)
    assert.ok(result.error.toLowerCase().includes('expired'))
  })

  it('accepts a token just under 10 minutes old', () => {
    const { token } = bot.generatePairingToken()
    const entry = bot._pairingTokens.get(token)
    entry.createdAt = Date.now() - 9 * 60 * 1000
    const result = bot.validatePairingToken(token, 99999)
    assert.deepStrictEqual(result, { ok: true })
  })
})

describe('Command parsing via _handleUpdate', () => {
  let bot
  let commands

  beforeEach(() => {
    bot = new TelegramBot()
    commands = []
    bot.on('command', (evt) => commands.push(evt))
  })

  it('parses /run with prompt text', () => {
    bot._handleUpdate({
      update_id: 10,
      message: { message_id: 1, chat: { id: 100 }, text: '/run open google.com and search' },
    })
    assert.equal(commands.length, 1)
    assert.equal(commands[0].command, 'run')
    assert.equal(commands[0].args, 'open google.com and search')
  })

  it('parses /status with no args', () => {
    bot._handleUpdate({
      update_id: 11,
      message: { message_id: 2, chat: { id: 100 }, text: '/status' },
    })
    assert.equal(commands.length, 1)
    assert.equal(commands[0].command, 'status')
    assert.equal(commands[0].args, '')
  })

  it('parses /stop with no args', () => {
    bot._handleUpdate({
      update_id: 12,
      message: { message_id: 3, chat: { id: 100 }, text: '/stop' },
    })
    assert.equal(commands.length, 1)
    assert.equal(commands[0].command, 'stop')
    assert.equal(commands[0].args, '')
  })

  it('parses /run with multi-word prompt preserving spaces', () => {
    bot._handleUpdate({
      update_id: 13,
      message: { message_id: 4, chat: { id: 100 }, text: '/run   multiple   spaces   here' },
    })
    assert.equal(commands[0].command, 'run')
    assert.equal(commands[0].args, '  multiple   spaces   here')
  })
})

describe('TelegramBot.saveConfig / loadConfig', () => {
  let tmpDir
  let configPath

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgbot-test-'))
    configPath = path.join(tmpDir, 'telegram-bot-config.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('round-trips config to disk', () => {
    const bot = new TelegramBot({ configPath })
    bot._token = 'test-token-123'
    bot._pairedChatId = 987654
    bot._botUsername = 'my_test_bot'
    bot.saveConfig()

    const loaded = bot.loadConfig()
    assert.equal(loaded.token, 'test-token-123')
    assert.equal(loaded.pairedChatId, '987654')
    assert.equal(loaded.botUsername, 'my_test_bot')
  })

  it('creates config directory if it does not exist', () => {
    const deepPath = path.join(tmpDir, 'a', 'b', 'config.json')
    const bot = new TelegramBot({ configPath: deepPath })
    bot._token = 'tok'
    bot.saveConfig()
    assert.ok(fs.existsSync(deepPath))
  })

  it('loadConfig returns null when file does not exist', () => {
    const bot = new TelegramBot({ configPath: path.join(tmpDir, 'missing.json') })
    assert.equal(bot.loadConfig(), null)
  })

  it('loadConfig returns null for corrupted file', () => {
    fs.writeFileSync(configPath, 'not valid json{{{', 'utf8')
    const bot = new TelegramBot({ configPath })
    assert.equal(bot.loadConfig(), null)
  })

  it('loadConfig returns null when no configPath is set', () => {
    const bot = new TelegramBot()
    assert.equal(bot.loadConfig(), null)
  })

  it('saveConfig is a no-op when no configPath is set', () => {
    const bot = new TelegramBot()
    // Should not throw
    bot.saveConfig()
  })

  it('persists pairedChatId as string for JSON safety', () => {
    const bot = new TelegramBot({ configPath })
    bot._token = 'tok'
    bot._pairedChatId = 123456789
    bot.saveConfig()

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.equal(typeof raw.pairedChatId, 'string')
    assert.equal(raw.pairedChatId, '123456789')
  })

  it('persists null pairedChatId as null', () => {
    const bot = new TelegramBot({ configPath })
    bot._token = 'tok'
    bot._pairedChatId = null
    bot.saveConfig()

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.equal(raw.pairedChatId, null)
  })
})

describe('TelegramBot.start() with invalid token', () => {
  it('rejects when getMe fails (network error)', async () => {
    const bot = new TelegramBot()
    // Using a clearly invalid token will cause the HTTPS request to fail
    // since we can't mock node:https easily, we test with a malformed token
    // that will cause a network-level or API-level error
    await assert.rejects(
      () => bot.start('invalid:token'),
      (err) => {
        assert.ok(err instanceof Error)
        return true
      }
    )
    // Bot should not be in polling state after failed start
    assert.equal(bot._polling, false)
    assert.equal(bot._token, null)
  })
})

describe('TelegramBot.stop()', () => {
  it('sets polling to false', async () => {
    const bot = new TelegramBot()
    bot._polling = true
    await bot.stop()
    assert.equal(bot._polling, false)
  })

  it('returns a resolved promise', async () => {
    const bot = new TelegramBot()
    const result = await bot.stop()
    assert.equal(result, undefined)
  })

  it('is idempotent — calling stop twice does not throw', async () => {
    const bot = new TelegramBot()
    bot._polling = true
    await bot.stop()
    await bot.stop()
    assert.equal(bot._polling, false)
  })
})
