'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { computeProfile, defaultProfile, round2, round3 } = require('../calibrator')

describe('calibrator', () => {
  describe('computeProfile — known metrics', () => {
    it('computes expected profile from hand-calculated values', () => {
      const metrics = {
        generation_tps: 40,
        prompt_tps: 120,
        peak_memory_gb: 6.123,
        available_memory_gb: 10.456,
        context_window: 32768,
      }
      const p = computeProfile(metrics)

      // Memory pressure: 6.123 / (6.123 + 10.456) = 6.123 / 16.579 ≈ 0.3693
      // memoryScale = 0.5 + 0.5 * cos(0.3693 * π) ≈ 0.5 + 0.5 * 0.3987 ≈ 0.6994
      const pressure = 6.123 / (6.123 + 10.456)
      const scale = 0.5 + 0.5 * Math.cos(pressure * Math.PI)

      // timeoutPerTurn = max(60000, round((32768 / 40) * 1000 + 30000))
      //                = max(60000, round(819200 + 30000))
      //                = max(60000, 849200) = 849200
      assert.equal(p.timeoutPerTurn, 849200)

      // maxInputTokens = clamp(round(32768 * 0.6 * scale), 8000, 200000)
      const expectedMaxInput = Math.min(200000, Math.max(8000, Math.round(32768 * 0.6 * scale)))
      assert.equal(p.maxInputTokens, expectedMaxInput)

      // compactionThreshold = round(maxInputTokens * 0.85)
      assert.equal(p.compactionThreshold, Math.round(expectedMaxInput * 0.85))

      assert.equal(p.maxTurns, 500)

      // poolTimeout = max(120000, 849200 * 3) = max(120000, 2547600) = 2547600
      assert.equal(p.poolTimeout, 2547600)

      // metrics rounded
      assert.equal(p.metrics.generation_tps, 40)
      assert.equal(p.metrics.prompt_tps, 120)
      assert.equal(p.metrics.peak_memory_gb, 6.123)
      assert.equal(p.metrics.available_memory_gb, 10.456)
      assert.equal(p.metrics.context_window, 32768)
    })
  })

  describe('defaultProfile', () => {
    it('returns conservative hardcoded fallback values', () => {
      const p = defaultProfile()
      assert.equal(p.maxTurns, 50)
      assert.equal(p.timeoutPerTurn, 120000)
      assert.equal(p.maxInputTokens, 24000)
      assert.equal(p.compactionThreshold, 20000)
      assert.equal(p.poolTimeout, 600000)
      assert.equal(p.metrics, null)
    })
  })

  describe('maxTurns is always 500', () => {
    it('returns 500 for typical metrics', () => {
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 4, available_memory_gb: 8, context_window: 32768,
      })
      assert.equal(p.maxTurns, 500)
    })

    it('returns 500 for extreme metrics', () => {
      const p = computeProfile({
        generation_tps: 0.1, prompt_tps: 0.5,
        peak_memory_gb: 0.1, available_memory_gb: 0.2, context_window: 1000000,
      })
      assert.equal(p.maxTurns, 500)
    })
  })

  describe('edge case: very low TPS (0.1)', () => {
    it('timeout floor of 60000 kicks in when raw timeout is below floor', () => {
      // With high TPS and small context, raw timeout could be small
      // rawTimeout = (100 / 100) * 1000 + 30000 = 31000 → floor to 60000
      const p = computeProfile({
        generation_tps: 100, prompt_tps: 200,
        peak_memory_gb: 2, available_memory_gb: 4, context_window: 100,
      })
      assert.equal(p.timeoutPerTurn, 60000)
    })

    it('very low TPS (0.1) produces a large timeout above the floor', () => {
      // rawTimeout = (32768 / 0.1) * 1000 + 30000 = 327680000 + 30000 = 327710000
      const p = computeProfile({
        generation_tps: 0.1, prompt_tps: 0.5,
        peak_memory_gb: 2, available_memory_gb: 4, context_window: 32768,
      })
      assert.equal(p.timeoutPerTurn, 327710000)
      // Still above 60000, so floor doesn't clamp it
      assert.ok(p.timeoutPerTurn >= 60000)
    })
  })

  describe('edge case: very large context window (1000000)', () => {
    it('maxInputTokens clamped to 200000', () => {
      // context_window * 0.6 = 600000 → clamped to 200000
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 8, available_memory_gb: 16, context_window: 1000000,
      })
      assert.equal(p.maxInputTokens, 200000)
      // compactionThreshold = round(200000 * 0.85) = 170000
      assert.equal(p.compactionThreshold, 170000)
    })
  })

  describe('edge case: very small context window (100)', () => {
    it('maxInputTokens clamped to 8000', () => {
      // context_window * 0.6 = 60 → clamped to 8000
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 2, available_memory_gb: 4, context_window: 100,
      })
      assert.equal(p.maxInputTokens, 8000)
      // compactionThreshold = round(8000 * 0.85) = 6800
      assert.equal(p.compactionThreshold, 6800)
    })
  })

  describe('memory pressure scaling', () => {
    it('near-full capacity when memory pressure is low', () => {
      // peak=4, available=12 → pressure = 0.25 → cos(0.25π) ≈ 0.707 → scale ≈ 0.854
      // Still gives most of the budget at low pressure
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 4, available_memory_gb: 12, context_window: 32768,
      })
      const unscaled = Math.round(32768 * 0.6)
      assert.ok(p.maxInputTokens >= unscaled * 0.8, 'Should retain >80% at low pressure')
    })

    it('moderate reduction at medium pressure', () => {
      // peak=16, available=16 → pressure = 0.5 → cos(0.5π) = 0 → scale = 0.5
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 16, available_memory_gb: 16, context_window: 32768,
      })
      const unscaled = Math.round(32768 * 0.6)
      assert.ok(p.maxInputTokens < unscaled, 'Should be reduced at 50% pressure')
      assert.ok(p.maxInputTokens >= unscaled * 0.45, 'Should not be below 45% at 50% pressure')
    })

    it('scales down significantly when memory pressure is high', () => {
      // peak=30, available=6 → pressure ≈ 0.833 → cos(0.833π) ≈ -0.866 → scale ≈ 0.067
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 30, available_memory_gb: 6, context_window: 32768,
      })
      const unscaled = Math.round(32768 * 0.6)
      assert.ok(p.maxInputTokens < unscaled * 0.5, 'Should be well below half at high pressure')
      assert.ok(p.maxInputTokens >= 8000, 'Should never go below the 8000 floor')
    })

    it('hits minimum floor when memory is nearly exhausted', () => {
      // peak=100, available=0.01 → pressure ≈ 1.0 → cos(π) = -1 → scale = 0
      // But maxInputTokens is clamped to 8000 minimum
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 100, available_memory_gb: 0.01, context_window: 32768,
      })
      assert.equal(p.maxInputTokens, 8000, 'Should hit the 8000 floor at extreme pressure')
    })

    it('compactionThreshold scales with maxInputTokens under memory pressure', () => {
      const pLow = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 4, available_memory_gb: 12, context_window: 32768,
      })
      const pHigh = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 30, available_memory_gb: 6, context_window: 32768,
      })
      assert.ok(pHigh.compactionThreshold < pLow.compactionThreshold,
        'Compaction threshold should be lower under memory pressure')
      assert.equal(pHigh.compactionThreshold, Math.round(pHigh.maxInputTokens * 0.85))
    })

    it('smooth curve — no sudden jumps between adjacent pressure levels', () => {
      // Check that small changes in pressure produce small changes in output
      const base = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 10, available_memory_gb: 10, context_window: 32768,
      })
      const slight = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 11, available_memory_gb: 10, context_window: 32768,
      })
      const diff = Math.abs(base.maxInputTokens - slight.maxInputTokens)
      assert.ok(diff < 1000, `Adjacent pressure levels should differ by <1000 tokens, got ${diff}`)
    })
  })

  describe('round2 and round3', () => {
    it('round2 rounds to 2 decimal places', () => {
      assert.equal(round2(3.14159), 3.14)
      assert.equal(round2(2.005), 2.01) // note: JS floating point
      assert.equal(round2(0), 0)
      assert.equal(round2(1.1), 1.1)
      assert.equal(round2(99.999), 100)
    })

    it('round3 rounds to 3 decimal places', () => {
      assert.equal(round3(3.14159), 3.142)
      assert.equal(round3(0), 0)
      assert.equal(round3(1.1), 1.1)
      assert.equal(round3(6.1234), 6.123)
      assert.equal(round3(9.9999), 10)
    })
  })
})
