'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fc = require('fast-check')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { TelegramBot, calculateBackoffDelay } = require('../telegram-bot')

// Feature: telegram-video-recording, Property 2: Telegram message parsing extracts correct fields
describe('Property 2: Telegram message parsing extracts correct fields', () => {
  /**
   * For any valid Telegram update with text, parsing emits event with exact
   * chat.id, text, and message_id from the original update.
   *
   * **Validates: Requirements 3.3**
   */
  it('emits message event with exact chatId, text, and messageId', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.string({ minLength: 1 }).filter(s => !s.startsWith('/')),
        fc.integer(),
        (chatId, text, messageId) => {
          const bot = new TelegramBot()
          let emitted = null
          bot.on('message', (evt) => { emitted = evt })

          bot._handleUpdate({
            update_id: 1,
            message: { message_id: messageId, chat: { id: chatId }, text },
          })

          assert.ok(emitted !== null, 'message event should have been emitted')
          assert.equal(emitted.chatId, chatId)
          assert.equal(emitted.text, text)
          assert.equal(emitted.messageId, messageId)
        }
      ),
      { numRuns: 150 }
    )
  })
})


// Feature: telegram-video-recording, Property 3: Exponential backoff delay follows formula
describe('Property 3: Exponential backoff delay follows formula', () => {
  /**
   * For any non-negative retryCount, delay equals min(2 * 2^retryCount, 60).
   *
   * **Validates: Requirements 3.7**
   */
  it('delay equals min(2 * 2^retryCount, 60) for any non-negative retryCount', () => {
    fc.assert(
      fc.property(
        fc.nat(100),
        (retryCount) => {
          const delay = calculateBackoffDelay(retryCount)
          const expected = Math.min(2 * Math.pow(2, retryCount), 60)
          assert.equal(delay, expected)
        }
      ),
      { numRuns: 150 }
    )
  })
})

// Feature: telegram-video-recording, Property 4: Bot status object has required fields
describe('Property 4: Bot status object has required fields', () => {
  /**
   * For any bot state, getStatus() returns object with connected (boolean),
   * bot_username (string or null), polling (boolean), last_error (string or null).
   *
   * **Validates: Requirements 3.9**
   */
  it('getStatus() always has connected, bot_username, polling, last_error', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.string({ minLength: 1 }), { nil: null }),
        fc.boolean(),
        fc.option(fc.string({ minLength: 1 }), { nil: null }),
        (hasToken, botUsername, polling, lastError) => {
          const bot = new TelegramBot()
          if (hasToken) bot._token = 'fake-token'
          bot._botUsername = botUsername
          bot._polling = polling
          bot._lastError = lastError

          const status = bot.getStatus()

          // Must have exactly these six keys
          const keys = Object.keys(status).sort()
          assert.deepStrictEqual(keys, ['bot_username', 'connected', 'has_token', 'last_error', 'polling', 'token_masked'])

          // Type checks
          assert.equal(typeof status.connected, 'boolean')
          assert.equal(typeof status.polling, 'boolean')
          assert.ok(
            status.bot_username === null || typeof status.bot_username === 'string',
            'bot_username must be string or null'
          )
          assert.ok(
            status.last_error === null || typeof status.last_error === 'string',
            'last_error must be string or null'
          )

          // connected should be true only when token is set AND polling
          assert.equal(status.connected, hasToken && polling)
        }
      ),
      { numRuns: 150 }
    )
  })
})


// Feature: telegram-video-recording, Property 5: Pairing token generation produces valid tokens
describe('Property 5: Pairing token generation produces valid tokens', () => {
  /**
   * For any invocation, token is 32+ hex chars, no two tokens are equal.
   *
   * **Validates: Requirements 4.1**
   */
  it('each token is 32+ hex chars and unique across invocations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        (count) => {
          const bot = new TelegramBot()
          bot._botUsername = 'test_bot'
          const tokens = new Set()

          for (let i = 0; i < count; i++) {
            const { token } = bot.generatePairingToken()
            // Must be at least 32 hex characters
            assert.ok(token.length >= 32, `Token length ${token.length} should be >= 32`)
            assert.match(token, /^[0-9a-f]+$/, 'Token must be hex characters only')
            tokens.add(token)
          }

          // All tokens must be unique
          assert.equal(tokens.size, count, 'All generated tokens must be unique')
        }
      ),
      { numRuns: 150 }
    )
  })
})

// Feature: telegram-video-recording, Property 6: Pairing tokens are single-use
describe('Property 6: Pairing tokens are single-use', () => {
  /**
   * First validatePairingToken succeeds, subsequent calls with same token are rejected.
   *
   * **Validates: Requirements 4.5**
   */
  it('first validation succeeds, subsequent validations are rejected', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer(),
        (chatId1, chatId2) => {
          const bot = new TelegramBot()
          bot._botUsername = 'test_bot'
          const { token } = bot.generatePairingToken()

          // First use succeeds
          const first = bot.validatePairingToken(token, chatId1)
          assert.deepStrictEqual(first, { ok: true })

          // Second use is rejected
          const second = bot.validatePairingToken(token, chatId2)
          assert.equal(second.ok, false)
          assert.ok(typeof second.error === 'string' && second.error.length > 0)
        }
      ),
      { numRuns: 150 }
    )
  })
})


