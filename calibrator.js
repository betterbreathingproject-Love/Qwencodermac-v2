'use strict'

/**
 * Compute a Calibration_Profile from benchmark metrics.
 * @param {object} metrics - { generation_tps, prompt_tps, peak_memory_gb, available_memory_gb, context_window }
 * @returns {object} Calibration_Profile
 */
function computeProfile(metrics) {
  const { generation_tps, prompt_tps, peak_memory_gb, available_memory_gb, context_window } = metrics

  const roundedMetrics = {
    generation_tps: round2(generation_tps),
    prompt_tps: round2(prompt_tps),
    peak_memory_gb: round3(peak_memory_gb),
    available_memory_gb: round3(available_memory_gb),
    context_window,
  }

  const rawTimeout = (context_window / generation_tps) * 1000 + 30000
  const timeoutPerTurn = Math.max(60000, Math.round(rawTimeout))
  const maxInputTokens = Math.min(200000, Math.max(8000, Math.round(context_window * 0.6)))
  const compactionThreshold = Math.round(maxInputTokens * 0.85)
  const maxTurns = 500
  const poolTimeout = Math.max(120000, timeoutPerTurn * 3)

  return {
    maxTurns,
    timeoutPerTurn,
    maxInputTokens,
    compactionThreshold,
    poolTimeout,
    metrics: roundedMetrics,
  }
}

/**
 * Default fallback profile when benchmark fails.
 */
function defaultProfile() {
  return {
    maxTurns: 50,
    timeoutPerTurn: 120000,
    maxInputTokens: 24000,
    compactionThreshold: 20000,
    poolTimeout: 600000,
    metrics: null,
  }
}

function round2(n) { return Math.round(n * 100) / 100 }
function round3(n) { return Math.round(n * 1000) / 1000 }

module.exports = { computeProfile, defaultProfile, round2, round3 }
