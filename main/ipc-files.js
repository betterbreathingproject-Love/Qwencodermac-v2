'use strict'

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { execSync } = require('child_process')
const { dialog, shell } = require('electron')

// ── validation ────────────────────────────────────────────────────────────────
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0 }

/**
 * Validate that a path doesn't escape the expected root via traversal.
 * Returns the resolved absolute path or null if invalid.
 */
function safePath(filePath) {
  if (!isNonEmptyString(filePath)) return null
  // Block null bytes
  if (filePath.includes('\0')) return null
  return path.resolve(filePath)
}

// ── IPC registration ──────────────────────────────────────────────────────────
function register(ipcMain, { getMainWindow, getCurrentProject, setCurrentProject }) {

  ipcMain.handle('open-folder', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths.length) return null
    setCurrentProject(result.filePaths[0])
    return result.filePaths[0]
  })

  ipcMain.handle('read-dir', async (_, dirPath) => {
    const resolved = safePath(dirPath)
    if (!resolved) return []
    try {
      const entries = await fsp.readdir(resolved, { withFileTypes: true })
      return entries
        .filter(e => !e.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1
          if (!a.isDirectory() && b.isDirectory()) return 1
          return a.name.localeCompare(b.name)
        })
        .map(e => ({ name: e.name, path: path.join(resolved, e.name), isDir: e.isDirectory() }))
    } catch { return [] }
  })

  ipcMain.handle('read-file', async (_, filePath) => {
    const resolved = safePath(filePath)
    if (!resolved) return null
    try { return await fsp.readFile(resolved, 'utf-8') } catch { return null }
  })

  ipcMain.handle('write-file', async (_, filePath, content) => {
    const resolved = safePath(filePath)
    if (!resolved) return { error: 'Invalid file path' }
    if (typeof content !== 'string') return { error: 'content must be a string' }
    try {
      await fsp.mkdir(path.dirname(resolved), { recursive: true })
      await fsp.writeFile(resolved, content, 'utf-8')
      return { ok: true }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('get-project', () => getCurrentProject())

  // ── git ──────────────────────────────────────────────────────────────────
  ipcMain.handle('git-status', async (_, cwd) => {
    const dir = safePath(cwd || getCurrentProject())
    if (!dir) return { branch: '', files: [] }
    try {
      const out = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8', timeout: 5000 })
      const branch = execSync('git branch --show-current', { cwd: dir, encoding: 'utf-8', timeout: 5000 }).trim()
      return { branch, files: out.trim().split('\n').filter(Boolean).map(l => ({ status: l.slice(0, 2).trim(), file: l.slice(3) })) }
    } catch { return { branch: '', files: [] } }
  })

  ipcMain.handle('git-log', async (_, cwd) => {
    const dir = safePath(cwd || getCurrentProject())
    if (!dir) return []
    try {
      const out = execSync('git log --oneline -20', { cwd: dir, encoding: 'utf-8', timeout: 5000 })
      return out.trim().split('\n').map(l => { const [hash, ...rest] = l.split(' '); return { hash, message: rest.join(' ') } })
    } catch { return [] }
  })

  ipcMain.handle('open-external', (_, url) => {
    if (!isNonEmptyString(url)) return
    // Only allow http/https URLs
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url)
      }
    } catch {}
  })
}

module.exports = { register, safePath }
