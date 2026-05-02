'use strict'

/**
 * IPC module for interactive terminal sessions backed by node-pty.
 *
 * Manages PTY lifecycle: create, write, resize, close.
 * Output is streamed to the renderer via 'terminal-output' events.
 * The agent's bash tool can route interactive commands (sudo, ssh, etc.)
 * here instead of failing with "password required".
 *
 * Exports: register(ipcMain, ctx)
 */

const os = require('os')
const path = require('path')
const fs = require('node:fs')

let pty
try {
  pty = require('node-pty')
} catch (err) {
  console.warn('[ipc-terminal] node-pty not available:', err.message)
}

// Active terminal sessions keyed by session ID
const sessions = new Map()
let nextId = 1

/**
 * Build an augmented PATH matching what direct-bridge.js uses for bash.
 */
function buildEnv() {
  const env = { ...process.env }
  const extra = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    '/usr/local/bin', '/usr/bin', '/usr/sbin', '/bin', '/sbin',
  ]
  const current = env.PATH || ''
  const missing = extra.filter(d => !current.includes(d))
  if (missing.length > 0) {
    env.PATH = missing.join(':') + ':' + current
  }
  // Xcode developer dir
  if (!env.DEVELOPER_DIR) {
    const xcodeDev = '/Applications/Xcode.app/Contents/Developer'
    try {
      if (fs.existsSync(xcodeDev)) {
        env.DEVELOPER_DIR = xcodeDev
        const xcodeBin = `${xcodeDev}/usr/bin`
        if (!env.PATH.includes(xcodeBin)) {
          env.PATH = xcodeBin + ':' + env.PATH
        }
      }
    } catch { /* ignore */ }
  }
  return env
}

