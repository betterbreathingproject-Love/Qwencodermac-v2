'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
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

// ── Tier selection ────────────────────────────────────────────────────────────
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
}

module.exports = { register, isSetupComplete, markSetupComplete, resetSetup, getHardwareInfo, scanInstalledModels, selectTier, MODEL_TIERS, getModelsDir, saveModelsDir }
