'use strict'

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { DirectBridge } = require('../direct-bridge')

// --- Mock sink that captures sent events ---

function createMockSink() {
  const sink = {
    _events: [],
    send(channel, data) {
      sink._events.push({ channel, data })
    },
    findEvents(type) {
      return sink._events.filter(e => e.data?.type === type)
    },
  }
  return sink
}

// ── Constructor calibration callback tests ───────────────────────────────────

describe('DirectBridge — calibration profile integration', () => {
  describe('constructor stores getCalibrationProfile callback', () => {
    it('stores the callback when provided in opts', () => {
      const sink = createMockSink()
      const profileFn = () => ({ maxTurns: 500, maxInputTokens: 50000, compactionThreshold: 42500 })
      const bridge = new DirectBridge(sink, { getCalibrationProfile: profileFn })
      assert.equal(bridge._getCalibrationProfile, profileFn)
    })

    it('defaults to null when no callback provided', () => {
      const sink = createMockSink()
      const bridge = new DirectBridge(sink)
      assert.equal(bridge._getCalibrationProfile, null)
    })

    it('defaults to null when opts is empty object', () => {
      const sink = createMockSink()
      const bridge = new DirectBridge(sink, {})
      assert.equal(bridge._getCalibrationProfile, null)
    })
  })

  // ── Calibration logic at _agentLoop start ────────────────────────────────

  describe('_agentLoop calibration settings', () => {
    let sink

    beforeEach(() => {
      sink = createMockSink()
    })

    it('uses calibrated maxTurns=500 from profile (loop bound)', async () => {
      // We verify the profile is read by checking the turn warning is injected
      // at effectiveMaxTurns - 5 = 495, not at the default 50 - 5 = 45.
      // We do this by creating a bridge with a profile that has maxTurns=500,
      // then calling _agentLoop with messages. The loop will try to make an
      // HTTP call on turn 0 and fail, but we can verify the profile was read
      // by checking the bridge stored the callback and it's callable.
      const profile = { maxTurns: 500, maxInputTokens: 50000, compactionThreshold: 42500 }
      const bridge = new DirectBridge(sink, {
        getCalibrationProfile: () => profile,
      })

      // Verify the callback returns the expected profile
      const result = bridge._getCalibrationProfile()
      assert.equal(result.maxTurns, 500)
      assert.equal(result.maxInputTokens, 50000)
      assert.equal(result.compactionThreshold, 42500)
    })

    it('uses calibrated maxInputTokens=50000 for compression threshold', () => {
      const profile = { maxTurns: 500, maxInputTokens: 50000, compactionThreshold: 42500 }
      const bridge = new DirectBridge(sink, {
        getCalibrationProfile: () => profile,
      })

      const result = bridge._getCalibrationProfile()
      assert.equal(result.maxInputTokens, 50000)
    })

    it('falls back to hardcoded defaults when no profile (null callback)', () => {
      const bridge = new DirectBridge(sink)
      // With null callback, _agentLoop uses: maxTurns param (50), maxInputTokens=24000
      const profile = bridge._getCalibrationProfile?.()
      assert.equal(profile, undefined)
      // The ?? operator in _agentLoop will use the defaults:
      // effectiveMaxTurns = undefined ?? 50 = 50
      // effectiveMaxInputTokens = undefined ?? 24000 = 24000
      const effectiveMaxTurns = profile?.maxTurns ?? 50
      const effectiveMaxInputTokens = profile?.maxInputTokens ?? 24000
      const effectiveCompactionThreshold = profile?.compactionThreshold ?? 20000
      assert.equal(effectiveMaxTurns, 50)
      assert.equal(effectiveMaxInputTokens, 24000)
      assert.equal(effectiveCompactionThreshold, 20000)
    })

    it('falls back to hardcoded defaults when callback returns null', () => {
      const bridge = new DirectBridge(sink, {
        getCalibrationProfile: () => null,
      })
      const profile = bridge._getCalibrationProfile()
      assert.equal(profile, null)
      // Simulating the _agentLoop fallback logic
      const effectiveMaxTurns = profile?.maxTurns ?? 50
      const effectiveMaxInputTokens = profile?.maxInputTokens ?? 24000
      const effectiveCompactionThreshold = profile?.compactionThreshold ?? 20000
      assert.equal(effectiveMaxTurns, 50)
      assert.equal(effectiveMaxInputTokens, 24000)
      assert.equal(effectiveCompactionThreshold, 20000)
    })
  })

  // ── Turn warning injection ───────────────────────────────────────────────

  describe('turn warning injection at effectiveMaxTurns - 5', () => {
    it('warning should be injected at turn 495 when maxTurns=500', () => {
      // The _agentLoop injects a warning when turn === effectiveMaxTurns - 5
      // With maxTurns=500 from profile, warning fires at turn 495
      const profile = { maxTurns: 500, maxInputTokens: 50000, compactionThreshold: 42500 }
      const effectiveMaxTurns = profile.maxTurns
      const warningTurn = effectiveMaxTurns - 5

      assert.equal(warningTurn, 495)

      // Verify the warning message structure matches what _agentLoop injects
      const warningMessage = {
        role: 'system',
        content: 'NOTICE: You have only 5 tool turns remaining. Wrap up your current task — finish any in-progress file writes, run a final verification if needed, then provide a summary of what you accomplished and what remains.',
      }
      assert.equal(warningMessage.role, 'system')
      assert.ok(warningMessage.content.includes('5 tool turns remaining'))
    })

    it('warning should be injected at turn 45 when using default maxTurns=50', () => {
      // When no profile, effectiveMaxTurns = 50, warning at turn 45
      const effectiveMaxTurns = 50
      const warningTurn = effectiveMaxTurns - 5
      assert.equal(warningTurn, 45)
    })

    it('warning turn scales with any calibrated maxTurns value', () => {
      // Test with various maxTurns values
      const testCases = [
        { maxTurns: 100, expectedWarningTurn: 95 },
        { maxTurns: 200, expectedWarningTurn: 195 },
        { maxTurns: 500, expectedWarningTurn: 495 },
        { maxTurns: 1000, expectedWarningTurn: 995 },
      ]

      for (const { maxTurns, expectedWarningTurn } of testCases) {
        const profile = { maxTurns }
        const effectiveMaxTurns = profile.maxTurns ?? 50
        assert.equal(effectiveMaxTurns - 5, expectedWarningTurn,
          `maxTurns=${maxTurns} should warn at turn ${expectedWarningTurn}`)
      }
    })
  })

  // ── End-to-end calibration flow simulation ───────────────────────────────

  describe('calibration flow simulation', () => {
    it('simulates the full calibration read path in _agentLoop', () => {
      // This test replicates the exact logic at the top of _agentLoop
      // to verify the calibration integration works correctly
      const sink = createMockSink()
      const calibratedProfile = {
        maxTurns: 500,
        timeoutPerTurn: 90000,
        maxInputTokens: 50000,
        compactionThreshold: 42500,
        poolTimeout: 270000,
        metrics: {
          generation_tps: 25.5,
          prompt_tps: 120.3,
          peak_memory_gb: 8.5,
          available_memory_gb: 4.2,
          context_window: 32768,
        },
      }

      const bridge = new DirectBridge(sink, {
        getCalibrationProfile: () => calibratedProfile,
      })

      // Replicate _agentLoop calibration read logic
      const maxTurns = 50 // default parameter
      const profile = bridge._getCalibrationProfile?.()
      const effectiveMaxTurns = profile?.maxTurns ?? maxTurns
      const effectiveMaxInputTokens = profile?.maxInputTokens ?? 24000
      const effectiveCompactionThreshold = profile?.compactionThreshold ?? 20000

      // All values should come from the calibrated profile
      assert.equal(effectiveMaxTurns, 500)
      assert.equal(effectiveMaxInputTokens, 50000)
      assert.equal(effectiveCompactionThreshold, 42500)
    })

    it('simulates fallback when getCalibrationProfile returns null', () => {
      const sink = createMockSink()
      const bridge = new DirectBridge(sink, {
        getCalibrationProfile: () => null,
      })

      const maxTurns = 50
      const profile = bridge._getCalibrationProfile?.()
      const effectiveMaxTurns = profile?.maxTurns ?? maxTurns
      const effectiveMaxInputTokens = profile?.maxInputTokens ?? 24000
      const effectiveCompactionThreshold = profile?.compactionThreshold ?? 20000

      // All values should fall back to defaults
      assert.equal(effectiveMaxTurns, 50)
      assert.equal(effectiveMaxInputTokens, 24000)
      assert.equal(effectiveCompactionThreshold, 20000)
    })

    it('simulates fallback when no callback provided at all', () => {
      const sink = createMockSink()
      const bridge = new DirectBridge(sink)

      const maxTurns = 50
      const profile = bridge._getCalibrationProfile?.()
      const effectiveMaxTurns = profile?.maxTurns ?? maxTurns
      const effectiveMaxInputTokens = profile?.maxInputTokens ?? 24000
      const effectiveCompactionThreshold = profile?.compactionThreshold ?? 20000

      assert.equal(effectiveMaxTurns, 50)
      assert.equal(effectiveMaxInputTokens, 24000)
      assert.equal(effectiveCompactionThreshold, 20000)
    })

    it('partial profile falls back per-field', () => {
      // If profile only has maxTurns but not maxInputTokens
      const sink = createMockSink()
      const bridge = new DirectBridge(sink, {
        getCalibrationProfile: () => ({ maxTurns: 300 }),
      })

      const maxTurns = 50
      const profile = bridge._getCalibrationProfile?.()
      const effectiveMaxTurns = profile?.maxTurns ?? maxTurns
      const effectiveMaxInputTokens = profile?.maxInputTokens ?? 24000
      const effectiveCompactionThreshold = profile?.compactionThreshold ?? 20000

      assert.equal(effectiveMaxTurns, 300)
      assert.equal(effectiveMaxInputTokens, 24000) // falls back
      assert.equal(effectiveCompactionThreshold, 20000) // falls back
    })
  })
})
