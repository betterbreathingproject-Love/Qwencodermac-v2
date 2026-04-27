# Design Document: Adaptive Agent Calibration

## Overview

Adaptive Agent Calibration introduces automatic model benchmarking and dynamic settings computation into QwenCoder Mac Studio. When a model is loaded, the system runs a short benchmark pass on the MLX server, measures generation TPS, prompt TPS, memory usage, and context window size, then computes optimal agent loop settings (maxTurns, timeoutPerTurn, maxInputTokens, compactionThreshold, poolTimeout). These replace the existing hardcoded constants throughout the agent pipeline.

The feature touches these modules:

- **New**: `calibrator.js` — computes Calibration_Profile from benchmark metrics
- **New**: `main/ipc-calibration.js` — IPC handlers for calibration retrieval and events
- **Modified**: `server.py` — adds `/admin/benchmark` FastAPI endpoint
- **Modified**: `main/ipc-server.js` — triggers benchmark after model load, stores profile, emits events
- **Modified**: `direct-bridge.js` — reads calibrated settings in `_agentLoop` instead of hardcoded constants
- **Modified**: `agent-pool.js` — reads calibrated `poolTimeout` for dispatch timeouts
- **Modified**: `preload.js` — exposes calibration IPC channels to renderer
- **Modified**: `renderer/index.html` — adds calibration status chip and calibration dashboard tab
- **Modified**: `renderer/app.js` — calibration chip logic, dashboard rendering, event listeners
- **Modified**: `renderer/style.css` — calibration chip and dashboard styling

The design follows existing codebase conventions: CommonJS modules, `'use strict'`, vanilla DOM manipulation in the renderer, and no new external dependencies.

## Architecture

```mermaid
graph TD
    subgraph Python Backend
        SE[server.py] --> BE[/admin/benchmark endpoint]
    end

    subgraph Electron Main Process
        IS[main/ipc-server.js] -->|POST /admin/benchmark| BE
        IS -->|metrics| CAL[calibrator.js]
        CAL -->|Calibration_Profile| IS
        IS -->|stores profile| IS
        IS -->|calibration-complete event| PL[preload.js]
        IC[main/ipc-calibration.js] -->|get-calibration| IS
        DB[direct-bridge.js] -->|reads profile| IS
        AP[agent-pool.js] -->|reads poolTimeout| IS
    end

    subgraph Electron Renderer
        PL -->|IPC| R[renderer/app.js]
        R --> CHIP[Calibration Status Chip]
        R --> DASH[Calibration Dashboard Tab]
    end
```

### Data Flow

1. **Model Load**: User loads a model via the sidebar. `ipc-server.js` `load-model` handler sends POST to `/admin/load`, waits for success, then sends POST to `/admin/benchmark`.

2. **Benchmark**: The MLX server runs a short inference pass (~100 tokens) using the loaded model, measures generation TPS, prompt TPS, peak memory, available memory, and reads the model's context window from config. Returns JSON metrics.

3. **Calibration**: `ipc-server.js` passes the benchmark metrics to `calibrator.computeProfile(metrics)`, which returns a `Calibration_Profile` object with all computed settings plus the raw metrics.

4. **Storage & Events**: `ipc-server.js` stores the profile in a module-level variable and emits `calibration-complete` to the renderer via `mainWindow.webContents.send()`.

5. **Agent Loop Consumption**: When `DirectBridge._agentLoop` starts, it reads the current profile from `ipc-server.js` (via a getter function injected at construction) and uses `maxTurns`, `maxInputTokens`, and `compactionThreshold` instead of hardcoded values.

6. **Agent Pool Consumption**: When `AgentPool.dispatch` calculates the timeout, it reads `poolTimeout` from the current profile (via a getter callback), falling back to `DEFAULT_TIMEOUT` if no profile exists.

7. **Renderer Updates**: The renderer listens for `calibration-complete` events to update the status chip and dashboard tab. It can also query the current profile on demand via `get-calibration` IPC.

## Components and Interfaces

### server.py — `/admin/benchmark` endpoint

