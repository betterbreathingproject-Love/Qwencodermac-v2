# Implementation Plan: Adaptive Agent Calibration

## Overview

Bottom-up implementation: pure computation module first (`calibrator.js`), then the Python benchmark endpoint, IPC plumbing, agent loop + pool integration, renderer UI (chip + dashboard), and finally wiring everything into the app lifecycle. Property tests cover the calibrator's pure functions; integration tests cover IPC and agent consumption.

## Tasks

- [x] 1. Create `calibrator.js` — pure profile computation module
  - [x] 1.1 Implement `computeProfile(metrics)` function
    - Create `calibrator.js` with `'use strict'`, CommonJS exports
    - Accept `{ generation_tps, prompt_tps, peak_memory_gb, available_memory_gb, context_window }`
    - Compute `timeoutPerTurn = max(60000, round((context_window / generation_tps) * 1000 + 30000))`
    - Compute `maxInputTokens = clamp(round(context_window * 0.6), 8000, 200000)`
    - Compute `compactionThreshold = round(maxInputTokens * 0.85)`
    - Set `maxTurns = 500`
    - Compute `poolTimeout = max(120000, timeoutPerTurn * 3)`
    - Round metrics: `generation_tps`/`prompt_tps` to 2 decimals, `peak_memory_gb`/`available_memory_gb` to 3 decimals
    - Return profile object with all computed fields plus `metrics` containing rounded values
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 7.3_

  - [x] 1.2 Implement `defaultProfile()` function
    - Return conservative fallback: `maxTurns=50, timeoutPerTurn=120000, maxInputTokens=24000, compactionThreshold=20000, poolTimeout=600000, metrics=null`
    - _Requirements: 3.3_

  - [x] 1.3 Implement `round2(n)` and `round3(n)` helper functions
    - `round2`: round to 2 decimal places
    - `round3`: round to 3 decimal places
    - Export both for testing
    - _Requirements: 7.3_


  - [x] 1.4 Write unit tests for calibrator (`test/calibrator.test.js`)
    - Test known metrics → expected profile with hand-calculated values
    - Test `defaultProfile()` returns conservative hardcoded values
    - Test `maxTurns` is always 500 for any input
    - Test edge case: very low TPS (0.1) — timeout floor of 60000 kicks in
    - Test edge case: very large context window (1000000) — maxInputTokens clamped to 200000
    - Test edge case: very small context window (100) — maxInputTokens clamped to 8000
    - Test `round2` and `round3` with specific float values
    - Use `node:test` and `node:assert/strict`
    - _Requirements: 2.1–2.6, 3.3, 7.3_

  - [x] 1.5 Write property tests for calibrator (`test/calibrator.property.test.js`)
    - **Property 1 — Formula correctness**: For random valid metrics, verify all computed fields match formulas with floors/clamps
    - **Property 2 — Deterministic computation**: For random metrics, `computeProfile(m)` called twice produces identical results
    - **Property 3 — JSON round-trip**: For random metrics, `JSON.parse(JSON.stringify(profile))` deep-equals original
    - **Property 4 — Rounding precision**: For random floats, verify decimal place counts on rounded metrics
    - Use `fast-check` with `{ numRuns: 150 }`
    - Tag each test: `Feature: adaptive-agent-calibration, Property N: ...`
    - _Requirements: 2.1–2.7, 7.1–7.3_

- [x] 2. Checkpoint — calibrator module
  - Run `npm test` to verify all calibrator tests pass. Ask user if questions arise.

