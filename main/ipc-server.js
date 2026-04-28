'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const calibrator = require('../calibrator')
const config = require('../config')

// ── calibration state ─────────────────────────────────────────────────────────
let _calibrationProfile = null
let _calibrating = false

// ── validation helpers ────────────────────────────────────────────────────────
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0 }
function isValidPort(v) { return Number.isInteger(v) && v > 0 && v < 65536 }

// ── python discovery ──────────────────────────────────────────────────────────
function findPython() {
  for (const p of [
    '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',
    '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3',
  ]) {
    try { if (p === 'python3' || fs.existsSync(p)) return p } catch {}
  }
  return 'python3'
}

function getServerScript(appDir) {
  const packed = path.join(process.resourcesPath || '', 'server.py')
  const dev = path.join(appDir, 'server.py')
  try {
    if (fs.existsSync(packed)) return packed
  } catch {}
  return dev
}

// ── server lifecycle ──────────────────────────────────────────────────────────
let serverProcess = null
let _serverStopping = false

function startServer(port, appDir, mainWindow) {
  if (serverProcess) return
  _serverStopping = false
  killStaleServer(port)
  const py = findPython()
  const script = getServerScript(appDir)
  console.log(`[main] Starting server: ${py} ${script} --port ${port}`)
  serverProcess = spawn(py, [script, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Allow Metal to use more unified memory before triggering OOM
      PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.0',
      // Reduce MLX memory pool fragmentation
      MLX_METAL_PREALLOCATE: '0',
    },
  })
  serverProcess.stdout.on('data', d => {
    mainWindow?.webContents.send('server-log', d.toString().trim())
  })
  serverProcess.stderr.on('data', d => {
    mainWindow?.webContents.send('server-log', d.toString().trim())
  })
  serverProcess.on('exit', (code) => {
    serverProcess = null
    console.log(`[main] Server exited with code ${code}`)
    mainWindow?.webContents.send('server-status', { running: false })
    if (!_serverStopping && code !== 0 && code !== null) {
      console.log(`[main] Server crashed (code ${code}), restarting in 2s...`)
      mainWindow?.webContents.send('server-log', `⚠️ Server crashed (code ${code}), restarting...`)
      setTimeout(() => { if (!_serverStopping) startServer(port, appDir, mainWindow) }, 2000)
    }
  })
}

function stopServer() {
  _serverStopping = true
  if (serverProcess) {
    const proc = serverProcess
    serverProcess = null
    try { proc.kill('SIGTERM') } catch {}
    // Force kill after 2s if still alive
    setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 2000)
  }
}

/**
 * Restart the server (stop then start). Resets the _serverStopping flag
 * so auto-restart logic works correctly after the new process is spawned.
 */
function restartServer(port, appDir, mainWindow) {
  stopServer()
  // Give the old process time to release the port before starting fresh
  setTimeout(() => {
    _serverStopping = false
    startServer(port, appDir, mainWindow)
  }, 1500)
}

/**
 * Kill any existing process on the target port before starting.
 * Prevents "address already in use" from stale processes.
 */
function killStaleServer(port) {
  try {
    const { execSync } = require('child_process')
    const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf-8', timeout: 3000 }).trim()
    if (pids) {
      for (const pid of pids.split('\n')) {
        try { process.kill(Number(pid), 'SIGKILL') } catch {}
      }
      console.log(`[main] Killed stale process(es) on port ${port}: ${pids.replace(/\n/g, ', ')}`)
    }
  } catch {
    // lsof returns non-zero when no process found — that's fine
  }
}

function waitForServer(serverUrl) {
  return new Promise((resolve) => {
    let attempts = 0
    const maxAttempts = 30
    const check = () => {
      if (attempts >= maxAttempts) return resolve(false)
      attempts++
      const req = http.get(`${serverUrl}/admin/status`, r => {
        // Drain the response body so the socket is freed
        r.resume()
        if (r.statusCode === 200) resolve(true)
        else setTimeout(check, 500)
      })
      req.on('error', () => setTimeout(check, 500))
      // Prevent the request from hanging indefinitely on a single attempt
      req.setTimeout(3000, () => { req.destroy(); setTimeout(check, 500) })
    }
    check()
  })
}

// ── calibration ───────────────────────────────────────────────────────────────
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

function getCalibrationProfile() {
  return _calibrationProfile
}

function isCalibrating() {
  return _calibrating
}

function clearCalibration() {
  _calibrationProfile = null
}