```python
# New endpoint added to the FastAPI app

class BenchmarkResponse(BaseModel):
    generation_tps: float
    prompt_tps: float
    peak_memory_gb: float
    available_memory_gb: float
    context_window: int

@app.post("/admin/benchmark")
async def benchmark():
    """Run a short inference pass and return performance metrics."""
    if _model is None:
        raise HTTPException(status_code=503, detail="No model loaded")
    
    sem = _get_inference_semaphore()
    async with sem:
        try:
            # Use a short fixed prompt (under 200 tokens)
            prompt_tokens = _tokenize(BENCHMARK_PROMPT)  # ~150 tokens
            
            start = time.perf_counter()
            # Generate up to 80 tokens
            output = _generate(prompt_tokens, max_tokens=80)
            elapsed = time.perf_counter() - start
            
            gen_tps = len(output) / elapsed if elapsed > 0 else 0
            prompt_tps = len(prompt_tokens) / elapsed if elapsed > 0 else 0
            
            import mlx.core as mx
            peak_mem = mx.metal.get_peak_memory() / (1024**3)
            avail_mem = mx.metal.get_cache_memory() / (1024**3)  # approximate available
            
            ctx_window = _config.get("max_position_embeddings", 32768)
            
            return BenchmarkResponse(
                generation_tps=round(gen_tps, 2),
                prompt_tps=round(prompt_tps, 2),
                peak_memory_gb=round(peak_mem, 3),
                available_memory_gb=round(avail_mem, 3),
                context_window=ctx_window,
            )
        except Exception as e:
            # Handle Metal memory errors specifically
            if "metal" in str(e).lower() or "mps" in str(e).lower():
                try:
                    mx.metal.clear_cache()
                    import gc; gc.collect()
                except:
                    pass
                raise HTTPException(status_code=500, detail=f"Metal memory error: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))
```

### calibrator.js

```javascript
// New module — pure computation, no side effects
'use strict'

/**
 * Compute a Calibration_Profile from benchmark metrics.
 * @param {object} metrics - { generation_tps, prompt_tps, peak_memory_gb, available_memory_gb, context_window }
 * @returns {object} Calibration_Profile
 */
function computeProfile(metrics) {
  const { generation_tps, prompt_tps, peak_memory_gb, available_memory_gb, context_window } = metrics

  // Round raw metrics for consistency
  const roundedMetrics = {
    generation_tps: round2(generation_tps),
    prompt_tps: round2(prompt_tps),
    peak_memory_gb: round3(peak_memory_gb),
    available_memory_gb: round3(available_memory_gb),
    context_window,
  }

  // timeoutPerTurn = (context_window / generation_tps) * 1000 + 30000, min 60000
  const rawTimeout = (context_window / generation_tps) * 1000 + 30000
  const timeoutPerTurn = Math.max(60000, Math.round(rawTimeout))

  // maxInputTokens = context_window * 0.6, clamped [8000, 200000]
  const maxInputTokens = Math.min(200000, Math.max(8000, Math.round(context_window * 0.6)))

  // compactionThreshold = maxInputTokens * 0.85
  const compactionThreshold = Math.round(maxInputTokens * 0.85)

  // maxTurns = 500 (safety valve)
  const maxTurns = 500

  // poolTimeout = timeoutPerTurn * 3, min 120000
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
```

### main/ipc-server.js modifications

```javascript
// Added to the existing ipc-server.js module

const calibrator = require('../calibrator')

// Module-level state
let _calibrationProfile = null
let _calibrating = false

// New: benchmark + calibrate after model load
// Inside the existing 'load-model' handler, after successful load:
async function runCalibration(serverUrl, serverPort, mainWindow, modelId) {
  _calibrating = true
  mainWindow?.webContents.send('calibration-status', { status: 'calibrating' })
  
  try {
    const metrics = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: serverPort,
        path: '/admin/benchmark', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        let d = ''
        res.on('data', c => d += c)
        res.on('end', () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(d)) } catch { reject(new Error('Invalid benchmark response')) }
          } else {
            reject(new Error(`Benchmark failed: HTTP ${res.statusCode}`))
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Benchmark timed out')) })
      req.end()
    })

    _calibrationProfile = calibrator.computeProfile(metrics)
    mainWindow?.webContents.send('calibration-complete', {
      modelId,
      profile: _calibrationProfile,
    })
  } catch (err) {
    console.log(`[main] Calibration failed: ${err.message}, using defaults`)
    _calibrationProfile = calibrator.defaultProfile()
    mainWindow?.webContents.send('calibration-complete', {
      modelId,
      profile: _calibrationProfile,
      fallback: true,
    })
  } finally {
    _calibrating = false
  }
}

// Getter for other modules to read the current profile
function getCalibrationProfile() {
  return _calibrationProfile
}

function isCalibrating() {
  return _calibrating
}

// Clear profile on model unload
function clearCalibration() {
  _calibrationProfile = null
}
```