- [x] 3. Add `/admin/benchmark` endpoint to `server.py`
  - [x] 3.1 Implement `BenchmarkResponse` Pydantic model and endpoint
    - Add `BenchmarkResponse` with fields: `generation_tps`, `prompt_tps`, `peak_memory_gb`, `available_memory_gb`, `context_window`
    - Add `@app.post("/admin/benchmark")` handler
    - Return 503 if `_model is None`
    - Acquire inference semaphore before running benchmark
    - Use short fixed prompt (~150 tokens), generate up to 80 tokens
    - Measure generation TPS and prompt TPS from elapsed time
    - Read peak memory and available memory from `mlx.core.mx.metal`
    - Read `context_window` from model config `max_position_embeddings` (default 32768)
    - Round values: TPS to 2 decimals, memory to 3 decimals
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 3.2 Implement Metal memory error handling
    - Catch exceptions containing "metal" or "mps" in the error message
    - Clear Metal cache via `mx.metal.clear_cache()` and run `gc.collect()`
    - Return HTTP 500 with `"Metal memory error: {detail}"`
    - For non-Metal errors, return HTTP 500 with error detail
    - _Requirements: 1.5_

- [x] 4. Create `main/ipc-calibration.js` and modify `main/ipc-server.js`
  - [x] 4.1 Add calibration state and `runCalibration()` to `ipc-server.js`
    - Add `const calibrator = require('../calibrator')` import
    - Add module-level `_calibrationProfile = null` and `_calibrating = false`
    - Implement `runCalibration(serverUrl, serverPort, mainWindow, modelId)`:
      - Set `_calibrating = true`, emit `calibration-status` with `{ status: 'calibrating' }`
      - POST to `/admin/benchmark` with 15s timeout
      - On success: compute profile via `calibrator.computeProfile(metrics)`, store in `_calibrationProfile`, emit `calibration-complete`
      - On failure: log error, set `_calibrationProfile = calibrator.defaultProfile()`, emit `calibration-complete` with `fallback: true`
      - Always set `_calibrating = false` in finally block
    - Export `getCalibrationProfile()`, `isCalibrating()`, `clearCalibration()`
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 4.2 Wire `runCalibration` into the existing `load-model` handler
    - After successful model load response, call `runCalibration(serverUrl, serverPort, mainWindow, modelId)`
    - In the `unload-model` handler, call `clearCalibration()` and emit `calibration-status` with `{ status: 'unavailable' }`
    - _Requirements: 3.1, 3.4_

  - [x] 4.3 Create `main/ipc-calibration.js` with `register()` function
    - Implement `register(ipcMain, { getCalibrationProfile, isCalibrating })`
    - `get-calibration` handler: return current profile or null
    - `calibration-status` handler: return `{ status, profile }` based on calibrating/ready/unavailable state
    - _Requirements: 6.1, 6.2_

  - [x] 4.4 Add calibration IPC channels to `preload.js`
    - Add `getCalibration`, `calibrationStatus`, `onCalibrationComplete`, `offCalibrationComplete`, `onCalibrationStatus`, `offCalibrationStatus` to the `app` context bridge
    - Follow existing naming conventions
    - _Requirements: 6.1, 6.3_


