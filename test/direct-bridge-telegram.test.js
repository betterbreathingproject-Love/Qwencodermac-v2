'use strict'

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { InputRequester } = require('../direct-bridge')
const { RemoteJobController } = require('../remote-job-controller')

// --- Mock factories ---

function createMockBot() {
  const bot = new EventEmitter()
  bot._sent = []
  bot._photos = []
  bot.sendMessage = async (chatId, text) => {
    bot._sent.push({ chatId, text })
    return { ok: true }
  }
  bot.sendPhoto = async (chatId, filePath, caption) => {
    bot._photos.push({ chatId, filePath, caption })
    return { ok: true }
  }
  bot.sendVideo = async (chatId, filePath, caption) => {
    return { ok: true }
  }
  return bot
}

function createMockRecordingManager() {
  return {
    getRecordingDir(jobId) { return `/tmp/recordings/${jobId}/` },
    validateRecording() { return { ok: true, sizeBytes: 1024 } },
    checkSizeLimit() { return { withinLimit: true, sizeBytes: 1024 } },
  }
}

// ── InputRequester tests ─────────────────────────────────────────────────────

describe('InputRequester', () => {
  let bot

  beforeEach(() => {
    bot = createMockBot()
  })

  describe('ask()', () => {
    it('sends question via bot.sendMessage with the question text', async () => {
      const chatId = 42
      const requester = new InputRequester(bot, chatId)
      const promise = requester.ask('What color?')
      // Let sendMessage resolve
      await new Promise(r => setTimeout(r, 0))

      assert.equal(bot._sent.length, 1)
      assert.equal(bot._sent[0].chatId, chatId)
      assert.ok(bot._sent[0].text.includes('What color?'))

      // Resolve the promise so the test doesn't hang
      bot.emit('message', { chatId, text: 'Blue' })
      await promise
    })

    it('resolves with reply text when bot emits message with matching chatId', async () => {
      const chatId = 100
      const requester = new InputRequester(bot, chatId)
      const promise = requester.ask('Your name?')
      await new Promise(r => setTimeout(r, 0))

      bot.emit('message', { chatId, text: 'Alice' })
      const result = await promise
      assert.equal(result, 'Alice')
    })

    it('ignores messages from different chatIds', async () => {
      const chatId = 200
      const requester = new InputRequester(bot, chatId)
      const promise = requester.ask('Pick a number')
      await new Promise(r => setTimeout(r, 0))

      // Emit from a different chatId — should be ignored
      bot.emit('message', { chatId: 999, text: 'wrong chat' })

      // Verify still pending
      assert.equal(requester.hasPendingRequest(), true)

      // Now emit from the correct chatId
      bot.emit('message', { chatId, text: '42' })
      const result = await promise
      assert.equal(result, '42')
    })
  })

  describe('hasPendingRequest()', () => {
    it('returns false initially', () => {
      const requester = new InputRequester(bot, 1)
      assert.equal(requester.hasPendingRequest(), false)
    })

    it('returns true while waiting for reply', async () => {
      const chatId = 300
      const requester = new InputRequester(bot, chatId)
      const promise = requester.ask('Waiting?')
      await new Promise(r => setTimeout(r, 0))

      assert.equal(requester.hasPendingRequest(), true)

      // Clean up
      bot.emit('message', { chatId, text: 'done' })
      await promise
    })

    it('returns false after reply received', async () => {
      const chatId = 400
      const requester = new InputRequester(bot, chatId)
      const promise = requester.ask('Ready?')
      await new Promise(r => setTimeout(r, 0))

      bot.emit('message', { chatId, text: 'yes' })
      await promise

      assert.equal(requester.hasPendingRequest(), false)
    })
  })

  describe('timeout', () => {
    it('resolves with timeout message after 5 minutes', async () => {
      // Replace global setTimeout with a version that captures the callback
      // so we can fire it immediately to simulate the 5-minute timeout
      let timeoutCb = null
      const origSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = (cb, ms) => {
        if (ms === 5 * 60 * 1000) {
          timeoutCb = cb
          return 999 // fake timer id
        }
        return origSetTimeout(cb, ms)
      }
      const origClearTimeout = globalThis.clearTimeout
      globalThis.clearTimeout = (id) => {
        if (id === 999) return
        origClearTimeout(id)
      }

      try {
        const chatId = 500
        const requester = new InputRequester(bot, chatId)
        const promise = requester.ask('Are you there?')

        // Let sendMessage resolve
        await new Promise(r => origSetTimeout(r, 0))

        // Fire the captured timeout callback
        assert.ok(timeoutCb, 'timeout callback should have been captured')
        timeoutCb()

        const result = await promise
        assert.ok(result.includes('No response received within 5 minutes'))
        assert.equal(requester.hasPendingRequest(), false)
      } finally {
        globalThis.setTimeout = origSetTimeout
        globalThis.clearTimeout = origClearTimeout
      }
    })
  })
})

