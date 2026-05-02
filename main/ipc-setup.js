'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile, spawn } = require('node:child_process')
const { shell, dialog } = require('electron')

// ── Model recommendations by RAM tier ────────────────────────────────────────
// Each tier lists primary + fast model with exact LM Studio model IDs
const MODEL_TIERS = [
  {
    minRamGb: 64,
    label: 'Mac Studio / Mac Pro (64 GB+)',
    primary: {
      name: 'Qwen3.6 35B A3B — 8-bit',
      modelId: 'unsloth/Qwen3.6-35B-A3B-MLX-8bit',
      dirName: 'unsloth/Qwen3.6-35B-A3B-MLX-8bit',
      // Also match if downloaded under a different org (e.g. TheCluster)
      modelFolderName: 'Qwen3.6-35B-A3B-MLX-8bit',
      sizeGb: 38,
      quant: '8-bit',
      description: 'Full quality — best reasoning and code generation',
      lmStudioUrl: 'lmstudio://open?model=unsloth/Qwen3.6-35B-A3B-MLX-8bit',
      huggingFaceUrl: 'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MLX-8bit',
    },
    fast: {
      name: 'Qwen3.5 0.8B — 8-bit',
      modelId: 'mlx-community/Qwen3.5-0.8B-MLX-8bit',
      dirName: 'mlx-community/Qwen3.5-0.8B-MLX-8bit',
      modelFolderName: 'Qwen3.5-0.8B-MLX-8bit',
      sizeGb: 1,
      quant: '8-bit',
      description: 'Ultra-fast assistant — instant responses, vision offload',
      lmStudioUrl: 'lmstudio://open?model=mlx-community/Qwen3.5-0.8B-MLX-8bit',
      huggingFaceUrl: 'https://huggingface.co/mlx-community/Qwen3.5-0.8B-MLX-8bit',
    },
  },
  {
    minRamGb: 32,
    label: 'MacBook Pro / Mac Mini (32–63 GB)',
    primary: {
      name: 'Qwen3.6 35B A3B — 4-bit',
      modelId: 'lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit',
      dirName: 'lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit',
      modelFolderName: 'Qwen3.6-35B-A3B-MLX-4bit',
      sizeGb: 20,
      quant: '4-bit',
      description: 'Compressed for 32 GB — excellent quality, fits comfortably',
      lmStudioUrl: 'lmstudio://open?model=lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit',
      huggingFaceUrl: 'https://huggingface.co/lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit',
    },
    fast: {
      name: 'Qwen3.5 0.8B — 8-bit',
      modelId: 'mlx-community/Qwen3.5-0.8B-MLX-8bit',
      dirName: 'mlx-community/Qwen3.5-0.8B-MLX-8bit',
      modelFolderName: 'Qwen3.5-0.8B-MLX-8bit',
      sizeGb: 1,
      quant: '8-bit',
      description: 'Ultra-fast assistant — instant responses, vision offload',
      lmStudioUrl: 'lmstudio://open?model=mlx-community/Qwen3.5-0.8B-MLX-8bit',
      huggingFaceUrl: 'https://huggingface.co/mlx-community/Qwen3.5-0.8B-MLX-8bit',
    },
  },
  {
    minRamGb: 16,
    label: 'MacBook Air / Mac Mini (16–31 GB)',
    primary: {
      name: 'Qwen3.5 7B — 8-bit',
      modelId: 'mlx-community/Qwen3.5-7B-MLX-8bit',
      dirName: 'mlx-community/Qwen3.5-7B-MLX-8bit',
      modelFolderName: 'Qwen3.5-7B-MLX-8bit',
      sizeGb: 8,
      quant: '8-bit',
      description: 'Fits 16 GB — solid coding assistant at full quality',
      lmStudioUrl: 'lmstudio://open?model=mlx-community/Qwen3.5-7B-MLX-8bit',
      huggingFaceUrl: 'https://huggingface.co/mlx-community/Qwen3.5-7B-MLX-8bit',
    },
    fast: {
      name: 'Qwen3.5 0.8B — 8-bit',
      modelId: 'mlx-community/Qwen3.5-0.8B-MLX-8bit',
      dirName: 'mlx-community/Qwen3.5-0.8B-MLX-8bit',
      modelFolderName: 'Qwen3.5-0.8B-MLX-8bit',
      sizeGb: 1,
      quant: '8-bit',
      description: 'Ultra-fast assistant — instant responses, vision offload',
      lmStudioUrl: 'lmstudio://open?model=mlx-community/Qwen3.5-0.8B-MLX-8bit',
      huggingFaceUrl: 'https://huggingface.co/mlx-community/Qwen3.5-0.8B-MLX-8bit',
    },
  },
]