### main/ipc-calibration.js

```javascript
// New IPC handler module for calibration queries
'use strict'

function register(ipcMain, { getCalibrationProfile, isCalibrating }) {
  ipcMain.handle('get-calibration', async () => {
    return getCalibrationProfile() || null
  })

  ipcMain.handle('calibration-status', async () => {
    const profile = getCalibrationProfile()
    return {
      status: isCalibrating() ? 'calibrating' : (profile ? 'ready' : 'unavailable'),
      profile: profile || null,
    }
  })
}

module.exports = { register }
```

### direct-bridge.js modifications

```javascript
// In DirectBridge constructor — accept a calibration profile getter
constructor(sink, opts = {}) {
  // ... existing code ...
  this._getCalibrationProfile = opts.getCalibrationProfile || null
}

// In _agentLoop — use calibrated settings
async _agentLoop(messages, cwd, model, maxTurns = 50) {
  // Read calibrated settings if available
  const profile = this._getCalibrationProfile?.()
  const effectiveMaxTurns = profile?.maxTurns ?? maxTurns
  const effectiveMaxInputTokens = profile?.maxInputTokens ?? 24000
  const effectiveCompactionThreshold = profile?.compactionThreshold ?? 20000

  for (let turn = 0; turn < effectiveMaxTurns; turn++) {
    // ... existing abort check ...

    // Warn near end of turns (uses effectiveMaxTurns instead of maxTurns)
    if (turn === effectiveMaxTurns - 5) {
      messages.push({
        role: 'system',
        content: 'NOTICE: You have only 5 tool turns remaining. Wrap up your current task...',
      })
    }

    // Context compression uses effectiveMaxInputTokens instead of hardcoded 24000
    if (estimateMessagesTokens(messages) > effectiveMaxInputTokens) {
      // ... existing compaction logic, using effectiveMaxInputTokens ...
    }
    // ... rest of loop unchanged ...
  }
}
```

### agent-pool.js modifications

```javascript
// In AgentPool constructor — accept calibration profile getter
constructor(options = {}) {
  // ... existing code ...
  this._getCalibrationProfile = options.getCalibrationProfile || null
}

// In dispatch — use calibrated poolTimeout
async dispatch(task, context, options = {}) {
  const agentType = this.selectType(task)
  // Task-specific timeout takes priority, then calibrated, then default
  const profile = this._getCalibrationProfile?.()
  const timeout = agentType?.timeout
    ?? profile?.poolTimeout
    ?? this._defaultTimeout
  // ... rest of dispatch unchanged ...
}
```

### preload.js additions

```javascript
// Calibration
getCalibration:       ()   => ipcRenderer.invoke('get-calibration'),
calibrationStatus:    ()   => ipcRenderer.invoke('calibration-status'),
onCalibrationComplete:(cb) => ipcRenderer.on('calibration-complete', (_, d) => cb(d)),
offCalibrationComplete:()  => ipcRenderer.removeAllListeners('calibration-complete'),
onCalibrationStatus:  (cb) => ipcRenderer.on('calibration-status', (_, d) => cb(d)),
offCalibrationStatus: ()   => ipcRenderer.removeAllListeners('calibration-status'),
```

### renderer/index.html — Calibration Status Chip

The calibration chip is placed immediately after the existing LSP chip inside the `titlebar-status` div. It follows the identical HTML structure as the LSP chip: a container `<span>` with a colored dot `<span>` and a text label `<span>`.

```html
<!-- Inside .titlebar-status, right after the lspChip span -->
<span class="cal-chip" id="calChip" title="Calibration not available">
  <span class="cal-dot" id="calDot"></span>
  <span id="calText">Cal</span>
</span>
```

Full `titlebar-status` context after modification:

```html
<div class="titlebar-status">
  <span class="status-dot" id="statusDot"></span>
  <span id="statusText">Starting...</span>
  <span class="lsp-chip" id="lspChip" title="LSP not available — install agent-lsp binary">
    <span class="lsp-dot" id="lspDot"></span>
    <span id="lspText">LSP</span>
  </span>
  <span class="cal-chip" id="calChip" title="Calibration not available">
    <span class="cal-dot" id="calDot"></span>
    <span id="calText">Cal</span>
  </span>
</div>
```