function register(ipcMain, ctx) {
  if (!pty) {
    // Stub handlers that return errors if node-pty is unavailable
    ipcMain.handle('terminal-create', async () => ({ error: 'node-pty not available' }))
    ipcMain.handle('terminal-write', async () => ({ error: 'node-pty not available' }))
    ipcMain.handle('terminal-resize', async () => ({ error: 'node-pty not available' }))
    ipcMain.handle('terminal-close', async () => ({ error: 'node-pty not available' }))
    ipcMain.handle('terminal-close-all', async () => ({ error: 'node-pty not available' }))
    ipcMain.handle('terminal-list', async () => ({ sessions: [] }))
    ipcMain.handle('terminal-run-interactive', async () => ({ error: 'node-pty not available' }))
    return
  }

  /**
   * Create a new terminal session.
   * @param {string} [cwd] - Working directory (defaults to current project)
   * @param {number} [cols=120] - Terminal columns
   * @param {number} [rows=24] - Terminal rows
   * @returns {{ id: string }} Session ID
   */
  ipcMain.handle('terminal-create', async (_, opts = {}) => {
    const id = 'term-' + (nextId++)
    const cwd = opts.cwd || ctx.getCurrentProject() || os.homedir()
    const cols = opts.cols || 120
    const rows = opts.rows || 24
    const shell = process.env.SHELL || '/bin/zsh'

    try {
      const proc = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: buildEnv(),
      })

      const session = {
        id,
        proc,
        cwd,
        createdAt: Date.now(),
        // Buffer recent output for the agent to read back
        outputBuffer: '',
        maxBuffer: 64 * 1024, // 64KB rolling buffer
      }

      proc.onData((data) => {
        // Stream to renderer
        const win = ctx.getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('terminal-output', { id, data })
        }
        // Append to rolling buffer
        session.outputBuffer += data
        if (session.outputBuffer.length > session.maxBuffer) {
          session.outputBuffer = session.outputBuffer.slice(-session.maxBuffer)
        }
      })

      proc.onExit(({ exitCode, signal }) => {
        const win = ctx.getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('terminal-exit', { id, exitCode, signal })
        }
        sessions.delete(id)
      })

      sessions.set(id, session)
      return { id }
    } catch (err) {
      return { error: `Failed to create terminal: ${err.message}` }
    }
  })

  /**
   * Write data (keystrokes) to a terminal session.
   */
  ipcMain.handle('terminal-write', async (_, { id, data }) => {
    const session = sessions.get(id)
    if (!session) return { error: `Terminal ${id} not found` }
    try {
      session.proc.write(data)
      return { ok: true }
    } catch (err) {
      return { error: err.message }
    }
  })

  /**
   * Resize a terminal session.
   */
  ipcMain.handle('terminal-resize', async (_, { id, cols, rows }) => {
    const session = sessions.get(id)
    if (!session) return { error: `Terminal ${id} not found` }
    try {
      session.proc.resize(cols, rows)
      return { ok: true }
    } catch (err) {
      return { error: err.message }
    }
  })

  /**
   * Close a terminal session.
   */
  ipcMain.handle('terminal-close', async (_, { id }) => {
    const session = sessions.get(id)
    if (!session) return { ok: true } // already gone
    try {
      session.proc.kill()
    } catch { /* ignore */ }
    sessions.delete(id)
    return { ok: true }
  })

  /**
   * Close all terminal sessions (cleanup on project switch / app quit).
   */
  ipcMain.handle('terminal-close-all', async () => {
    for (const [id, session] of sessions) {
      try { session.proc.kill() } catch { /* ignore */ }
    }
    sessions.clear()
    return { ok: true }
  })

  /**
   * List active terminal sessions.
   */
  ipcMain.handle('terminal-list', async () => {
    const list = []
    for (const [id, session] of sessions) {
      list.push({ id, cwd: session.cwd, createdAt: session.createdAt })
    }
    return { sessions: list }
  })

  /**
   * Run an interactive command in a terminal session.
   * Used by the agent's bash tool to route commands that need user input
   * (sudo, ssh, git push with auth, etc.) to the visible terminal.
   *
   * Creates a new session if needed, sends the command, and returns the
   * session ID so the renderer can show/focus the terminal panel.
   *
   * @param {string} command - The command to run
   * @param {string} [cwd] - Working directory
   * @returns {{ id: string, message: string }}
   */
  ipcMain.handle('terminal-run-interactive', async (_, { command, cwd }) => {
    const projectCwd = cwd || ctx.getCurrentProject() || os.homedir()

    // Reuse existing session or create a new one
    let session = null
    for (const [, s] of sessions) {
      if (s.cwd === projectCwd) {
        session = s
        break
      }
    }

    if (!session) {
      const id = 'term-' + (nextId++)
      const shell = process.env.SHELL || '/bin/zsh'
      try {
        const proc = pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols: 120,
          rows: 24,
          cwd: projectCwd,
          env: buildEnv(),
        })

        session = {
          id,
          proc,
          cwd: projectCwd,
          createdAt: Date.now(),
          outputBuffer: '',
          maxBuffer: 64 * 1024,
        }

        proc.onData((data) => {
          const win = ctx.getMainWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send('terminal-output', { id, data })
          }
          session.outputBuffer += data
          if (session.outputBuffer.length > session.maxBuffer) {
            session.outputBuffer = session.outputBuffer.slice(-session.maxBuffer)
          }
        })

        proc.onExit(({ exitCode, signal }) => {
          const win = ctx.getMainWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send('terminal-exit', { id, exitCode, signal })
          }
          sessions.delete(id)
        })

        sessions.set(id, session)
      } catch (err) {
        return { error: `Failed to create terminal: ${err.message}` }
      }
    }

    // Send the command + Enter to the PTY
    session.proc.write(command + '\n')

    // Notify renderer to show/focus the terminal panel
    const win = ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal-focus', { id: session.id, command })
    }

    return {
      id: session.id,
      message: `Command sent to interactive terminal (${session.id}). The user can see the terminal and provide any required input (passwords, confirmations, etc.).`,
    }
  })

  /**
   * Read recent output from a terminal session's buffer.
   * Used by the agent to check command results after routing to the terminal.
   */
  ipcMain.handle('terminal-read-buffer', async (_, { id, lines }) => {
    const session = sessions.get(id)
    if (!session) return { error: `Terminal ${id} not found` }
    const buf = session.outputBuffer
    if (lines) {
      const allLines = buf.split('\n')
      return { output: allLines.slice(-lines).join('\n') }
    }
    return { output: buf }
  })
}

module.exports = { register }
