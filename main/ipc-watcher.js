'use strict'

const fs = require('fs')

let projectWatcher = null
let _debounceTimer = null

function watchProject(dir, mainWindow) {
  if (projectWatcher) { projectWatcher.close(); projectWatcher = null }
  if (!dir) return
  try {
    // Use async existsSync check — this is a one-time setup call so it's acceptable
    if (!fs.existsSync(dir)) return
    projectWatcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename || filename.startsWith('.')) return
      if (_debounceTimer) clearTimeout(_debounceTimer)
      _debounceTimer = setTimeout(() => {
        mainWindow?.webContents.send('files-changed', { dir, eventType, filename })
      }, 300)
    })
  } catch (e) {
    console.log('[main] fs.watch failed:', e.message)
  }
}

function unwatchProject() {
  if (projectWatcher) { projectWatcher.close(); projectWatcher = null }
}

function register(ipcMain, { getMainWindow }) {
  ipcMain.handle('watch-project', (_, dir) => {
    if (typeof dir !== 'string' || !dir) return { error: 'dir is required' }
    watchProject(dir, getMainWindow())
    return { ok: true }
  })

  ipcMain.handle('unwatch-project', () => {
    unwatchProject()
    return { ok: true }
  })
}

module.exports = { register, unwatchProject }