// ── RemoteJobController — additional targeted tests ──────────────────────────

describe('RemoteJobController — command dispatch', () => {
  let bot, rm, controller

  beforeEach(() => {
    bot = createMockBot()
    rm = createMockRecordingManager()
    controller = new RemoteJobController({ telegramBot: bot, chatId: 123, recordingManager: rm })
  })

  describe('handleCommand dispatches /run, /status, /stop', () => {
    it('/run with empty args sends usage message', async () => {
      await controller.handleCommand('run', '')
      assert.equal(bot._sent.length, 1)
      assert.ok(bot._sent[0].text.includes('Usage: /run'))
    })

    it('/status when idle reports idle', async () => {
      await controller.handleCommand('status', '')
      assert.equal(bot._sent.length, 1)
      assert.ok(bot._sent[0].text.includes('idle'))
    })

    it('/status when running reports running with job ID', async () => {
      controller._state = 'running'
      controller._jobId = 'job_abc'
      await controller.handleCommand('status', '')
      assert.equal(bot._sent.length, 1)
      assert.ok(bot._sent[0].text.includes('running'))
      assert.ok(bot._sent[0].text.includes('job_abc'))
    })

    it('/stop when not running reports no job', async () => {
      await controller.handleCommand('stop', '')
      assert.equal(bot._sent.length, 1)
      assert.ok(bot._sent[0].text.includes('No job is currently running'))
    })

    it('/stop when running calls bridge.interrupt and sets idle', async () => {
      let interrupted = false
      controller._state = 'running'
      controller._jobId = 'job_xyz'
      controller._bridge = { interrupt: async () => { interrupted = true } }

      await controller.handleCommand('stop', '')
      assert.equal(interrupted, true)
      assert.equal(controller.getJobState(), 'idle')
      assert.ok(bot._sent[0].text.includes('stopped'))
    })
  })

  describe('/run rejected while input request pending', () => {
    it('rejects /run when InputRequester has a pending request', async () => {
      controller._inputRequester = { hasPendingRequest: () => true }
      await controller.handleCommand('run', 'do something')
      assert.equal(bot._sent.length, 1)
      assert.ok(bot._sent[0].text.includes('waiting for your reply'))
    })
  })

  describe('screenshot forwarding', () => {
    it('extracts base64 from screenshot result and calls sendPhoto', async () => {
      // Simulate a running job with a browser instance that returns a base64 screenshot
      controller._state = 'running'
      controller._jobId = 'job_ss'

      // Minimal base64 PNG (1x1 pixel)
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      const screenshotResult = `data:image/png;base64,${b64}`

      controller._bridge = {
        _browserInstance: {
          execute: async () => ({ result: screenshotResult }),
        },
      }

      await controller.handleCommand('screenshot', '')

      assert.equal(bot._photos.length, 1)
      assert.equal(bot._photos[0].chatId, 123)
      assert.ok(bot._photos[0].caption.includes('screenshot'))
    })
  })
})