### renderer/index.html — Calibration Dashboard Tab

A new tab button is added to the `editor-tabs` bar, and a new `main-panel` div is added after the Tools tab panel.

Tab button (added after the Tools tab button):

```html
<div class="editor-tabs" id="editorTabs">
  <button class="ed-tab active" data-tab="agent" onclick="switchMainTab('agent',this)">💻 Agent</button>
  <button class="ed-tab" data-tab="editor" onclick="switchMainTab('editor',this)">📝 Editor</button>
  <button class="ed-tab" data-tab="vision" onclick="switchMainTab('vision',this)">👁 Vision</button>
  <button class="ed-tab" data-tab="tools" onclick="switchMainTab('tools',this)">🔧 Tools</button>
  <button class="ed-tab" data-tab="calibration" onclick="switchMainTab('calibration',this)">📊 Calibration</button>
</div>
```

Tab panel (added after the `mt-tools` panel, before the closing `</div>` of the main area):

```html
<!-- CALIBRATION TAB -->
<div class="main-panel" id="mt-calibration">
  <div class="calibration-layout">
    <div class="calibration-header">
      <span class="calibration-title">📊 Calibration Dashboard</span>
      <span class="calibration-subtitle">Model benchmark results and computed agent settings</span>
    </div>
    <div class="calibration-content" id="calibrationContent">
      <div class="calibration-empty" id="calibrationEmpty">
        <div class="calibration-empty-icon">📊</div>
        <div class="calibration-empty-text">No calibration data available</div>
        <div class="calibration-empty-hint">Load a model to trigger automatic calibration</div>
      </div>
    </div>
  </div>
</div>
```

The `switchMainTab` function already handles arbitrary tab names via `document.getElementById('mt-' + name)`, so no changes are needed to the tab switching logic.

### renderer/style.css — Calibration Chip Styling

The calibration chip reuses the same visual pattern as the LSP chip. All class names are prefixed `cal-` to avoid collisions.

```css
/* ── calibration status chip ───────────────────────────────────────────────── */
.cal-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 8px; background: var(--bg3); border: 1px solid var(--border); cursor: pointer; position: relative; }
.cal-chip:hover { border-color: var(--accent); }
.cal-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--muted); }
.cal-chip #calText { font-size: 9px; color: var(--muted); font-weight: 600; letter-spacing: 0.5px; }

/* calibration popover */
.cal-popover { position: fixed; z-index: 9999; min-width: 220px; max-width: 300px; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,0.5); padding: 8px 0; font-size: 11px; }
.cal-popover-header { padding: 4px 10px 6px; font-size: 9px; font-weight: 600; letter-spacing: 0.08em; color: var(--muted); text-transform: uppercase; border-bottom: 1px solid var(--border); }
.cal-popover-row { padding: 4px 10px; display: flex; justify-content: space-between; align-items: center; }
.cal-popover-row + .cal-popover-row { border-top: 1px solid rgba(255,255,255,0.03); }
.cal-popover-label { font-size: 10px; color: var(--muted); }
.cal-popover-value { font-size: 11px; font-weight: 600; color: var(--text); font-family: 'SF Mono', monospace; }
```

### renderer/style.css — Calibration Dashboard Styling

The dashboard layout follows the same pattern as the tools tab. Individual metrics use the existing `stat-chip` pattern from the agent stats bar.

```css
/* ── calibration dashboard ─────────────────────────────────────────────────── */
.calibration-layout { display: flex; flex-direction: column; height: 100%; overflow-y: auto; }
.calibration-header { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.calibration-title { font-size: 14px; font-weight: 600; color: var(--text); }
.calibration-subtitle { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; }
.calibration-content { padding: 12px 16px; flex: 1; overflow-y: auto; }
.calibration-section { margin-bottom: 16px; }
.calibration-section-title { font-size: 9px; font-weight: 600; letter-spacing: 0.1em; color: var(--muted); text-transform: uppercase; margin-bottom: 8px; }
.calibration-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.calibration-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; color: var(--muted); }
.calibration-empty-icon { font-size: 32px; margin-bottom: 8px; opacity: 0.5; }
.calibration-empty-text { font-size: 13px; font-weight: 500; }
.calibration-empty-hint { font-size: 11px; margin-top: 4px; }
```

