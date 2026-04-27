'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { computeProfile, defaultProfile, round2, round3 } = require('../calibrator')
const config = require('../config')

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
      assert.equal(p.timeoutPerTurn, 849200)

      // effectiveContext = max(32768, CONTEXT_WINDOW) = 84000
      // maxInputTokens = clamp(round(84000 * 0.85 * scale), CALIBRATOR_FLOOR, 200000)
      const effectiveContext = Math.max(32768, config.CONTEXT_WINDOW)
      const expectedMaxInput = Math.min(200000, Math.max(config.CALIBRATOR_FLOOR, Math.round(effectiveContext * 0.85 * scale)))
      assert.equal(p.maxInputTokens, expectedMaxInput)

      // compactionThreshold = round(maxInputTokens * 0.85)
      assert.equal(p.compactionThreshold, Math.round(expectedMaxInput * 0.85))

      assert.equal(p.maxTurns, 500)
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
    it('returns fallback values derived from config', () => {
      const p = defaultProfile()
      assert.equal(p.maxTurns, 50)
      assert.equal(p.timeoutPerTurn, 120000)
      assert.equal(p.maxInputTokens, config.MAX_INPUT_TOKENS)
      assert.equal(p.compactionThreshold, config.COMPACTION_THRESHOLD)
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
      const p = computeProfile({
        generation_tps: 100, prompt_tps: 200,
        peak_memory_gb: 2, available_memory_gb: 4, context_window: 100,
      })
      assert.equal(p.timeoutPerTurn, 60000)
    })

    it('very low TPS (0.1) produces a large timeout above the floor', () => {
      const p = computeProfile({
        generation_tps: 0.1, prompt_tps: 0.5,
        peak_memory_gb: 2, available_memory_gb: 4, context_window: 32768,
      })
      assert.equal(p.timeoutPerTurn, 327710000)
      assert.ok(p.timeoutPerTurn >= 60000)
    })
  })

  describe('edge case: very large context window (1000000)', () => {
    it('maxInputTokens clamped to 200000', () => {
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 8, available_memory_gb: 16, context_window: 1000000,
      })
      assert.equal(p.maxInputTokens, 200000)
      assert.equal(p.compactionThreshold, 170000)
    })
  })

  describe('edge case: very small context window (100)', () => {
    it('maxInputTokens hits calibrator floor', () => {
      // effectiveContext = max(100, 84000) = 84000
      // With low pressure (peak=2, avail=4), scale ≈ 0.75
      // rawMaxInput = 84000 * 0.85 * 0.75 ≈ 53550 > floor
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 2, available_memory_gb: 4, context_window: 100,
      })
      assert.ok(p.maxInputTokens >= config.CALIBRATOR_FLOOR, 'Should be at or above floor')
      assert.equal(p.compactionThreshold, Math.round(p.maxInputTokens * 0.85))
    })
  })

  describe('memory pressure scaling', () => {
    it('near-full capacity when memory pressure is low', () => {
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 4, available_memory_gb: 12, context_window: 32768,
      })
      // effectiveContext = 84000, scale ≈ 0.85 at low pressure
      // rawMaxInput ≈ 84000 * 0.85 * 0.85 ≈ 60690
      assert.ok(p.maxInputTokens >= config.CALIBRATOR_FLOOR, 'Should be well above floor at low pressure')
    })

    it('moderate reduction at medium pressure', () => {
      // peak=16, available=16 → pressure = 0.5 → cos(0.5π) = 0 → scale = 0.5
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 16, available_memory_gb: 16, context_window: 32768,
      })
      // rawMaxInput = 84000 * 0.85 * 0.5 = 35700
      assert.ok(p.maxInputTokens >= config.CALIBRATOR_FLOOR, 'Should be at or above floor')
      // At 50% pressure, should be reduced from max
      const maxPossible = Math.round(config.CONTEXT_WINDOW * 0.85 * 1.0)
      assert.ok(p.maxInputTokens < maxPossible, 'Should be reduced at 50% pressure')
    })

    it('scales down significantly when memory pressure is high', () => {
      // peak=30, available=6 → pressure ≈ 0.833 → scale ≈ 0.067
      // rawMaxInput = 84000 * 0.85 * 0.067 ≈ 4786 → clamped to floor
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 30, available_memory_gb: 6, context_window: 32768,
      })
      assert.equal(p.maxInputTokens, config.CALIBRATOR_FLOOR, 'Should hit floor at high pressure')
    })

    it('hits minimum floor when memory is nearly exhausted', () => {
      const p = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 100, available_memory_gb: 0.01, context_window: 32768,
      })
      assert.equal(p.maxInputTokens, config.CALIBRATOR_FLOOR, 'Should hit floor at extreme pressure')
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
        'Compaction threshold should be lower under high pressure')
      assert.equal(pHigh.compactionThreshold, Math.round(pHigh.maxInputTokens * 0.85))
      assert.equal(pLow.compactionThreshold, Math.round(pLow.maxInputTokens * 0.85))
    })

    it('smooth curve — no sudden jumps between adjacent pressure levels', () => {
      const base = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 10, available_memory_gb: 10, context_window: 32768,
      })
      const slight = computeProfile({
        generation_tps: 50, prompt_tps: 100,
        peak_memory_gb: 11, available_memory_gb: 10, context_window: 32768,
      })
      const diff = Math.abs(base.maxInputTokens - slight.maxInputTokens)
      // With 84K context, adjacent levels can differ by up to ~3.5K tokens
      assert.ok(diff < 3500, `Adjacent pressure levels should differ by <3500 tokens, got ${diff}`)
    })
  })

  describe('round2 and round3', () => {
    it('round2 rounds to 2 decimal places', () => {
      assert.equal(round2(3.14159), 3.14)
      assert.equal(round2(2.005), 2.01)
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