// ── Setup completion flag ─────────────────────────────────────────────────────
function _setupFlagPath() {
  return path.join(os.homedir(), '.qwencoder', 'setup-complete.json')
}

function isSetupComplete() {
  try {
    const p = _setupFlagPath()
    if (!fs.existsSync(p)) return false
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return data && data.complete === true
  } catch {
    return false
  }
}

function markSetupComplete(info) {
  try {
    const dir = path.join(os.homedir(), '.qwencoder')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(_setupFlagPath(), JSON.stringify({
      complete: true,
      completedAt: Date.now(),
      ...info,
    }, null, 2))
  } catch (err) {
    console.warn('[setup] Failed to write setup flag:', err.message)
  }
}

function resetSetup() {
  try {
    const p = _setupFlagPath()
    if (fs.existsSync(p)) fs.unlinkSync(p)
  } catch {}
}

// ── Hardware detection ────────────────────────────────────────────────────────
function getHardwareInfo() {
  return new Promise((resolve) => {
    // Get total RAM via sysctl
    execFile('sysctl', ['-n', 'hw.memsize'], { timeout: 3000 }, (err, stdout) => {
      const ramBytes = err ? 0 : parseInt(stdout.trim(), 10)
      const ramGb = Math.round(ramBytes / (1024 ** 3))

      // Get chip name via sysctl
      execFile('sysctl', ['-n', 'machdep.cpu.brand_string'], { timeout: 3000 }, (err2, stdout2) => {
        let chip = err2 ? 'Apple Silicon' : stdout2.trim()
        // sysctl may return empty on Apple Silicon — fall back to system_profiler
        if (!chip || chip === 'Apple Silicon') {
          execFile('sysctl', ['-n', 'hw.model'], { timeout: 3000 }, (err3, stdout3) => {
            const model = err3 ? 'Mac' : stdout3.trim()
            resolve({ ramGb, chip: model, rawRamBytes: ramBytes })
          })
        } else {
          resolve({ ramGb, chip, rawRamBytes: ramBytes })
        }
      })
    })
  })
}

// ── Models directory (persisted override) ────────────────────────────────────
function _modelsDirOverridePath() {
  return path.join(os.homedir(), '.qwencoder', 'models-dir.json')
}

function getModelsDir() {
  try {
    const p = _modelsDirOverridePath()
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
      if (data && data.dir && fs.existsSync(data.dir)) return data.dir
    }
  } catch {}
  return path.join(os.homedir(), '.lmstudio', 'models')
}

function saveModelsDir(dir) {
  try {
    const base = path.join(os.homedir(), '.qwencoder')
    if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true })
    fs.writeFileSync(_modelsDirOverridePath(), JSON.stringify({ dir }, null, 2))
  } catch (err) {
    console.warn('[setup] Failed to save models dir:', err.message)
  }
}