### renderer/app.js — Calibration Chip Logic

Module-level state and the `setCalibrationStatus` function, following the same pattern as `setLspStatus`:

```javascript
// ── calibration state ─────────────────────────────────────────────────────────
let _calibrationProfile = null
let _calPopoverOpen = false

function setCalibrationStatus(status, profile) {
  const chip = document.getElementById('calChip')
  const dot  = document.getElementById('calDot')
  const txt  = document.getElementById('calText')
  if (!chip) return

  chip.style.display = 'inline-flex'

  const colors = {
    calibrating:  '#f5a623',       // amber
    ready:        'var(--green)',   // green
    unavailable:  'var(--muted)',   // gray
  }
  dot.style.background = colors[status] || 'var(--muted)'

  const labels = {
    calibrating:  'Calibrating',
    ready:        'Calibrated',
    unavailable:  'Uncalibrated',
  }
  txt.textContent = labels[status] || 'Cal'

  const tooltips = {
    calibrating:  'Calibration in progress...',
    ready:        'Model calibrated — click for details',
    unavailable:  'No calibration data — load a model to calibrate',
  }
  chip.title = tooltips[status] || 'Calibration'

  if (profile) _calibrationProfile = profile
  if (status === 'unavailable') _calibrationProfile = null
}
```

Click handler for the calibration chip popover:

```javascript
function toggleCalPopover() {
  const chip = document.getElementById('calChip')
  if (!chip) return

  const existing = document.querySelector('.cal-popover')
  if (existing) {
    existing.remove()
    _calPopoverOpen = false
    return
  }
  if (!_calibrationProfile) return

  _calPopoverOpen = true
  const pop = document.createElement('div')
  pop.className = 'cal-popover'

  const p = _calibrationProfile
  const m = p.metrics || {}

  let html = `<div class="cal-popover-header">Calibration Profile</div>`
  const rows = [
    ['Gen TPS',       m.generation_tps != null ? m.generation_tps + ' tk/s' : '—'],
    ['Prompt TPS',    m.prompt_tps != null ? m.prompt_tps + ' tk/s' : '—'],
    ['Max Turns',     p.maxTurns],
    ['Timeout/Turn',  (p.timeoutPerTurn / 1000).toFixed(0) + 's'],
    ['Max Input',     p.maxInputTokens?.toLocaleString() + ' tok'],
    ['Compaction @',  p.compactionThreshold?.toLocaleString() + ' tok'],
  ]
  for (const [label, value] of rows) {
    html += `<div class="cal-popover-row"><span class="cal-popover-label">${label}</span><span class="cal-popover-value">${value}</span></div>`
  }
  pop.innerHTML = html

  // Position below the chip
  const rect = chip.getBoundingClientRect()
  pop.style.top = (rect.bottom + 4) + 'px'
  pop.style.right = (window.innerWidth - rect.right) + 'px'
  document.body.appendChild(pop)

  // Close on outside click
  setTimeout(() => {
    const close = (e) => {
      if (!pop.contains(e.target) && !chip.contains(e.target)) {
        pop.remove()
        _calPopoverOpen = false
        document.removeEventListener('click', close)
      }
    }
    document.addEventListener('click', close)
  }, 0)
}
```

Initialization and event listeners (called from `DOMContentLoaded`):

```javascript
async function initCalibrationStatus() {
  if (!window.app.calibrationStatus) return

  try {
    const s = await window.app.calibrationStatus()
    setCalibrationStatus(s.status, s.profile)
  } catch { /* ignore */ }

  // Listen for calibration-complete events from main process
  window.app.onCalibrationComplete(({ modelId, profile, fallback }) => {
    setCalibrationStatus('ready', profile)
    renderCalibrationDashboard(profile)
  })

  // Listen for calibration-status events (calibrating state)
  window.app.onCalibrationStatus(({ status }) => {
    setCalibrationStatus(status, null)
  })

  // Wire click handler
  const chip = document.getElementById('calChip')
  if (chip) chip.addEventListener('click', toggleCalPopover)
}
```

### renderer/app.js — Calibration Dashboard Rendering

The `renderCalibrationDashboard` function populates the `mt-calibration` panel with benchmark metrics and computed settings using the existing `stat-chip` pattern:

