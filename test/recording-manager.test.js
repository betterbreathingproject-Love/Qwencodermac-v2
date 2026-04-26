'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { RecordingManager } = require('../recording-manager')

describe('RecordingManager', () => {
  let tmpDir
  let manager

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-test-'))
    manager = new RecordingManager({ baseDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('constructor', () => {
    it('uses provided baseDir', () => {
      const dir = path.join(tmpDir, 'custom')
      const m = new RecordingManager({ baseDir: dir })
      // baseDir is stored internally — verify via getRecordingDir producing a subpath
      const recDir = m.getRecordingDir('test-job')
      assert.ok(recDir.startsWith(dir))
    })

    it('defaults baseDir when none provided', () => {
      // Outside Electron, falls back to cwd-based path
      const m = new RecordingManager()
      const recDir = m.getRecordingDir('fallback-job')
      assert.ok(recDir.includes('telegram-recordings'))
      // Clean up created dir
      fs.rmSync(recDir, { recursive: true, force: true })
    })
  })

  describe('generateFilename', () => {
    it('returns filename matching expected pattern', () => {
      const filename = manager.generateFilename('job123')
      assert.match(filename, /^recording_\d+_job123\.webm$/)
    })

    it('uses provided format', () => {
      const filename = manager.generateFilename('job456', 'mp4')
      assert.match(filename, /^recording_\d+_job456\.mp4$/)
    })

    it('defaults format to webm', () => {
      const filename = manager.generateFilename('j1')
      assert.ok(filename.endsWith('.webm'))
    })

    it('includes a numeric timestamp', () => {
      const before = Date.now()
      const filename = manager.generateFilename('ts-test')
      const after = Date.now()
      const match = filename.match(/^recording_(\d+)_ts-test\.webm$/)
      assert.ok(match)
      const ts = Number(match[1])
      assert.ok(ts >= before && ts <= after)
    })

    it('preserves jobId with special characters', () => {
      const filename = manager.generateFilename('job-with_special.chars')
      assert.match(filename, /^recording_\d+_job-with_special\.chars\.webm$/)
    })
  })

  describe('getRecordingDir', () => {
    it('returns path under baseDir with jobId', () => {
      const dir = manager.getRecordingDir('abc')
      assert.ok(dir.startsWith(path.join(tmpDir, 'abc')))
    })

    it('creates directory recursively if missing', () => {
      const dir = manager.getRecordingDir('new-job')
      assert.ok(fs.existsSync(dir))
      assert.ok(fs.statSync(dir).isDirectory())
    })

    it('succeeds when directory already exists', () => {
      const dir1 = manager.getRecordingDir('existing')
      const dir2 = manager.getRecordingDir('existing')
      assert.equal(dir1, dir2)
      assert.ok(fs.existsSync(dir2))
    })

    it('creates nested path when baseDir itself does not exist', () => {
      const deepBase = path.join(tmpDir, 'a', 'b', 'c')
      const m = new RecordingManager({ baseDir: deepBase })
      const dir = m.getRecordingDir('deep-job')
      assert.ok(fs.existsSync(dir))
      assert.ok(dir.startsWith(deepBase))
    })
  })

  describe('listRecordings', () => {
    it('returns empty array when baseDir does not exist', () => {
      const m = new RecordingManager({ baseDir: path.join(tmpDir, 'nonexistent') })
      const list = m.listRecordings()
      assert.deepStrictEqual(list, [])
    })

    it('returns empty array when baseDir is empty', () => {
      const list = manager.listRecordings()
      assert.deepStrictEqual(list, [])
    })

    it('lists files inside job subdirectories', () => {
      const jobDir = path.join(tmpDir, 'job1')
      fs.mkdirSync(jobDir, { recursive: true })
      fs.writeFileSync(path.join(jobDir, 'recording_123_job1.webm'), 'data')

      const list = manager.listRecordings()
      assert.equal(list.length, 1)
      assert.equal(list[0].filename, 'recording_123_job1.webm')
      assert.equal(list[0].sizeBytes, 4)
      assert.ok(list[0].filePath.endsWith('recording_123_job1.webm'))
      assert.ok(list[0].createdAt instanceof Date)
    })

    it('lists files directly in baseDir', () => {
      fs.writeFileSync(path.join(tmpDir, 'loose-file.webm'), 'abc')

      const list = manager.listRecordings()
      assert.equal(list.length, 1)
      assert.equal(list[0].filename, 'loose-file.webm')
      assert.equal(list[0].sizeBytes, 3)
    })

    it('lists files across multiple job subdirectories', () => {
      const job1 = path.join(tmpDir, 'job1')
      const job2 = path.join(tmpDir, 'job2')
      fs.mkdirSync(job1, { recursive: true })
      fs.mkdirSync(job2, { recursive: true })
      fs.writeFileSync(path.join(job1, 'a.webm'), '1234')
      fs.writeFileSync(path.join(job2, 'b.mp4'), '56789')

      const list = manager.listRecordings()
      assert.equal(list.length, 2)
      const filenames = list.map(r => r.filename).sort()
      assert.deepStrictEqual(filenames, ['a.webm', 'b.mp4'])
    })
  })

  describe('validateRecording', () => {
    it('returns ok with sizeBytes for existing readable file', () => {
      const filePath = path.join(tmpDir, 'valid.webm')
      fs.writeFileSync(filePath, 'hello world')

      const result = manager.validateRecording(filePath)
      assert.equal(result.ok, true)
      assert.equal(result.sizeBytes, 11)
    })

    it('returns ok false with error for missing file', () => {
      const result = manager.validateRecording(path.join(tmpDir, 'missing.webm'))
      assert.equal(result.ok, false)
      assert.ok(typeof result.error === 'string')
      assert.ok(result.error.length > 0)
    })

    it('returns ok false with error for unreadable file', () => {
      const filePath = path.join(tmpDir, 'noperm.webm')
      fs.writeFileSync(filePath, 'secret')
      fs.chmodSync(filePath, 0o000)

      const result = manager.validateRecording(filePath)
      assert.equal(result.ok, false)
      assert.ok(typeof result.error === 'string')

      // Restore permissions for cleanup
      fs.chmodSync(filePath, 0o644)
    })
  })

  describe('checkSizeLimit', () => {
    it('returns withinLimit true for small file', () => {
      const filePath = path.join(tmpDir, 'small.webm')
      fs.writeFileSync(filePath, 'tiny')

      const result = manager.checkSizeLimit(filePath)
      assert.equal(result.withinLimit, true)
      assert.equal(result.sizeBytes, 4)
    })

    it('returns withinLimit true for file exactly at 50 MB', () => {
      const filePath = path.join(tmpDir, 'exact50.webm')
      const size = 50 * 1024 * 1024
      // Create a sparse file of exactly 50 MB
      const fd = fs.openSync(filePath, 'w')
      fs.ftruncateSync(fd, size)
      fs.closeSync(fd)

      const result = manager.checkSizeLimit(filePath)
      assert.equal(result.withinLimit, true)
      assert.equal(result.sizeBytes, size)
    })

    it('returns withinLimit false for file exceeding 50 MB', () => {
      const filePath = path.join(tmpDir, 'big.webm')
      const size = 50 * 1024 * 1024 + 1
      const fd = fs.openSync(filePath, 'w')
      fs.ftruncateSync(fd, size)
      fs.closeSync(fd)

      const result = manager.checkSizeLimit(filePath)
      assert.equal(result.withinLimit, false)
      assert.equal(result.sizeBytes, size)
    })
  })
})