// ── Model scanning ────────────────────────────────────────────────────────────
function scanInstalledModels(modelsRoot) {
  if (!modelsRoot) modelsRoot = getModelsDir()
  const installed = new Set()        // exact: "org/model"
  const installedFolders = new Set() // fuzzy: "model" (folder name only)
  try {
    if (!fs.existsSync(modelsRoot)) return { installed, installedFolders }
    // Walk two levels deep: org/model/config.json
    const orgs = fs.readdirSync(modelsRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
    for (const org of orgs) {
      const orgPath = path.join(modelsRoot, org.name)
      try {
        const models = fs.readdirSync(orgPath, { withFileTypes: true })
          .filter(e => e.isDirectory())
        for (const model of models) {
          const cfgPath = path.join(orgPath, model.name, 'config.json')
          if (fs.existsSync(cfgPath)) {
            installed.add(`${org.name}/${model.name}`)
            installedFolders.add(model.name)
          }
        }
      } catch {}
    }
  } catch {}
  return { installed, installedFolders }
}

// ── Dependency checking & installation ───────────────────────────────────────
// Packages that must be present for the app to function.
// Special installs (git sources) use a custom installCmd instead of pip name.
const REQUIRED_PACKAGES = [
  { import: 'mlx',                    pip: 'mlx',                                        label: 'MLX (Apple Silicon inference)' },
  { import: 'mlx_lm',                 pip: 'mlx-lm',                                     label: 'mlx-lm (text model inference)' },
  { import: 'mlx_vlm',                pip: 'mlx-vlm',                                    label: 'mlx-vlm (vision model inference)' },
  { import: 'fastapi',                pip: 'fastapi',                                    label: 'FastAPI (server framework)' },
  { import: 'uvicorn',                pip: 'uvicorn',                                    label: 'Uvicorn (ASGI server)' },
  { import: 'pydantic',               pip: 'pydantic',                                   label: 'Pydantic (data validation)' },
  { import: 'jinja2',                 pip: 'Jinja2',                                     label: 'Jinja2 (chat templates)' },
  { import: 'PIL',                    pip: 'Pillow',                                     label: 'Pillow (image processing)' },
  { import: 'psutil',                 pip: 'psutil',                                     label: 'psutil (memory monitoring)' },
  { import: 'sentence_transformers',  pip: 'sentence-transformers',                      label: 'sentence-transformers (vector memory)' },
  { import: 'transformers',           pip: 'transformers',                               label: 'transformers (tokenizers)' },
  { import: 'numpy',                  pip: 'numpy',                                      label: 'numpy (numerical computing)' },
  { import: 'claw_compactor',         pip: 'claw-compactor',                             label: 'claw-compactor (context compression)' },
  { import: 'taosmd',                 pip: 'git+https://github.com/jaylfc/taosmd.git',   label: 'taosmd (memory system)', gitInstall: true },
]

function checkPythonDeps(pyPath) {
  return new Promise((resolve) => {
    // Build a one-liner that checks each import and reports missing ones
    const checks = REQUIRED_PACKAGES.map(p =>
      `("${p.import}","${p.pip}","${p.label}")`
    ).join(',')
    const script = `
import sys, importlib.util
pkgs=[${checks}]
missing=[]
installed=[]
for imp,pip,label in pkgs:
    if importlib.util.find_spec(imp) is None:
        missing.append({"import":imp,"pip":pip,"label":label})
    else:
        installed.append({"import":imp,"pip":pip,"label":label})
import json,sys
print(json.dumps({"missing":missing,"installed":installed,"python":sys.version}))
`
    execFile(pyPath, ['-c', script], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: err.message, missing: REQUIRED_PACKAGES, installed: [] })
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch {
        resolve({ error: 'Could not parse output', missing: REQUIRED_PACKAGES, installed: [] })
      }
    })
  })
}

let _installProcess = null

