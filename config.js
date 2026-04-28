'use strict'

/**
 * Central configuration for context window and token budgets.
 * Single source of truth — change values here and everything adjusts.
 *
 * To override at runtime, set environment variables:
 *   CTX_WINDOW=131072 npm start
 */

const CONTEXT_WINDOW = parseInt(process.env.CTX_WINDOW, 10) || 84000
const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_OUTPUT_TOKENS, 10) || 32768

module.exports = {
  // Total context budget in tokens
  CONTEXT_WINDOW,

  // Max generation/output tokens
  MAX_OUTPUT_TOKENS,

  // Prompt budget = 90% of context window (leaves room for output + overhead)
  PROMPT_LIMIT: Math.floor(CONTEXT_WINDOW * 0.9),

  // Client-side input token budget (slightly below prompt limit for safety)
  MAX_INPUT_TOKENS: Math.floor(CONTEXT_WINDOW * 0.85),

  // Compaction triggers at 65% of context window — fires early enough to
  // give the compactor room to work before hitting the hard ceiling.
  // Previously 80% which meant compaction only kicked in at ~67k tokens,
  // too late to prevent the slowdown from large context processing.
  COMPACTION_THRESHOLD: Math.floor(CONTEXT_WINDOW * 0.65),

  // Pre-send guard: hard cap before sending to server
  PRE_SEND_LIMIT: Math.floor(CONTEXT_WINDOW * 0.88),

  // Tool output truncation limits (chars)
  READ_FILE_TRUNCATE: Math.floor(CONTEXT_WINDOW * 4 * 0.4),  // ~134K chars — 40% of context budget in chars
  TOOL_OUTPUT_TRUNCATE: 16000,

  // Calibrator floor — memory pressure can reduce budget but never below this
  CALIBRATOR_FLOOR: Math.floor(CONTEXT_WINDOW * 0.4),

  // Rewind store settings
  REWIND_MAX_ENTRIES: 1000,
  REWIND_TTL_MS: 120 * 60 * 1000, // 2 hours
}