```javascript
function renderCalibrationDashboard(profile) {
  const content = document.getElementById('calibrationContent')
  const empty = document.getElementById('calibrationEmpty')
  if (!content) return

  if (!profile) {
    if (empty) empty.style.display = 'flex'
    return
  }
  if (empty) empty.style.display = 'none'

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

  content.innerHTML = `
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
```

Model unload handling — resets both chip and dashboard:

```javascript
// Called when model is unloaded (wire into existing model-unload listener)
function clearCalibrationUI() {
  setCalibrationStatus('unavailable', null)
  renderCalibrationDashboard(null)
}
```

## Data Models

### BenchmarkMetrics (Python → JSON → JS)

Returned by the `/admin/benchmark` endpoint and consumed by `calibrator.computeProfile()`:

```javascript
{
  generation_tps: number,      // tokens/sec during generation, rounded to 2 decimals
  prompt_tps: number,          // tokens/sec during prompt processing, rounded to 2 decimals
  peak_memory_gb: number,      // peak Metal memory in GB, rounded to 3 decimals
  available_memory_gb: number, // available Metal cache memory in GB, rounded to 3 decimals
  context_window: number,      // max position embeddings from model config (integer)
}
```

### CalibrationProfile (JS object, JSON-serializable)

Produced by `calibrator.computeProfile()`, stored in `ipc-server.js`, transmitted via IPC:

```javascript
{
  maxTurns: number,              // safety valve turn limit (default: 500)
  timeoutPerTurn: number,        // ms per turn, min 60000
  maxInputTokens: number,        // context_window * 0.6, clamped [8000, 200000]
  compactionThreshold: number,   // maxInputTokens * 0.85
  poolTimeout: number,           // timeoutPerTurn * 3, min 120000
  metrics: BenchmarkMetrics | null,  // raw metrics that produced this profile (null for defaults)
}
```

### CalibrationEvent (IPC payload, renderer-bound)

Emitted via `mainWindow.webContents.send('calibration-complete', payload)`:

```javascript
{
  modelId: string,               // identifier of the calibrated model
  profile: CalibrationProfile,   // the computed profile
  fallback?: boolean,            // true if benchmark failed and defaults were used
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Profile computation formulas are correct

*For any* valid benchmark metrics (generation_tps > 0, prompt_tps > 0, peak_memory_gb ≥ 0, available_memory_gb ≥ 0, context_window > 0), `computeProfile(metrics)` SHALL return a profile where:
- `timeoutPerTurn` equals `max(60000, round((context_window / generation_tps) * 1000 + 30000))`
- `maxInputTokens` equals `clamp(round(context_window * 0.6), 8000, 200000)`
- `compactionThreshold` equals `round(maxInputTokens * 0.85)`
- `maxTurns` equals `500`
- `poolTimeout` equals `max(120000, timeoutPerTurn * 3)`
- `metrics` contains the rounded input metrics

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**

### Property 2: Profile computation is deterministic (idempotent)

*For any* valid benchmark metrics, computing a profile twice from the same metrics SHALL produce deeply equal results — `computeProfile(m)` is a pure function with no hidden state.

**Validates: Requirements 2.7**

### Property 3: Calibration profile JSON round-trip

*For any* valid benchmark metrics, computing a profile, serializing it with `JSON.stringify`, and parsing it back with `JSON.parse` SHALL produce an object deeply equal to the original profile. This ensures all profile fields are JSON-safe types.

**Validates: Requirements 7.1, 7.2**

### Property 4: Metric rounding precision

*For any* floating-point benchmark metrics, the profile's `metrics.generation_tps` and `metrics.prompt_tps` SHALL have at most 2 decimal places, and `metrics.peak_memory_gb` and `metrics.available_memory_gb` SHALL have at most 3 decimal places.

**Validates: Requirements 7.3**

### Property 5: Dashboard renders all profile values

*For any* valid CalibrationProfile, calling `renderCalibrationDashboard(profile)` SHALL produce HTML output that contains string representations of all five benchmark metric values (`generation_tps`, `prompt_tps`, `peak_memory_gb`, `available_memory_gb`, `context_window`) and all five computed setting values (`maxTurns`, `timeoutPerTurn`, `maxInputTokens`, `compactionThreshold`, `poolTimeout`).

**Validates: Requirements 9.3, 9.4**

## Error Handling

### Benchmark Endpoint Errors

| Condition | Response | Recovery |
|---|---|---|
| No model loaded | HTTP 503, `"No model loaded"` | Caller retries after model load |
| Metal memory error | HTTP 500, clears Metal cache + GC, returns memory state | Caller falls back to default profile |
| General inference error | HTTP 500 with error detail | Caller falls back to default profile |
| Benchmark exceeds 15s | Request timeout (client-side) | Caller falls back to default profile |

### Calibration Failures

When `runCalibration` in `ipc-server.js` catches any error (network, timeout, parse, server error), it:
1. Logs the error to console
2. Sets `_calibrationProfile` to `calibrator.defaultProfile()` (conservative hardcoded values)
3. Emits `calibration-complete` with `fallback: true` so the renderer can indicate degraded state
4. Resets `_calibrating` to `false`

### Agent Loop Fallbacks

When no `CalibrationProfile` is available (getter returns `null`):
- `_agentLoop` uses existing hardcoded defaults: `maxTurns=50`, `MAX_INPUT_TOKENS=24000`
- `AgentPool.dispatch` uses `DEFAULT_TIMEOUT=600000`

This ensures the system is always functional, even before the first model load.

### Renderer Resilience

- `setCalibrationStatus` and `renderCalibrationDashboard` guard against missing DOM elements (`if (!chip) return`)
- The popover only opens when `_calibrationProfile` is non-null
- The dashboard shows a placeholder message when no profile is available
- Event listeners are registered with `try/catch` to avoid breaking the renderer init chain

## Testing Strategy

### Property-Based Tests (`test/calibrator.property.test.js`)

Using `fast-check` v4 with `{ numRuns: 150 }` per property. Each test references its design property.

| Test | Design Property | What it generates | What it asserts |
|---|---|---|---|
| Formula correctness | Property 1 | Random valid metrics (tps > 0, memory ≥ 0, context > 0) | All computed fields match formulas with floors/clamps |
| Deterministic computation | Property 2 | Random valid metrics | `computeProfile(m)` called twice produces identical results |
| JSON round-trip | Property 3 | Random valid metrics → profile | `JSON.parse(JSON.stringify(profile))` deep-equals original |
| Rounding precision | Property 4 | Random floats for tps and memory | Decimal place counts on rounded metrics |
| Dashboard rendering | Property 5 | Random valid profiles | Rendered HTML contains all metric and setting values |

### Unit Tests (`test/calibrator.test.js`)

| Test | What it covers | Requirements |
|---|---|---|
| Known metrics → expected profile | Specific example with hand-calculated values | 2.1–2.6 |
| `defaultProfile()` returns conservative values | Verify fallback constants | 3.3 |
| `maxTurns` is always 500 | Constant check | 2.4 |
| Edge: very low TPS (0.1) | Timeout floor kicks in | 2.1 |
| Edge: very large context window (1M) | maxInputTokens clamped to 200000 | 2.2 |
| Edge: very small context window (100) | maxInputTokens clamped to 8000 | 2.2 |
| `round2` and `round3` helpers | Specific rounding examples | 7.3 |

### Integration Tests (`test/ipc-integration.test.js` additions)

| Test | What it covers | Requirements |
|---|---|---|
| `get-calibration` returns null before model load | IPC handler | 6.1 |
| `get-calibration` returns profile after calibration | IPC handler | 6.1, 6.2 |
| `calibration-complete` event includes modelId | Event payload shape | 6.3 |
| Agent loop uses calibrated maxTurns | Profile consumption | 4.1 |
| Agent loop falls back to defaults | No profile scenario | 4.4 |
| Agent pool uses calibrated poolTimeout | Profile consumption | 5.1 |
| Task-specific timeout overrides poolTimeout | Priority logic | 5.2 |

### UI Tests (manual verification)

| Scenario | What to verify | Requirements |
|---|---|---|
| App launch, no model | Chip shows gray "Uncalibrated", dashboard shows placeholder | 8.4, 9.5 |
| Load model | Chip flashes amber "Calibrating", then green "Calibrated" | 8.2, 8.3 |
| Click calibrated chip | Popover shows profile summary | 8.5 |
| Switch to Calibration tab | Dashboard shows benchmark + settings sections | 9.2, 9.3, 9.4 |
| Unload model | Chip resets to gray, dashboard shows placeholder | 8.7, 9.5 |