function installDeps(pyPath, requirementsPath, onData) {
  return new Promise((resolve) => {
    if (_installProcess) {
      resolve({ error: 'Install already in progress' })
      return
    }

    // Step 1: install everything in requirements.txt
    // Step 2: install taosmd from GitHub (not on PyPI)
    // Step 3: install claw-compactor (may already be in requirements but ensure it)
    const runInstall = (args, label, cb) => {
      onData && onData(`\n▶ ${label}\n`)
      const proc = spawn(pyPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      proc.stdout.on('data', d => onData && onData(d.toString()))
      proc.stderr.on('data', d => onData && onData(d.toString()))
      proc.on('exit', code => cb(code === 0))
      proc.on('error', err => { onData && onData(`Error: ${err.message}\n`); cb(false) })
      return proc
    }

    _installProcess = { kill: () => {} } // placeholder

    runInstall(
      ['-m', 'pip', 'install', '-r', requirementsPath, '--progress-bar', 'off'],
      'Installing Python packages from requirements.txt…',
      (ok1) => {
        // Always install taosmd from GitHub — it's not on PyPI
        runInstall(
          ['-m', 'pip', 'install', 'git+https://github.com/jaylfc/taosmd.git', '--progress-bar', 'off'],
          'Installing taosmd from GitHub…',
          (ok2) => {
            _installProcess = null
            resolve({ ok: ok1 && ok2, reqOk: ok1, taosmdOk: ok2 })
          }
        )
      }
    )
  })
}
// ── Binary checks (bundled resources/bin/) ───────────────────────────────────
const REQUIRED_BINARIES = [
  { name: 'agent-lsp', label: 'agent-lsp',  desc: 'LSP diagnostics & safe-edit' },
  { name: 'sg',        label: 'sg',         desc: 'AST code search (ast-grep shim)' },
  { name: 'ast-grep',  label: 'ast-grep',   desc: 'Structural code search' },
]

function checkBinaries(appDir) {
  const binDir = path.join(appDir, 'resources', 'bin')
  return REQUIRED_BINARIES.map(b => {
    const binPath = path.join(binDir, b.name)
    let present = false
    let executable = false
    try {
      fs.accessSync(binPath, fs.constants.F_OK)
      present = true
      fs.accessSync(binPath, fs.constants.X_OK)
      executable = true
    } catch {}
    return { ...b, present, executable, path: binPath }
  })
}

function selectTier(ramGb) {
  for (const tier of MODEL_TIERS) {
    if (ramGb >= tier.minRamGb) return tier
  }
  return MODEL_TIERS[MODEL_TIERS.length - 1]
}

// ── IPC registration ──────────────────────────────────────────────────────────
function register(ipcMain) {
  // Get hardware info + recommended models + installed status
  ipcMain.handle('setup-get-info', async () => {
    const hw = await getHardwareInfo()
    const tier = selectTier(hw.ramGb)
    const modelsDir = getModelsDir()
    const { installed, installedFolders } = scanInstalledModels(modelsDir)

    // Check installed: exact org/model match OR folder-name-only match
    function isInstalled(model) {
      return installed.has(model.dirName) ||
             installedFolders.has(model.modelFolderName || model.dirName.split('/')[1])
    }

    return {
      hardware: hw,
      tier,
      allTiers: MODEL_TIERS,
      primaryInstalled: isInstalled(tier.primary),
      fastInstalled: isInstalled(tier.fast),
      lmStudioInstalled: fs.existsSync('/Applications/LM Studio.app'),
      modelsDir,
    }
  })

  // Open a URL (LM Studio deep link or HuggingFace page)
  ipcMain.handle('setup-open-url', async (_, url) => {
    if (typeof url !== 'string') return { error: 'invalid url' }
    // Only allow lmstudio:// and https://huggingface.co
    if (!url.startsWith('lmstudio://') && !url.startsWith('https://huggingface.co') && !url.startsWith('https://lmstudio.ai')) {
      return { error: 'url not allowed' }
    }
    await shell.openExternal(url)
    return { ok: true }
  })

  // Re-scan models (called after user downloads)
  ipcMain.handle('setup-scan-models', async () => {
    const { installed, installedFolders } = scanInstalledModels(getModelsDir())
    return {
      installed: Array.from(installed),
      installedFolders: Array.from(installedFolders),
    }
  })

  // Mark setup as complete
  ipcMain.handle('setup-complete', async (_, info) => {
    markSetupComplete(info || {})
    return { ok: true }
  })

  // Check if setup has been completed
  ipcMain.handle('setup-is-complete', async () => {
    return { complete: isSetupComplete() }
  })

  // Reset setup (for re-running the wizard)
  ipcMain.handle('setup-reset', async () => {
    resetSetup()
    return { ok: true }
  })

  // Get current models directory (default or overridden)
  ipcMain.handle('setup-get-models-dir', async () => {
    return { dir: getModelsDir(), isDefault: !fs.existsSync(_modelsDirOverridePath()) }
  })

  // ── Dependency check & auto-install ──────────────────────────────────────
  ipcMain.handle('setup-check-deps', async () => {
    const { findPython } = require('../main/ipc-server')
    const py = findPython()
    const [pyResult, binaries] = await Promise.all([
      checkPythonDeps(py),
      Promise.resolve(checkBinaries(path.join(__dirname, '..'))),
    ])
    return { ...pyResult, python: py, binaries }
  })

  // Streams install log lines back via 'setup-install-log' events on the window
  ipcMain.handle('setup-install-deps', async () => {
    const { BrowserWindow } = require('electron')
    const { findPython } = require('../main/ipc-server')
    const py = findPython()
    const reqPath = path.join(__dirname, '..', 'requirements.txt')
    if (!fs.existsSync(reqPath)) return { error: 'requirements.txt not found at ' + reqPath }

    const wins = BrowserWindow.getAllWindows()
    const notify = (line) => {
      for (const w of wins) {
        try { w.webContents.send('setup-install-log', line) } catch {}
      }
    }

    const result = await installDeps(py, reqPath, notify)
    // Re-check after install so caller gets updated status
    const { findPython: fp } = require('../main/ipc-server')
    const postCheck = await checkPythonDeps(fp())
    return { ...result, postCheck }
  })
  // Open a folder picker and save as the models directory
  ipcMain.handle('setup-pick-models-dir', async () => {
    // Find the frontmost window to attach the sheet to
    const { BrowserWindow } = require('electron')
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: 'Select LM Studio Models Folder',
      defaultPath: getModelsDir(),
      buttonLabel: 'Use This Folder',
      properties: ['openDirectory'],
    })
    if (result.canceled || !result.filePaths.length) return { canceled: true }
    const dir = result.filePaths[0].trim()
    saveModelsDir(dir)
    // Re-scan with the new dir and return updated status
    const { installed, installedFolders } = scanInstalledModels(dir)
    return { ok: true, dir, installed: Array.from(installed), installedFolders: Array.from(installedFolders) }
  })

  // Save a models dir directly (from settings panel text field)
  ipcMain.handle('setup-save-models-dir', async (_, dir) => {
    if (typeof dir !== 'string' || !dir.trim()) return { error: 'invalid path' }
    const trimmed = dir.trim()
    if (!fs.existsSync(trimmed)) return { error: 'path does not exist' }
    saveModelsDir(trimmed)
    const { installed, installedFolders } = scanInstalledModels(trimmed)
    return { ok: true, dir: trimmed, installed: Array.from(installed), installedFolders: Array.from(installedFolders) }
  })

  // ── macOS permissions ─────────────────────────────────────────────────────

  // Check the status of all relevant macOS permissions.
  ipcMain.handle('setup-check-permissions', async () => {
    const { systemPreferences } = require('electron')
    return checkPermissionsAsync(systemPreferences)
  })

  // Open the relevant macOS System Settings pane for a given permission.
  ipcMain.handle('setup-open-system-prefs', async (_, permId) => {
    const urls = {
      accessibility:    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      screenRecording:  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      microphone:       'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      camera:           'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
      automation:       'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
      filesAndFolders:  'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
      fullDiskAccess:   'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    }
    const url = urls[permId]
    if (!url) return { error: `Unknown permission: ${permId}` }
    await shell.openExternal(url)
    return { ok: true }
  })
}

