'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const { TelegramBot } = require('../telegram-bot')
const { RecordingManager } = require('../recording-manager')
const { RemoteJobController } = require('../remote-job-controller')

// --- Helpers ---

function createTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-integration-'))
}

function createMockBot() {
  const bot = new EventEmitter()
  bot._sent = []
  bot._photos = []
  bot._videos = []
  bot.sendMessage = async (chatId, text) => {
    bot._sent.push({ chatId, text })
    return { ok: true }
  }
  bot.sendPhoto = async (chatId, filePath, caption) => {
    bot._photos.push({ chatId, filePath, caption })
    return { ok: true }
  }
  bot.sendVideo = async (chatId, filePath, caption) => {
    bot._videos.push({ chatId, filePath, caption })
    return { ok: true }
  }
  bot.on = bot.on.bind(bot)
  bot.removeListener = bot.removeListener.bind(bot)
  return bot
}

// ── 1. Bot start/stop lifecycle ──────────────────────────────────────────────

describe('Integration: Bot start/stop lifecycle', () => {
  let tmpDir, configPath, bot

  beforeEach(() => {
    tmpDir = createTmpDir()
    configPath = path.join(tmpDir, 'bot-config.json')
    bot = new TelegramBot({ configPath })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('shows disconnected status before start', () => {
    const status = bot.getStatus()
    assert.equal(status.connected, false)
    assert.equal(status.bot_username, null)
    assert.equal(status.polling, false)
    assert.equal(status.last_error, null)
  })

  it('shows connected status after simulated start', () => {
    // Simulate a successful start by setting internal state
    bot._token = 'fake:token'
    bot._botUsername = 'integration_bot'
    bot._polling = true

    const status = bot.getStatus()
    assert.equal(status.connected, true)
    assert.equal(status.bot_username, 'integration_bot')
    assert.equal(status.polling, true)
  })

  it('shows disconnected status after stop', async () => {
    bot._token = 'fake:token'
    bot._botUsername = 'integration_bot'
    bot._polling = true

    await bot.stop()

    const status = bot.getStatus()
    assert.equal(status.connected, false)
    assert.equal(status.polling, false)
    // bot_username is retained after stop (token stays set)
    assert.equal(status.bot_username, 'integration_bot')
  })

  it('stop is idempotent — multiple calls do not throw', async () => {
    bot._polling = true
    await bot.stop()
    await bot.stop()
    assert.equal(bot.getStatus().polling, false)
  })

  it('last_error is preserved across status checks', () => {
    bot._lastError = 'Connection refused'
    assert.equal(bot.getStatus().last_error, 'Connection refused')
  })
})


// ── 2. QR pairing end-to-end flow ───────────────────────────────────────────

describe('Integration: QR pairing end-to-end flow', () => {
  let tmpDir, configPath, bot

  beforeEach(() => {
    tmpDir = createTmpDir()
    configPath = path.join(tmpDir, 'bot-config.json')
    bot = new TelegramBot({ configPath })
    bot._botUsername = 'pairing_test_bot'
    bot._token = 'fake:token'
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('full pairing flow: generate token → /start {token} → paired event → config saved', (t, done) => {
    const { token } = bot.generatePairingToken()
    const chatId = 777888

    bot.on('paired', (evt) => {
      // Verify paired event carries the correct chatId
      assert.equal(evt.chatId, chatId)

      // Verify getPairedChatId returns the paired chat
      assert.equal(bot.getPairedChatId(), chatId)

      // Verify config was persisted to disk
      assert.ok(fs.existsSync(configPath))
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      assert.equal(saved.pairedChatId, String(chatId))
      assert.equal(saved.botUsername, 'pairing_test_bot')
      assert.equal(saved.token, 'fake:token')

      done()
    })

    // Simulate receiving /start {token} from Telegram
    bot._handleUpdate({
      update_id: 100,
      message: {
        message_id: 1,
        chat: { id: chatId },
        text: `/start ${token}`,
      },
    })
  })

  it('rejects expired token during pairing', () => {
    const { token } = bot.generatePairingToken()
    // Expire the token
    const entry = bot._pairingTokens.get(token)
    entry.createdAt = Date.now() - 11 * 60 * 1000

    let paired = false
    bot.on('paired', () => { paired = true })

    bot._handleUpdate({
      update_id: 101,
      message: {
        message_id: 2,
        chat: { id: 999 },
        text: `/start ${token}`,
      },
    })

    assert.equal(paired, false)
    assert.equal(bot.getPairedChatId(), null)
  })

  it('rejects consumed token on second pairing attempt', () => {
    const { token } = bot.generatePairingToken()

    // First pairing succeeds
    bot._handleUpdate({
      update_id: 102,
      message: { message_id: 3, chat: { id: 111 }, text: `/start ${token}` },
    })
    assert.equal(bot.getPairedChatId(), 111)

    // Second attempt with same token should not change the paired chat
    let pairedAgain = false
    bot.on('paired', () => { pairedAgain = true })

    bot._handleUpdate({
      update_id: 103,
      message: { message_id: 4, chat: { id: 222 }, text: `/start ${token}` },
    })

    // pairedChatId should still be 111 (first pairing)
    assert.equal(bot.getPairedChatId(), 111)
    assert.equal(pairedAgain, false)
  })

  it('multiple independent tokens can pair different chats sequentially', () => {
    const { token: token1 } = bot.generatePairingToken()
    bot._handleUpdate({
      update_id: 104,
      message: { message_id: 5, chat: { id: 1001 }, text: `/start ${token1}` },
    })
    assert.equal(bot.getPairedChatId(), 1001)

    const { token: token2 } = bot.generatePairingToken()
    bot._handleUpdate({
      update_id: 105,
      message: { message_id: 6, chat: { id: 2002 }, text: `/start ${token2}` },
    })
    assert.equal(bot.getPairedChatId(), 2002)
  })
})


// ── 3. Remote job dispatch with mocked DirectBridge ─────────────────────────

describe('Integration: Remote job dispatch', () => {
  let mockBot, rm, tmpDir, controller

  beforeEach(() => {
    tmpDir = createTmpDir()
    mockBot = createMockBot()
    rm = new RecordingManager({ baseDir: path.join(tmpDir, 'recordings') })
    controller = new RemoteJobController({
      telegramBot: mockBot,
      chatId: 42,
      recordingManager: rm,
    })
  })

  afterEach(() => {
    controller._clearStatusInterval()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('/run with empty args sends usage message', async () => {
    await controller.handleCommand('run', '')
    assert.equal(mockBot._sent.length, 1)
    assert.ok(mockBot._sent[0].text.includes('Usage: /run'))
    assert.equal(mockBot._sent[0].chatId, 42)
  })

  it('/status when idle reports idle', async () => {
    await controller.handleCommand('status', '')
    assert.equal(mockBot._sent.length, 1)
    assert.ok(mockBot._sent[0].text.toLowerCase().includes('idle'))
  })

  it('/status when running reports running with job ID', async () => {
    controller._state = 'running'
    controller._jobId = 'job_integration_1'
    await controller.handleCommand('status', '')
    assert.ok(mockBot._sent[0].text.includes('running'))
    assert.ok(mockBot._sent[0].text.includes('job_integration_1'))
  })

  it('/stop with mock bridge stops the job', async () => {
    let interrupted = false
    controller._state = 'running'
    controller._jobId = 'job_integration_2'
    controller._bridge = { interrupt: async () => { interrupted = true } }

    await controller.handleCommand('stop', '')

    assert.equal(interrupted, true)
    assert.equal(controller.getJobState(), 'idle')
    assert.ok(mockBot._sent[0].text.includes('stopped'))
    assert.ok(mockBot._sent[0].text.includes('job_integration_2'))
  })

  it('/stop when idle reports no job running', async () => {
    await controller.handleCommand('stop', '')
    assert.ok(mockBot._sent[0].text.includes('No job is currently running'))
  })

  it('runJob rejects when already running', async () => {
    controller._state = 'running'
    await controller.runJob('test prompt')
    assert.ok(mockBot._sent[0].text.includes('already running'))
  })

  it('/screenshot when not running reports no browser session', async () => {
    await controller.handleCommand('screenshot', '')
    assert.ok(mockBot._sent[0].text.includes('No browser session'))
  })

  it('unknown command sends error message', async () => {
    await controller.handleCommand('unknown', '')
    assert.ok(mockBot._sent[0].text.includes('Unknown command'))
  })

  it('recording manager creates job directory via getRecordingDir', () => {
    const dir = rm.getRecordingDir('job_test_dir')
    assert.ok(fs.existsSync(dir))
    assert.ok(dir.includes('job_test_dir'))
  })
})


// ── 4. Config persistence to/from disk ──────────────────────────────────────

describe('Integration: Config persistence', () => {
  let tmpDir, configPath

  beforeEach(() => {
    tmpDir = createTmpDir()
    configPath = path.join(tmpDir, 'telegram-bot-config.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('saves and loads config across separate TelegramBot instances', () => {
    // Instance 1: set state and save
    const bot1 = new TelegramBot({ configPath })
    bot1._token = 'my-secret-token'
    bot1._pairedChatId = 123456789
    bot1._botUsername = 'persist_bot'
    bot1.saveConfig()

    // Instance 2: load from same path
    const bot2 = new TelegramBot({ configPath })
    const config = bot2.loadConfig()

    assert.equal(config.token, 'my-secret-token')
    assert.equal(config.pairedChatId, '123456789')
    assert.equal(config.botUsername, 'persist_bot')
  })

  it('handles null pairedChatId in round-trip', () => {
    const bot1 = new TelegramBot({ configPath })
    bot1._token = 'token-no-pair'
    bot1._pairedChatId = null
    bot1._botUsername = 'unpaired_bot'
    bot1.saveConfig()

    const bot2 = new TelegramBot({ configPath })
    const config = bot2.loadConfig()

    assert.equal(config.token, 'token-no-pair')
    assert.equal(config.pairedChatId, null)
    assert.equal(config.botUsername, 'unpaired_bot')
  })

  it('handles null botUsername in round-trip', () => {
    const bot1 = new TelegramBot({ configPath })
    bot1._token = 'token-no-username'
    bot1._pairedChatId = 555
    bot1._botUsername = null
    bot1.saveConfig()

    const bot2 = new TelegramBot({ configPath })
    const config = bot2.loadConfig()

    assert.equal(config.token, 'token-no-username')
    assert.equal(config.pairedChatId, '555')
    assert.equal(config.botUsername, null)
  })

  it('loadConfig returns null for missing file', () => {
    const bot = new TelegramBot({ configPath: path.join(tmpDir, 'nonexistent.json') })
    assert.equal(bot.loadConfig(), null)
  })

  it('loadConfig returns null for corrupted JSON', () => {
    fs.writeFileSync(configPath, '{broken json!!!', 'utf8')
    const bot = new TelegramBot({ configPath })
    assert.equal(bot.loadConfig(), null)
  })

  it('saveConfig creates nested directories if needed', () => {
    const deepPath = path.join(tmpDir, 'a', 'b', 'c', 'config.json')
    const bot = new TelegramBot({ configPath: deepPath })
    bot._token = 'deep-token'
    bot.saveConfig()

    assert.ok(fs.existsSync(deepPath))
    const data = JSON.parse(fs.readFileSync(deepPath, 'utf8'))
    assert.equal(data.token, 'deep-token')
  })

  it('config file is valid JSON with expected keys', () => {
    const bot = new TelegramBot({ configPath })
    bot._token = 'json-check'
    bot._pairedChatId = 42
    bot._botUsername = 'json_bot'
    bot.saveConfig()

    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    assert.ok('token' in parsed)
    assert.ok('pairedChatId' in parsed)
    assert.ok('botUsername' in parsed)
    assert.equal(Object.keys(parsed).length, 3)
  })

  it('pairing triggers config save that survives reload', () => {
    const bot = new TelegramBot({ configPath })
    bot._token = 'pair-persist-token'
    bot._botUsername = 'pair_persist_bot'

    // Generate token and simulate pairing
    const { token } = bot.generatePairingToken()
    bot._handleUpdate({
      update_id: 200,
      message: { message_id: 10, chat: { id: 99887 }, text: `/start ${token}` },
    })

    // Verify config was saved with the paired chatId
    const bot2 = new TelegramBot({ configPath })
    const config = bot2.loadConfig()
    assert.equal(config.pairedChatId, '99887')
    assert.equal(config.botUsername, 'pair_persist_bot')
  })
})