- [x] 5. Modify `direct-bridge.js` — agent loop calibration integration
  - [x] 5.1 Accept `getCalibrationProfile` callback in DirectBridge constructor
    - Add `this._getCalibrationProfile = opts.getCalibrationProfile || null` to constructor
    - _Requirements: 4.1_

  - [x] 5.2 Use calibrated settings in `_agentLoop`
    - At loop start, read profile via `this._getCalibrationProfile?.()`
    - Set `effectiveMaxTurns = profile?.maxTurns ?? maxTurns` (parameter default)
    - Set `effectiveMaxInputTokens = profile?.maxInputTokens ?? 24000`
    - Set `effectiveCompactionThreshold = profile?.compactionThreshold ?? 20000`
    - Use `effectiveMaxTurns` for loop bound and turn-warning check (`effectiveMaxTurns - 5`)
    - Use `effectiveMaxInputTokens` for context compression threshold
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 6. Modify `agent-pool.js` — pool timeout calibration integration
  - [x] 6.1 Accept `getCalibrationProfile` callback in AgentPool constructor
    - Add `this._getCalibrationProfile = options.getCalibrationProfile || null`
    - _Requirements: 5.1_

  - [x] 6.2 Use calibrated `poolTimeout` in `dispatch`
    - Read profile via `this._getCalibrationProfile?.()`
    - Timeout priority: task-specific → `profile?.poolTimeout` → `this._defaultTimeout`
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 7. Write integration tests for calibration IPC and agent consumption
  - [x] 7.1 Add calibration integration tests (`test/ipc-integration.test.js` additions)
    - Test `get-calibration` returns null before model load
    - Test `get-calibration` returns profile after calibration
    - Test `calibration-complete` event includes modelId
    - Test fallback to default profile on benchmark failure
    - Test profile cleared on model unload
    - _Requirements: 3.1–3.4, 6.1–6.3_

  - [x] 7.2 Add agent loop calibration tests (`test/direct-bridge-calibration.test.js`)
    - Test agent loop uses calibrated maxTurns from profile
    - Test agent loop uses calibrated maxInputTokens for compression
    - Test agent loop falls back to hardcoded defaults when no profile
    - Test turn warning injected at effectiveMaxTurns - 5
    - _Requirements: 4.1–4.5_

  - [x] 7.3 Add agent pool calibration tests (`test/agent-pool.test.js` additions)
    - Test pool uses calibrated poolTimeout
    - Test task-specific timeout overrides calibrated poolTimeout
    - Test pool falls back to DEFAULT_TIMEOUT when no profile
    - _Requirements: 5.1–5.3_

- [x] 8. Checkpoint — backend complete
  - Run `npm test` to verify all backend tests pass. Ask user if questions arise.

- [x] 9. Add calibration status chip to renderer
  - [x] 9.1 Add calibration chip HTML to `renderer/index.html`
    - Add `<span class="cal-chip" id="calChip">` with `<span class="cal-dot" id="calDot">` and `<span id="calText">Cal</span>` inside `titlebar-status`, after the LSP chip
    - Set initial title to "Calibration not available"
    - _Requirements: 8.1_

  - [x] 9.2 Add calibration chip CSS to `renderer/style.css`
    - Add `.cal-chip` styles matching `.lsp-chip` (inline-flex, gap, padding, border-radius, background, border, cursor)
    - Add `.cal-dot` styles matching `.lsp-dot` (5px circle, muted background)
    - Add `.cal-chip #calText` styles matching `.lsp-chip #lspText` (9px, muted, 600 weight, letter-spacing)
    - Add `.cal-chip:hover` with accent border
    - Add `.cal-popover` styles matching `.lsp-popover` pattern (fixed position, bg2, border, shadow)
    - Add `.cal-popover-header`, `.cal-popover-row`, `.cal-popover-label`, `.cal-popover-value` styles
    - _Requirements: 8.1_

  - [x] 9.3 Implement `setCalibrationStatus()` in `renderer/app.js`
    - Add module-level `_calibrationProfile = null` and `_calPopoverOpen = false`
    - Implement `setCalibrationStatus(status, profile)`:
      - Update dot color: `calibrating` → amber, `ready` → green, `unavailable` → gray
      - Update text: `Calibrating`, `Calibrated`, `Uncalibrated`
      - Update tooltip
      - Store profile if provided, clear on `unavailable`
    - _Requirements: 8.2, 8.3, 8.4, 8.6, 8.7_

  - [x] 9.4 Implement `toggleCalPopover()` in `renderer/app.js`
    - Toggle a `.cal-popover` element positioned below the chip
    - Show profile summary: Gen TPS, Prompt TPS, Max Turns, Timeout/Turn, Max Input, Compaction threshold
    - Close on outside click
    - Only open when `_calibrationProfile` is non-null
    - _Requirements: 8.5_

  - [x] 9.5 Implement `initCalibrationStatus()` in `renderer/app.js`
    - Query initial status via `window.app.calibrationStatus()`
    - Listen for `calibration-complete` events → update chip to "Calibrated" and store profile
    - Listen for `calibration-status` events → update chip to "Calibrating"
    - Wire click handler on `calChip`
    - Call from `DOMContentLoaded` init chain
    - _Requirements: 8.6, 8.7_