// ── IPC registration ──────────────────────────────────────────────────────────
function register(ipcMain, { getServerUrl, getServerPort, getMainWindow, appDir }) {
  const serverUrl = getServerUrl
  const serverPort = getServerPort

  ipcMain.handle('server-start', async () => {
    startServer(serverPort(), appDir, getMainWindow())
    const ok = await waitForServer(serverUrl())
    return { ok }
  })

  ipcMain.handle('server-stop', () => { stopServer(); return { ok: true } })

  ipcMain.handle('server-restart', async () => {
    restartServer(serverPort(), appDir, getMainWindow())
    const ok = await waitForServer(serverUrl())
    return { ok }
  })

  ipcMain.handle('server-status', async () => {
    return new Promise(r => {
      const req = http.get(`${serverUrl()}/admin/status`, res => {
        let b = ''; res.on('data', d => b += d)
        res.on('end', () => { try { r({ running: true, ...JSON.parse(b) }) } catch { r({ running: true }) } })
        res.on('error', () => r({ running: false }))
      })
      req.on('error', () => r({ running: false }))
      req.setTimeout(5000, () => { req.destroy(); r({ running: false }) })
    })
  })

  ipcMain.handle('load-model', async (_, modelPath) => {
    if (!isNonEmptyString(modelPath)) return { error: 'modelPath must be a non-empty string' }

    const result = await new Promise((resolve) => {
      const body = JSON.stringify({ model_path: modelPath })
      const req = http.request({
        hostname: '127.0.0.1', port: serverPort(), path: '/admin/load', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let d = ''; res.on('data', c => d += c)
        res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({ status: 'ok' }) } })
        res.on('error', () => resolve({ error: 'Response error' }))
      })
      req.on('error', err => resolve({ error: `Server not reachable: ${err.code || err.message}` }))
      req.setTimeout(120000, () => { req.destroy(); resolve({ error: 'Model load timed out' }) })
      req.write(body); req.end()
    })

    // Trigger calibration and auto-load extraction model after successful model load
    if (!result.error) {
      runCalibration(serverUrl(), serverPort(), getMainWindow(), modelPath)

      // Auto-load the dedicated fast extraction model (fire-and-forget)
      // This enables all fast-assist features: todo bootstrap, error diagnosis,
      // file section extraction, search ranking, etc.
      const memClient = require('../memory-client.js')
      const fastModelPath = config.DEFAULT_FAST_MODEL
      memClient._httpRequest('POST', '/memory/extractor/load', { model_path: fastModelPath }, 60000)
        .then(r => {
          if (r && !r.error) {
            console.log(`[main] Fast assist model loaded: ${fastModelPath}`)
            getMainWindow()?.webContents.send('server-log', `⚡ Fast assist model ready (Qwen3.5 0.8B)`)
          } else {
            console.log(`[main] Fast assist model load failed: ${r?.error || 'no response'}`)
          }
        })
        .catch(err => console.log(`[main] Fast assist model load error: ${err.message}`))
    }

    return result
  })

  ipcMain.handle('unload-model', async () => {
    clearCalibration()
    getMainWindow()?.webContents.send('calibration-status', { status: 'unavailable' })
    return { ok: true }
  })

  ipcMain.handle('get-server-url', () => serverUrl())

  // ── Fast model chat reply ─────────────────────────────────────────────────
  ipcMain.handle('assist-chat-reply', async (event, userMessage, agentRole) => {
    try {
      const memClient = require('../memory-client.js')
      const result = await memClient._httpRequest('POST', '/memory/assist', {
        task_type: 'chat_reply',
        payload: { user_message: userMessage || '', agent_role: agentRole || 'general' }
      }, 12000)
      if (!result || result.degraded) return null
      return result.result || null
    } catch (_) { return null }
  })

  // ── Memory extraction model IPC handlers ─────────────────────────────────
  ipcMain.handle('memory-extractor-load', async (event, modelPath) => {
    try {
      const memClient = require('../memory-client.js')
      const result = await memClient._httpRequest('POST', '/memory/extractor/load', { model_path: modelPath }, 30000)
      return result || { error: 'No response from memory backend' }
    } catch (err) {
      return { error: err.message || 'Failed to load extraction model' }
    }
  })

  ipcMain.handle('memory-extractor-unload', async () => {
    try {
      const memClient = require('../memory-client.js')
      const result = await memClient._httpRequest('POST', '/memory/extractor/unload', {}, 10000)
      return result || { ok: true }
    } catch (err) {
      return { error: err.message || 'Failed to unload extraction model' }
    }
  })

  ipcMain.handle('memory-status', async () => {
    try {
      const memClient = require('../memory-client.js')
      return await memClient.getStatus()
    } catch (err) {
      return null
    }
  })
}

module.exports = { register, startServer, stopServer, restartServer, waitForServer, killStaleServer, findPython, runCalibration, getCalibrationProfile, isCalibrating, clearCalibration }
