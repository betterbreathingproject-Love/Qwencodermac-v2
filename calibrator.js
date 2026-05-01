'use strict'

const { CONTEXT_WINDOW, MAX_INPUT_TOKENS, COMPACTION_THRESHOLD, CALIBRATOR_FLOOR } = require('./config')

/**
 * Performance modes — trade memory safety for larger context budgets.
 *
 * stable:   Conservative. Full memory pressure scaling. Best for long sessions
 *           or when running other heavy apps alongside.
 * balanced: Default. Reduces memory pressure penalty by 50%. Good for medium
 *           projects with moderate app usage.
 * heavy:    Aggressive. Ignores memory pressure entirely — uses full context
 *           window. Risk of OOM on very long sessions. Best when QwenCoder
 *           is the primary app running.
 */
const MODES = {
  stable:   { label: 'Stable',   pressureWeight: 1.0, description: 'Conservative — respects memory pressure fully' },
  balanced: { label: 'Balanced', pressureWeight: 0.5, description: 'Default — halves memory pressure penalty' },
  heavy:    { label: 'Heavy',    pressureWeight: 0.0, description: 'Aggressive — ignores memory pressure, full context' },
}

/**
 * Compute a Calibration_Profile from benchmark metrics.
 * @param {object} metrics - { generation_tps, prompt_tps, peak_memory_gb, available_memory_gb, context_window }
 * @param {string} [mode='balanced'] - Performance mode: 'stable', 'balanced', or 'heavy'
 * @returns {object} Calibration_Profile
 */
function computeProfile(metrics, mode = 'balanced') {
  const { generation_tps, prompt_tps, peak_memory_gb, available_memory_gb, context_window } = metrics

  const roundedMetrics = {
    generation_tps: round2(generation_tps),
    prompt_tps: round2(prompt_tps),
    peak_memory_gb: round3(peak_memory_gb),
    available_memory_gb: round3(available_memory_gb),
    context_window,
  }

  // Memory pressure factor: smooth cosine curve that maximizes token budget
  // at low pressure and gradually reduces it as memory fills up.
  const memoryPressure = available_memory_gb > 0
    ? Math.min(1, peak_memory_gb / (peak_memory_gb + available_memory_gb))
    : 0.5
  // Cosine interpolation from 1.0 → 0.5 over the 0→1 pressure range
  const rawMemoryScale = 0.5 + 0.5 * Math.cos(memoryPressure * Math.PI)

  // Apply mode: pressureWeight controls how much memory pressure affects the budget.
  // weight=1.0 (stable) uses full pressure scaling, weight=0.0 (heavy) ignores it.
  const modeConfig = MODES[mode] || MODES.balanced
  const memoryScale = 1.0 - modeConfig.pressureWeight * (1.0 - rawMemoryScale)

  const rawTimeout = (context_window / generation_tps) * 1000 + 30000
  const timeoutPerTurn = Math.max(60000, Math.round(rawTimeout))
  const effectiveContext = Math.max(context_window, CONTEXT_WINDOW)
  const rawMaxInput = Math.round(effectiveContext * 0.85 * memoryScale)
  const maxInputTokens = Math.min(200000, Math.max(CALIBRATOR_FLOOR, rawMaxInput))
  const compactionThreshold = Math.round(maxInputTokens * 0.85)
  const maxTurns = 500
  const poolTimeout = Math.max(120000, timeoutPerTurn * 3)

  return {
    maxTurns,
    timeoutPerTurn,
    maxInputTokens,
    compactionThreshold,
    poolTimeout,
    mode,
    memoryPressure: round2(memoryPressure),
    memoryScale: round2(memoryScale),
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
    maxInputTokens: MAX_INPUT_TOKENS,
    compactionThreshold: COMPACTION_THRESHOLD,
    poolTimeout: 600000,
    metrics: null,
  }
}

function round2(n) { return Math.round(n * 100) / 100 }
function round3(n) { return Math.round(n * 1000) / 1000 }

module.exports = { computeProfile, defaultProfile, round2, round3, MODES }