- [x] 10. Add calibration dashboard tab to renderer
  - [x] 10.1 Add calibration tab button and panel HTML to `renderer/index.html`
    - Add `<button class="ed-tab" data-tab="calibration" onclick="switchMainTab('calibration',this)">📊 Calibration</button>` to editor-tabs bar
    - Add `<div class="main-panel" id="mt-calibration">` panel after mt-tools with calibration-layout, header, content area, and empty state placeholder
    - _Requirements: 9.1, 9.5_

  - [x] 10.2 Add calibration dashboard CSS to `renderer/style.css`
    - Add `.calibration-layout`, `.calibration-header`, `.calibration-title`, `.calibration-subtitle` styles
    - Add `.calibration-content`, `.calibration-section`, `.calibration-section-title`, `.calibration-grid` styles
    - Add `.calibration-empty`, `.calibration-empty-icon`, `.calibration-empty-text`, `.calibration-empty-hint` styles
    - Dashboard metrics reuse existing `.stat-chip` and `.stat-label`/`.stat-val` classes
    - _Requirements: 9.7_

  - [x] 10.3 Implement `renderCalibrationDashboard(profile)` in `renderer/app.js`
    - Accept a CalibrationProfile or null
    - When null: show empty state placeholder, hide content
    - When profile provided: hide placeholder, render two sections:
      - Benchmark Results: generation_tps, prompt_tps, peak_memory_gb, available_memory_gb, context_window as stat-chips (TPS chips get accent class)
      - Computed Settings: maxTurns, timeoutPerTurn (formatted as seconds), maxInputTokens, compactionThreshold, poolTimeout (formatted as seconds) as stat-chips
    - Use `innerHTML` with stat-chip HTML template
    - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.7_

  - [x] 10.4 Wire dashboard updates to calibration events
    - In `initCalibrationStatus()`, call `renderCalibrationDashboard(profile)` on `calibration-complete`
    - Implement `clearCalibrationUI()` that resets chip and dashboard — call on model unload
    - On initial load, if profile exists, render dashboard immediately
    - _Requirements: 9.6_

  - [x] 10.5 Write property test for dashboard rendering (`test/calibrator.property.test.js` addition)
    - **Property 5 — Dashboard renders all profile values**: For random valid profiles, verify rendered HTML contains all metric and setting values
    - Generate random CalibrationProfiles via `computeProfile` with random metrics
    - Mock DOM with minimal `document.getElementById` stubs
    - Call `renderCalibrationDashboard(profile)`, inspect `innerHTML`
    - Verify all 10 values appear as strings in the output
    - Use `fast-check` with `{ numRuns: 150 }`
    - Tag: `Feature: adaptive-agent-calibration, Property 5: Dashboard renders all profile values`
    - _Requirements: 9.3, 9.4_

- [x] 11. Wire calibration into app lifecycle in `main.js`
  - [x] 11.1 Register calibration IPC handlers in `main.js`
    - Import `main/ipc-calibration.js`
    - Call `ipcCalibration.register(ipcMain, { getCalibrationProfile, isCalibrating })` during app setup
    - Pass `getCalibrationProfile` and `isCalibrating` from `ipc-server.js` exports
    - _Requirements: 6.1_

  - [x] 11.2 Pass `getCalibrationProfile` to DirectBridge and AgentPool
    - When constructing DirectBridge instances, pass `{ getCalibrationProfile }` in options
    - When constructing AgentPool, pass `{ getCalibrationProfile }` in options
    - _Requirements: 4.1, 5.1_

- [x] 12. Final checkpoint — full integration
  - Run `npm test` to verify all tests pass
  - Manually verify: load model → chip turns amber then green → click chip shows popover → calibration tab shows metrics → unload model → chip resets
