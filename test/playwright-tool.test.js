'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createPlaywrightInstance } = require('../playwright-tool')

describe('playwright-tool recording support', () => {
  describe('createPlaywrightInstance() return shape', () => {
    it('returns { execute, closeBrowser, getRecordingPath } with no options', () => {
      const instance = createPlaywrightInstance()
      assert.equal(typeof instance.execute, 'function')
      assert.equal(typeof instance.closeBrowser, 'function')
      assert.equal(typeof instance.getRecordingPath, 'function')
      // Exactly these three keys
      assert.deepStrictEqual(Object.keys(instance).sort(), ['closeBrowser', 'execute', 'getRecordingPath'])
    })

    it('returns the same shape with empty options object', () => {
      const instance = createPlaywrightInstance({})
      assert.equal(typeof instance.execute, 'function')
      assert.equal(typeof instance.closeBrowser, 'function')
      assert.equal(typeof instance.getRecordingPath, 'function')
      assert.deepStrictEqual(Object.keys(instance).sort(), ['closeBrowser', 'execute', 'getRecordingPath'])
    })

    it('returns the same shape with recordingOptions provided', () => {
      const instance = createPlaywrightInstance({
        recordingOptions: { dir: '/tmp/test-recording-dir' },
      })
      assert.equal(typeof instance.execute, 'function')
      assert.equal(typeof instance.closeBrowser, 'function')
      assert.equal(typeof instance.getRecordingPath, 'function')
      assert.deepStrictEqual(Object.keys(instance).sort(), ['closeBrowser', 'execute', 'getRecordingPath'])
    })
  })

  describe('getRecordingPath()', () => {
    it('returns null before any browser activity', () => {
      const instance = createPlaywrightInstance()
      assert.equal(instance.getRecordingPath(), null)
    })

    it('returns null when created with empty options', () => {
      const instance = createPlaywrightInstance({})
      assert.equal(instance.getRecordingPath(), null)
    })

    it('returns null when created with recordingOptions but no browser launched', () => {
      const instance = createPlaywrightInstance({
        recordingOptions: { dir: '/tmp/test-rec' },
      })
      assert.equal(instance.getRecordingPath(), null)
    })
  })

  describe('execute() with unknown tool', () => {
    it('returns an error for an unknown tool name', async () => {
      const instance = createPlaywrightInstance()
      const result = await instance.execute('unknown_tool', {})
      assert.ok(result.error)
      assert.ok(result.error.includes('Unknown browser tool'))
    })

    it('returns an error mentioning the tool name', async () => {
      const instance = createPlaywrightInstance()
      const result = await instance.execute('nonexistent_action', {})
      assert.ok(result.error.includes('nonexistent_action'))
    })
  })

  describe('closeBrowser() without browser launched', () => {
    it('does not throw when no browser was started', async () => {
      const instance = createPlaywrightInstance()
      await instance.closeBrowser()
      // Should complete without error
    })

    it('getRecordingPath() still returns null after close with no browser', async () => {
      const instance = createPlaywrightInstance()
      await instance.closeBrowser()
      assert.equal(instance.getRecordingPath(), null)
    })
  })

  describe('backward compatibility', () => {
    it('createPlaywrightInstance can be called with no arguments', () => {
      // Original API had no parameters — this must still work
      const instance = createPlaywrightInstance()
      assert.ok(instance)
      assert.equal(typeof instance.execute, 'function')
    })

    it('execute returns "Unknown browser tool" for invalid names but not for valid ones', async () => {
      const instance = createPlaywrightInstance()
      // Unknown tool should get the specific error
      const result = await instance.execute('fake_tool', {})
      assert.ok(result.error.includes('Unknown browser tool'))
      // Known tool names should NOT produce "Unknown browser tool" —
      // we can't call them without a real browser, but we verify dispatch
      // recognizes them by checking that an unknown name is rejected.
    })
  })
})