// ── Permission checking ───────────────────────────────────────────────────────
// Returns an object mapping permId → status string
// status: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
function checkPermissions(systemPreferences) {
  const results = {}

  function mediaStatus(raw) {
    if (raw === 'granted') return 'granted'
    if (raw === 'denied') return 'denied'
    if (raw === 'restricted') return 'restricted'
    return 'not-determined'
  }

  // Microphone
  try {
    results.microphone = mediaStatus(systemPreferences.getMediaAccessStatus('microphone'))
  } catch { results.microphone = 'unknown' }

  // Camera
  try {
    results.camera = mediaStatus(systemPreferences.getMediaAccessStatus('camera'))
  } catch { results.camera = 'unknown' }

  // Screen Recording — getMediaAccessStatus('screen') available in Electron 13+
  try {
    results.screenRecording = mediaStatus(systemPreferences.getMediaAccessStatus('screen'))
  } catch { results.screenRecording = 'unknown' }

  // Accessibility — check via AXIsProcessTrusted using async execFile (non-blocking)
  // Resolved separately; for the sync path we return 'unknown' and let the async
  // version in checkPermissionsAsync fill it in.
  results.accessibility = 'unknown'

  // Full Disk Access — no direct API; default to unknown for the sync path
  results.fullDiskAccess = 'unknown'

  return results
}

// Async version — fills in accessibility and fullDiskAccess without blocking the main thread.
function checkPermissionsAsync(systemPreferences) {
  return new Promise((resolve) => {
    const base = checkPermissions(systemPreferences)

    // Run both async checks in parallel with a shared timeout
    let settled = false
    const done = () => {
      if (!settled) { settled = true; resolve(base) }
    }
    // 4-second overall timeout — never block the wizard
    const timer = setTimeout(done, 4000)

    // Accessibility via python3 ctypes (non-blocking)
    execFile('python3', ['-c',
      'import ctypes; lib=ctypes.cdll.LoadLibrary("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"); lib.AXIsProcessTrusted.restype=ctypes.c_bool; print(lib.AXIsProcessTrusted())'
    ], { timeout: 3000 }, (err, stdout) => {
      if (!err) {
        base.accessibility = stdout.trim() === 'True' ? 'granted' : 'not-determined'
      }
      // Full Disk Access — probe TCC-protected path
      execFile('ls', [
        `${require('os').homedir()}/Library/Application Support/com.apple.TCC/`
      ], { timeout: 2000 }, (err2) => {
        base.fullDiskAccess = err2 ? 'not-determined' : 'granted'
        clearTimeout(timer)
        done()
      })
    })
  })
}

module.exports = { register, isSetupComplete, markSetupComplete, resetSetup, getHardwareInfo, scanInstalledModels, selectTier, MODEL_TIERS, getModelsDir, saveModelsDir, checkPermissions, checkPermissionsAsync }
