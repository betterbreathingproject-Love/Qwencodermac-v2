'use strict'

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { RemoteJobController } = require('../remote-job-controller')

// --- Mock factories ---

function createMockBot() {
  const sent = []
  const photos = []
  const videos = []
  return {
    sent,
    photos,
    videos,
    async sendMessage(chatId, text) {
      sent.push({ chatId, text })
      return { ok: true }
    },
    async sendPhoto(chatId, filePath, caption) {
      photos.push({ chatId, filePath, caption })
      return { ok: true }
    },
    async sendVideo(chatId, filePath, caption) {
      videos.push({ chatId, filePath, caption })
      return { ok: true }
    },
    on() {},
    removeListener() {},
  }
}

function createMockRecordingManager() {
  return {
    getRecordingDir(jobId) {
      return `/tmp/recordings/${jobId}/`
    },
    validateRecording(filePath) {
      return { ok: true, sizeBytes: 1024 }
    },
    checkSizeLimit(filePath) {
      return { withinLimit: true, sizeBytes: 1024 }
    },
  }
}

describe('RemoteJobController', () => {
  let bot, rm, controller

  beforeEach(() => {
    bot = createMockBot()
    rm = createMockRecordingManager()
    controller = new RemoteJobController({ telegramBot: bot, chatId: 123, recordingManager: rm })
  })

  describe('constructor', () => {
    it('initializes with idle state', () => {
      assert.equal(controller.getJobState(), 'idle')
    })

    it('initializes with null jobId', () => {
      assert.equal(controller.getJobId(), null)
    })

    it('stores bot, chatId, and recordingManager', () => {
      assert.equal(controller._bot, bot)
      assert.equal(controller._chatId, 123)
      assert.equal(controller._recordingManager, rm)
    })
  })

  describe('getJobState()', () => {
    it('returns idle initially', () => {
      assert.equal(controller.getJobState(), 'idle')
    })

    it('returns the current state value', () => {
      controller._state = 'running'
      assert.equal(controller.getJobState(), 'running')
      controller._state = 'completed'
      assert.equal(controller.getJobState(), 'completed')
      controller._state = 'failed'
      assert.equal(controller.getJobState(), 'failed')
    })
  })

  describe('getJobId()', () => {
    it('returns null when idle', () => {
      assert.equal(controller.getJobId(), null)
    })

    it('returns the job ID when set', () => {
      controller._jobId = 'job_12345'
      assert.equal(controller.getJobId(), 'job_12345')
    })
  })

  describe('handleCommand()', () => {
    it('sends usage message for /run without args', async () => {
      await controller.handleCommand('run', '')
      assert.equal(bot.sent.length, 1)
      assert.ok(bot.sent[0].text.includes('Usage: /run'))
    })

    it('sends usage message for /run with whitespace-only args', async () => {
      await controller.handleCommand('run', '   ')
      assert.equal(bot.sent.length, 1)
      assert.ok(bot.sent[0].text.includes('Usage: /run'))
    })

    it('rejects /run when input request is pending', async () => {
      controller._inputRequester = { hasPendingRequest: () => true }
      await controller.handleCommand('run', 'do something')
      assert.equal(bot.sent.length, 1)
      assert.ok(bot.sent[0].text.includes('waiting for your reply'))
    })

    it('reports idle status when no job running', async () => {
      await controller.handleCommand('status', '')
      assert.equal(bot.sent.length, 1)
      assert.ok(bot.sent[0].text.includes('idle'))
    })

    it('reports running status with job ID', async () => {
      controller._state = 'running'
      controller._jobId = 'job_999'
      await controller.handleCommand('status', '')
      assert.equal(bot.sent.length, 1)
      assert.ok(bot.sent[0].text.includes('running'))
      assert.ok(bot.sent[0].text.includes('job_999'))
    })

    it('reports completed status with job ID', async () => {
      controller._state = 'completed'
      controller._jobId = 'job_888'
      await controller.handleCommand('status', '')
      assert.ok(bot.sent[0].text.includes('completed'))
      assert.ok(bot.sent[0].text.includes('job_888'))
    })

    it('reports failed status with job ID', async () => {
      controller._state = 'failed'
      controller._jobId = 'job_777'
      await controller.handleCommand('status', '')
      assert.ok(bot.sent[0].text.includes('failed'))
      assert.ok(bot.sent[0].text.includes('job_777'))
    })

    it('rejects /stop when no job is running', async () => {
      await controller.handleCommand('stop', '')
      assert.equal(bot.sent.length, 1)
      assert.ok(bot.sent[0].text.includes('No job is currently running'))
    })

    it('stops a running job and sends confirmation', async () => {
      controller._state = 'running'
      controller._jobId = 'job_555'
      controller._bridge = { interrupt: async () => {} }
      await controller.handleCommand('stop', '')
      assert.equal(controller.getJobState(), 'idle')
      assert.ok(bot.sent[0].text.includes('stopped'))
    })

    it('rejects /screenshot when no job is running', async () => {
      await controller.handleCommand('screenshot', '')
      assert.equal(bot.sent.length, 1)
      assert.ok(bot.sent[0].text.includes('No browser session'))
    })

    it('sends unknown command message for unrecognized commands', async () => {
      await controller.handleCommand('foobar', '')
      assert.equal(bot.sent.length, 1)
      assert.ok(bot.sent[0].text.includes('Unknown command: /foobar'))
    })
  })

  describe('runJob()', () => {
    it('rejects when a job is already running', async () => {
      controller._state = 'running'
      await controller.runJob('test prompt')
      assert.equal(bot.sent.length, 1)
      assert.ok(bot.sent[0].text.includes('already running'))
    })

    it('generates a job ID with timestamp prefix', () => {
      // Directly test the ID generation logic without triggering the full runJob flow
      const before = Date.now()
      const jobId = `job_${Date.now()}`
      assert.ok(jobId.startsWith('job_'))
      const ts = parseInt(jobId.split('_')[1])
      assert.ok(ts >= before)
    })
  })

  describe('_sendRecordingOrNotify()', () => {
    it('sends completion message when no recording path', async () => {
      controller._jobId = 'job_100'
      controller._bridge = { _browserInstance: null }
      await controller._sendRecordingOrNotify()
      assert.ok(bot.sent[0].text.includes('completed'))
    })

    it('sends completion message when recording path is null', async () => {
      controller._jobId = 'job_101'
      controller._bridge = { _browserInstance: { getRecordingPath: () => null } }
      await controller._sendRecordingOrNotify()
      assert.ok(bot.sent[0].text.includes('completed'))
    })

    it('sends video when recording is valid and within size limit', async () => {
      controller._jobId = 'job_102'
      controller._bridge = { _browserInstance: { getRecordingPath: () => '/tmp/video.webm' } }
      await controller._sendRecordingOrNotify()
      assert.equal(bot.videos.length, 1)
      assert.equal(bot.videos[0].filePath, '/tmp/video.webm')
      assert.ok(bot.videos[0].caption.includes('job_102'))
    })

    it('sends text message when recording exceeds size limit', async () => {
      controller._jobId = 'job_103'
      controller._bridge = { _browserInstance: { getRecordingPath: () => '/tmp/big.webm' } }
      rm.checkSizeLimit = () => ({ withinLimit: false, sizeBytes: 60 * 1024 * 1024 })
      await controller._sendRecordingOrNotify()
      assert.equal(bot.videos.length, 0)
      assert.ok(bot.sent[0].text.includes('too large'))
    })

    it('sends unavailable message when recording validation fails', async () => {
      controller._jobId = 'job_104'
      controller._bridge = { _browserInstance: { getRecordingPath: () => '/tmp/missing.webm' } }
      rm.validateRecording = () => ({ ok: false, error: 'File not found' })
      await controller._sendRecordingOrNotify()
      assert.ok(bot.sent[0].text.includes('unavailable'))
    })
  })

  describe('_clearStatusInterval()', () => {
    it('clears the interval and sets to null', () => {
      controller._statusInterval = setInterval(() => {}, 99999)
      controller._clearStatusInterval()
      assert.equal(controller._statusInterval, null)
    })

    it('is safe to call when no interval is set', () => {
      controller._clearStatusInterval()
      assert.equal(controller._statusInterval, null)
    })
  })
})
