'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fc = require('fast-check')
const { computeProfile, round2, round3 } = require('../calibrator')

// --- Generator for valid benchmark metrics ---

function arbitraryMetrics() {
  return fc.record({
    generation_tps: fc.double({ min: 0.01, max: 500, noNaN: true }),
    prompt_tps: fc.double({ min: 0.01, max: 1000, noNaN: true }),
    peak_memory_gb: fc.double({ min: 0, max: 128, noNaN: true }),
    available_memory_gb: fc.double({ min: 0, max: 256, noNaN: true }),
    context_window: fc.integer({ min: 1, max: 2000000 }),
  })
}

// --- Helper: count decimal places in a number ---

function decimalPlaces(n) {
  const s = String(n)
  const dotIndex = s.indexOf('.')
  if (dotIndex === -1) return 0
  return s.length - dotIndex - 1
}

// --- Property Tests ---

describe('Feature: adaptive-agent-calibration — calibrator property tests', () => {
  /**
   * Property 1 — Formula correctness
   * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**
   *
   * For random valid metrics, verify all computed fields match formulas
   * with floors/clamps.
   */
  it('Property 1: Formula correctness', () => {
    fc.assert(
      fc.property(arbitraryMetrics(), (metrics) => {
        const profile = computeProfile(metrics)

        // timeoutPerTurn = max(60000, round((context_window / generation_tps) * 1000 + 30000))
        const rawTimeout = (metrics.context_window / metrics.generation_tps) * 1000 + 30000
        const expectedTimeout = Math.max(60000, Math.round(rawTimeout))
        assert.equal(profile.timeoutPerTurn, expectedTimeout,
          `timeoutPerTurn mismatch for generation_tps=${metrics.generation_tps}, context_window=${metrics.context_window}`)

        // Memory pressure scaling
        const memoryPressure = metrics.available_memory_gb > 0
          ? Math.min(1, metrics.peak_memory_gb / (metrics.peak_memory_gb + metrics.available_memory_gb))
          : 0.5
        const memoryScale = memoryPressure <= 0.5
          ? 1.0
          : Math.max(0.5, 1.0 - (memoryPressure - 0.5))

        // maxInputTokens = clamp(round(context_window * 0.6 * memoryScale), 8000, 200000)
        const expectedMaxInput = Math.min(200000, Math.max(8000, Math.round(metrics.context_window * 0.6 * memoryScale)))
        assert.equal(profile.maxInputTokens, expectedMaxInput,
          `maxInputTokens mismatch for context_window=${metrics.context_window}`)

        // compactionThreshold = round(maxInputTokens * 0.85)
        const expectedCompaction = Math.round(expectedMaxInput * 0.85)
        assert.equal(profile.compactionThreshold, expectedCompaction,
          `compactionThreshold mismatch`)

        // maxTurns = 500
        assert.equal(profile.maxTurns, 500, 'maxTurns must always be 500')

        // poolTimeout = max(120000, timeoutPerTurn * 3)
        const expectedPoolTimeout = Math.max(120000, expectedTimeout * 3)
        assert.equal(profile.poolTimeout, expectedPoolTimeout,
          `poolTimeout mismatch`)

        // metrics contain rounded values
        assert.equal(profile.metrics.generation_tps, round2(metrics.generation_tps))
        assert.equal(profile.metrics.prompt_tps, round2(metrics.prompt_tps))
        assert.equal(profile.metrics.peak_memory_gb, round3(metrics.peak_memory_gb))
        assert.equal(profile.metrics.available_memory_gb, round3(metrics.available_memory_gb))
        assert.equal(profile.metrics.context_window, metrics.context_window)
      }),
      { numRuns: 150 }
    )
  })

  /**
   * Property 2 — Deterministic computation
   * **Validates: Requirements 2.7**
   *
   * For random metrics, computeProfile(m) called twice produces identical results.
   */
  it('Property 2: Deterministic computation', () => {
    fc.assert(
      fc.property(arbitraryMetrics(), (metrics) => {
        const profile1 = computeProfile(metrics)
        const profile2 = computeProfile(metrics)
        assert.deepStrictEqual(profile1, profile2,
          'Two calls to computeProfile with the same metrics must produce identical results')
      }),
      { numRuns: 150 }
    )
  })

  /**
   * Property 3 — JSON round-trip
   * **Validates: Requirements 7.1, 7.2**
   *
   * For random metrics, JSON.parse(JSON.stringify(profile)) deep-equals original.
   */
  it('Property 3: JSON round-trip', () => {
    fc.assert(
      fc.property(arbitraryMetrics(), (metrics) => {
        const profile = computeProfile(metrics)
        const roundTripped = JSON.parse(JSON.stringify(profile))
        assert.deepStrictEqual(roundTripped, profile,
          'Profile must survive JSON serialization round-trip without data loss')
      }),
      { numRuns: 150 }
    )
  })

  /**
   * Property 4 — Rounding precision
   * **Validates: Requirements 7.3**
   *
   * For random floats, verify decimal place counts on rounded metrics.
   * TPS values (generation_tps, prompt_tps) have at most 2 decimal places.
   * Memory values (peak_memory_gb, available_memory_gb) have at most 3 decimal places.
   */
  it('Property 4: Rounding precision', () => {
    fc.assert(
      fc.property(arbitraryMetrics(), (metrics) => {
        const profile = computeProfile(metrics)
        const m = profile.metrics

        assert.ok(decimalPlaces(m.generation_tps) <= 2,
          `generation_tps ${m.generation_tps} has ${decimalPlaces(m.generation_tps)} decimal places, expected at most 2`)
        assert.ok(decimalPlaces(m.prompt_tps) <= 2,
          `prompt_tps ${m.prompt_tps} has ${decimalPlaces(m.prompt_tps)} decimal places, expected at most 2`)
        assert.ok(decimalPlaces(m.peak_memory_gb) <= 3,
          `peak_memory_gb ${m.peak_memory_gb} has ${decimalPlaces(m.peak_memory_gb)} decimal places, expected at most 3`)
        assert.ok(decimalPlaces(m.available_memory_gb) <= 3,
          `available_memory_gb ${m.available_memory_gb} has ${decimalPlaces(m.available_memory_gb)} decimal places, expected at most 3`)
      }),
      { numRuns: 150 }
    )
  })

  /**
   * Property 5 — Dashboard renders all profile values
   * **Validates: Requirements 9.3, 9.4**
   *
   * For random valid profiles, verify rendered HTML contains all metric
   * and setting values. Uses a pure-function replica of the renderer's
   * renderCalibrationDashboard logic (since the real one is DOM-based
   * and not importable in Node.js).
   */
  it('Property 5: Dashboard renders all profile values', () => {
    // Replicate the rendering logic from renderer/app.js as a pure function
    function renderCalibrationDashboardForTest(profile) {
      const m = profile.metrics || {}

      const benchmarkChips = [
        { label: 'Generation TPS', value: m.generation_tps != null ? m.generation_tps + ' tk/s' : '—', accent: true },
        { label: 'Prompt TPS',     value: m.prompt_tps != null ? m.prompt_tps + ' tk/s' : '—', accent: true },
        { label: 'Peak Memory',    value: m.peak_memory_gb != null ? m.peak_memory_gb + ' GB' : '—' },
        { label: 'Available Memory', value: m.available_memory_gb != null ? m.available_memory_gb + ' GB' : '—' },
        { label: 'Context Window', value: m.context_window != null ? m.context_window.toLocaleString() + ' tok' : '—' },
      ]

      const settingsChips = [
        { label: 'Max Turns',            value: profile.maxTurns },
        { label: 'Timeout / Turn',       value: (profile.timeoutPerTurn / 1000).toFixed(0) + 's' },
        { label: 'Max Input Tokens',     value: profile.maxInputTokens?.toLocaleString() + ' tok' },
        { label: 'Compaction Threshold', value: profile.compactionThreshold?.toLocaleString() + ' tok' },
        { label: 'Pool Timeout',         value: (profile.poolTimeout / 1000).toFixed(0) + 's' },
      ]

      function chipHtml(chips) {
        return chips.map(c => {
          const cls = c.accent ? 'stat-chip accent' : 'stat-chip'
          return `<div class="${cls}"><span class="stat-label">${c.label}</span><span class="stat-val">${c.value}</span></div>`
        }).join('')
      }

      return `
        <div class="calibration-section">
          <div class="calibration-section-title">Benchmark Results</div>
          <div class="calibration-grid">${chipHtml(benchmarkChips)}</div>
        </div>
        <div class="calibration-section">
          <div class="calibration-section-title">Computed Settings</div>
          <div class="calibration-grid">${chipHtml(settingsChips)}</div>
        </div>
      `
    }

    fc.assert(
      fc.property(arbitraryMetrics(), (metrics) => {
        const profile = computeProfile(metrics)
        const html = renderCalibrationDashboardForTest(profile)
        const m = profile.metrics

        // All 5 benchmark metric values must appear in the HTML
        assert.ok(html.includes(String(m.generation_tps)),
          `HTML missing generation_tps value: ${m.generation_tps}`)
        assert.ok(html.includes(String(m.prompt_tps)),
          `HTML missing prompt_tps value: ${m.prompt_tps}`)
        assert.ok(html.includes(String(m.peak_memory_gb)),
          `HTML missing peak_memory_gb value: ${m.peak_memory_gb}`)
        assert.ok(html.includes(String(m.available_memory_gb)),
          `HTML missing available_memory_gb value: ${m.available_memory_gb}`)
        // context_window uses toLocaleString() in the renderer
        assert.ok(html.includes(m.context_window.toLocaleString()),
          `HTML missing context_window value: ${m.context_window}`)

        // All 5 computed setting values must appear in the HTML
        // Note: maxInputTokens, compactionThreshold use toLocaleString() in the renderer
        assert.ok(html.includes(String(profile.maxTurns)),
          `HTML missing maxTurns value: ${profile.maxTurns}`)
        assert.ok(html.includes((profile.timeoutPerTurn / 1000).toFixed(0) + 's'),
          `HTML missing timeoutPerTurn value: ${profile.timeoutPerTurn}`)
        assert.ok(html.includes(profile.maxInputTokens.toLocaleString()),
          `HTML missing maxInputTokens value: ${profile.maxInputTokens}`)
        assert.ok(html.includes(profile.compactionThreshold.toLocaleString()),
          `HTML missing compactionThreshold value: ${profile.compactionThreshold}`)
        assert.ok(html.includes((profile.poolTimeout / 1000).toFixed(0) + 's'),
          `HTML missing poolTimeout value: ${profile.poolTimeout}`)
      }),
      { numRuns: 150 }
    )
  })
})