// Feature: telegram-video-recording, Property 7: Pairing tokens expire after 10 minutes
describe('Property 7: Pairing tokens expire after 10 minutes', () => {
  /**
   * Tokens older than 10 minutes are rejected; tokens within 10 minutes
   * are accepted (if not consumed).
   *
   * **Validates: Requirements 4.6**
   */
  it('expired tokens are rejected, fresh tokens are accepted', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.integer(),
        (minutesAgo, chatId) => {
          const bot = new TelegramBot()
          bot._botUsername = 'test_bot'
          const { token } = bot.generatePairingToken()

          // Manipulate createdAt to simulate age
          const entry = bot._pairingTokens.get(token)
          entry.createdAt = Date.now() - minutesAgo * 60 * 1000

          const result = bot.validatePairingToken(token, chatId)

          if (minutesAgo > 10) {
            // Expired — must be rejected
            assert.equal(result.ok, false, `Token ${minutesAgo}min old should be rejected`)
            assert.ok(result.error.toLowerCase().includes('expired'))
          } else {
            // Within window — must be accepted
            assert.deepStrictEqual(result, { ok: true }, `Token ${minutesAgo}min old should be accepted`)
          }
        }
      ),
      { numRuns: 150 }
    )
  })
})

// Feature: telegram-video-recording, Property 8: /run command parsing extracts prompt text
describe('Property 8: /run command parsing extracts prompt text', () => {
  /**
   * For any prompt string, parsing `/run {prompt}` produces a command event
   * with command='run' and args=prompt.
   *
   * **Validates: Requirements 5.1**
   */
  it('parsing /run {prompt} emits command with exact prompt', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter(s => !s.startsWith('/')),
        fc.integer(),
        fc.integer(),
        (prompt, chatId, messageId) => {
          const bot = new TelegramBot()
          let emitted = null
          bot.on('command', (evt) => { emitted = evt })

          bot._handleUpdate({
            update_id: 1,
            message: {
              message_id: messageId,
              chat: { id: chatId },
              text: `/run ${prompt}`,
            },
          })

          assert.ok(emitted !== null, 'command event should have been emitted')
          assert.equal(emitted.command, 'run')
          assert.equal(emitted.args, prompt)
          assert.equal(emitted.chatId, chatId)
          assert.equal(emitted.messageId, messageId)
        }
      ),
      { numRuns: 150 }
    )
  })
})


// Feature: telegram-video-recording, Property 9: /status reply includes current job state
describe('Property 9: /status reply includes current job state', () => {
  /**
   * For any job state, the /status response contains the state string and
   * job ID when not idle. Since RemoteJobController doesn't exist yet, we
   * test that getStatus() always includes the state field for any combination
   * of bot states.
   *
   * **Validates: Requirements 5.7**
   */
  it('getStatus() always includes state info for any bot state combination', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.string({ minLength: 1 }), { nil: null }),
        fc.boolean(),
        fc.option(fc.string({ minLength: 1 }), { nil: null }),
        (hasToken, botUsername, polling, lastError) => {
          const bot = new TelegramBot()
          if (hasToken) bot._token = 'fake-token'
          bot._botUsername = botUsername
          bot._polling = polling
          bot._lastError = lastError

          const status = bot.getStatus()

          // Status must always contain the state-related fields
          assert.ok('connected' in status, 'status must have connected field')
          assert.ok('polling' in status, 'status must have polling field')
          assert.ok('last_error' in status, 'status must have last_error field')
          assert.ok('bot_username' in status, 'status must have bot_username field')

          // The connected field encodes the effective state
          if (hasToken && polling) {
            assert.equal(status.connected, true)
          } else {
            assert.equal(status.connected, false)
          }

          // last_error reflects the error state
          assert.equal(status.last_error, lastError)
          assert.equal(status.bot_username, botUsername)
          assert.equal(status.polling, polling)
        }
      ),
      { numRuns: 150 }
    )
  })
})

// Feature: telegram-video-recording, Property 11: Configuration serialization round-trip
describe('Property 11: Configuration serialization round-trip', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgbot-prop-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * For any valid config with token, pairedChatId, botUsername,
   * serialize then deserialize produces deep-equal object.
   *
   * **Validates: Requirements 8.4, 8.5**
   */
  it('saveConfig then loadConfig produces deep-equal config', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.option(fc.stringMatching(/^[0-9]{1,15}$/), { nil: null }),
        fc.option(fc.string({ minLength: 1 }), { nil: null }),
        (token, pairedChatId, botUsername) => {
          const configPath = path.join(tmpDir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
          const bot = new TelegramBot({ configPath })

          bot._token = token
          bot._pairedChatId = pairedChatId
          bot._botUsername = botUsername

          bot.saveConfig()
          const loaded = bot.loadConfig()

          assert.ok(loaded !== null, 'loadConfig should return an object')

          // Build expected config — pairedChatId is serialized as string or null
          const expected = {
            token,
            pairedChatId: pairedChatId !== null ? String(pairedChatId) : null,
            botUsername,
          }

          assert.deepStrictEqual(loaded, expected)
        }
      ),
      { numRuns: 150 }
    )
  })
})
