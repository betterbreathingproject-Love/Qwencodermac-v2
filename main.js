const { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog } = require('electron')
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { QwenBridge, WindowSink } = require('./qwen-bridge')
const { listProjects, createProject, openProject, deleteProject, getHistory, appendHistory, clearHistory, buildProjectContext, getSettings, saveSettings, DEFAULT_SETTINGS, listSessions, createSession, renameSession, deleteSession, getSessionMessages, appendSessionMessage, clearSessionMessages, setSessionMessages } = require('./projects')
const compactor = require('./compactor')
const { parseTaskGraph, printTaskGraph } = require('./task-graph')
const { Orchestrator } = require('./orchestrator')
const { AgentPool } = require('./agent-pool')
const { astSearch, getSupportedPatterns, getSearchStatus } = require('./ast-search')
const { initSpec, getSpecPhase, advancePhase } = require('./spec-workflow')

nativeTheme.themeSource = 'dark'

let mainWindow
let serverProcess = null
let qwenBridge = null
let currentProject = null
let projectWatcher = null
const SERVER_PORT = 8090
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`

let orchestratorInstance = null
const agentPool = new AgentPool({ maxConcurrency: 3 })

// 7.1.1 Register default subagent types
agentPool.registerType({ name: 'code-search', systemPrompt: 'You are a code search agent. Find code patterns and structures.', allowedTools: ['ast-search'] })
agentPool.registerType({ name: 'requirements', systemPrompt: 'You are a requirements agent. Gather and refine requirements.', allowedTools: [] })
agentPool.registerType({ name: 'design', systemPrompt: 'You are a design agent. Create architecture and design documents.', allowedTools: [] })
agentPool.registerType({ name: 'implementation', systemPrompt: 'You are an implementation agent. Write and refactor code.', allowedTools: ['ast-search'] })
agentPool.registerType({ name: 'general', systemPrompt: 'You are a general-purpose agent.', allowedTools: [] })

// ── python ────────────────────────────────────────────────────────────────────
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

function getServerScript() {
  const packed = path.join(process.resourcesPath, 'server.py')
  const dev = path.join(__dirname, 'server.py')
  return fs.existsSync(packed) ? packed : dev
}

// ── server ────────────────────────────────────────────────────────────────────
let _serverStopping = false

function startServer() {
  if (serverProcess) return
  _serverStopping = false
  const py = findPython(), script = getServerScript()
  serverProcess = spawn(py, [script, '--port', String(SERVER_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] })
  serverProcess.stdout.on('data', d => mainWindow?.webContents.send('server-log', d.toString().trim()))
  serverProcess.stderr.on('data', d => mainWindow?.webContents.send('server-log', d.toString().trim()))
  serverProcess.on('exit', (code) => {
    serverProcess = null
    mainWindow?.webContents.send('server-status', { running: false })
    // Auto-restart if the server crashed (not a clean stop)
    if (!_serverStopping && code !== 0 && code !== null) {
      console.log(`[main] Server crashed (code ${code}), restarting in 2s...`)
      mainWindow?.webContents.send('server-log', `⚠️ Server crashed (code ${code}), restarting...`)
      setTimeout(() => { if (!_serverStopping) startServer() }, 2000)
    }
  })
}

function stopServer() { _serverStopping = true; if (serverProcess) { serverProcess.kill(); serverProcess = null } }

function waitForServer(cb, n = 30) {
  if (n <= 0) return cb(false)
  http.get(`${SERVER_URL}/admin/status`, r => r.statusCode === 200 ? cb(true) : setTimeout(() => waitForServer(cb, n - 1), 500))
    .on('error', () => setTimeout(() => waitForServer(cb, n - 1), 500))
}

// ── window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 650,
    titleBarStyle: 'hiddenInset', backgroundColor: '#0f0f0f',
    vibrancy: 'under-window', visualEffectState: 'active',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.on('closed', () => { stopServer(); mainWindow = null })
  qwenBridge = new QwenBridge(new WindowSink(mainWindow))
}

// ── IPC: server ───────────────────────────────────────────────────────────────
ipcMain.handle('server-start', async () => { startServer(); return new Promise(r => waitForServer(ok => r({ ok }))) })
ipcMain.handle('server-stop', () => { stopServer(); return { ok: true } })
ipcMain.handle('server-status', async () => {
  return new Promise(r => {
    http.get(`${SERVER_URL}/admin/status`, res => {
      let b = ''; res.on('data', d => b += d)
      res.on('end', () => { try { r({ running: true, ...JSON.parse(b) }) } catch { r({ running: true }) } })
    }).on('error', () => r({ running: false }))
  })
})

ipcMain.handle('load-model', async (_, modelPath) => {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model_path: modelPath })
    const req = http.request({ hostname: '127.0.0.1', port: SERVER_PORT, path: '/admin/load', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({ status: 'ok' }) } }) })
    req.on('error', err => resolve({ error: `Server not reachable: ${err.code || err.message}` })); req.write(body); req.end()
  })
})

// ── IPC: chat (non-streaming for vision etc) ──────────────────────────────────
ipcMain.handle('chat', async (_, payload) => {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload)
    const req = http.request({ hostname: '127.0.0.1', port: SERVER_PORT, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({ error: d || 'Empty response' }) } }) })
    req.on('error', err => resolve({ error: `Server not reachable: ${err.code || err.message}. Is a model loaded?` }))
    req.write(body); req.end()
  })
})

// ── IPC: streaming chat ───────────────────────────────────────────────────────
let activeStreamReq = null

ipcMain.on('chat-stream', (event, payload) => {
  const body = JSON.stringify({ ...payload, stream: true })
  const req = http.request({ hostname: '127.0.0.1', port: SERVER_PORT, path: '/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    res => {
      let buf = ''
      res.on('data', chunk => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (line.startsWith('data: [DONE]')) { event.sender.send('chat-stream-done'); return }
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6))
              if (parsed.usage && parsed.usage.prompt_tokens) {
                const stats = { ...parsed.usage }
                if (parsed.x_stats) {
                  stats.prompt_tps = parsed.x_stats.prompt_tps
                  stats.generation_tps = parsed.x_stats.generation_tps
                  stats.peak_memory_gb = parsed.x_stats.peak_memory_gb
                }
                event.sender.send('chat-stream-stats', stats)
              }
              const delta = parsed.choices?.[0]?.delta?.content
              if (delta) {
                event.sender.send('chat-stream-chunk', parsed)
              }
            } catch {}
          }
        }
      })
      res.on('end', () => { activeStreamReq = null; event.sender.send('chat-stream-done') })
    })
  req.on('error', err => { activeStreamReq = null; event.sender.send('chat-stream-error', err.message) })
  req.write(body); req.end()
  activeStreamReq = req
})

ipcMain.handle('chat-stream-abort', () => {
  if (activeStreamReq) { activeStreamReq.destroy(); activeStreamReq = null }
  return { ok: true }
})

// ── IPC: Qwen Code agent ─────────────────────────────────────────────────────
ipcMain.handle('qwen-run', async (_, { prompt, cwd, permissionMode, model, images }) => {
  if (!qwenBridge) return { error: 'not ready' }
  // run async, events stream via qwen-event channel
  qwenBridge.run({ prompt, cwd: cwd || currentProject, permissionMode, model, images }).catch(() => {})
  return { ok: true }
})
ipcMain.handle('qwen-interrupt', async () => { await qwenBridge?.interrupt(); return { ok: true } })

// ── IPC: file system ──────────────────────────────────────────────────────────
ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths.length) return null
  currentProject = result.filePaths[0]
  return currentProject
})

ipcMain.handle('read-dir', async (_, dirPath) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name), isDir: e.isDirectory() }))
    return entries
  } catch { return [] }
})

ipcMain.handle('read-file', async (_, filePath) => {
  try { return fs.readFileSync(filePath, 'utf-8') } catch { return null }
})

ipcMain.handle('write-file', async (_, filePath, content) => {
  try { fs.writeFileSync(filePath, content, 'utf-8'); return { ok: true } } catch (e) { return { error: e.message } }
})

ipcMain.handle('get-project', () => currentProject)

// ── IPC: git ──────────────────────────────────────────────────────────────────
ipcMain.handle('git-status', async (_, cwd) => {
  try {
    const out = execSync('git status --porcelain', { cwd: cwd || currentProject, encoding: 'utf-8', timeout: 5000 })
    const branch = execSync('git branch --show-current', { cwd: cwd || currentProject, encoding: 'utf-8', timeout: 5000 }).trim()
    return { branch, files: out.trim().split('\n').filter(Boolean).map(l => ({ status: l.slice(0, 2).trim(), file: l.slice(3) })) }
  } catch { return { branch: '', files: [] } }
})

ipcMain.handle('git-log', async (_, cwd) => {
  try {
    const out = execSync('git log --oneline -20', { cwd: cwd || currentProject, encoding: 'utf-8', timeout: 5000 })
    return out.trim().split('\n').map(l => { const [hash, ...rest] = l.split(' '); return { hash, message: rest.join(' ') } })
  } catch { return [] }
})

ipcMain.handle('open-external', (_, url) => shell.openExternal(url))
ipcMain.handle('get-server-url', () => SERVER_URL)

// ── IPC: projects ─────────────────────────────────────────────────────────────
ipcMain.handle('list-projects', () => listProjects())
ipcMain.handle('create-project', (_, name, directory) => {
  const p = createProject(name, directory)
  currentProject = p.directory
  return p
})
ipcMain.handle('open-project', (_, id) => {
  const p = openProject(id)
  if (p) currentProject = p.directory
  return p
})
ipcMain.handle('delete-project', (_, id) => { deleteProject(id); return { ok: true } })
ipcMain.handle('get-history', (_, projectId) => getHistory(projectId))
ipcMain.handle('append-history', (_, projectId, message) => appendHistory(projectId, message))
ipcMain.handle('clear-history', (_, projectId) => { clearHistory(projectId); return { ok: true } })
ipcMain.handle('build-context', (_, directory) => buildProjectContext(directory))

// ── IPC: sessions ─────────────────────────────────────────────────────────────
ipcMain.handle('list-sessions', (_, projectId) => listSessions(projectId))
ipcMain.handle('create-session', (_, projectId, name, sessionType) => createSession(projectId, name, sessionType))
ipcMain.handle('rename-session', (_, projectId, sessionId, name) => renameSession(projectId, sessionId, name))
ipcMain.handle('delete-session', (_, projectId, sessionId) => { deleteSession(projectId, sessionId); return { ok: true } })
ipcMain.handle('get-session-messages', (_, projectId, sessionId) => getSessionMessages(projectId, sessionId))
ipcMain.handle('append-session-message', (_, projectId, sessionId, message) => appendSessionMessage(projectId, sessionId, message))
ipcMain.handle('clear-session-messages', (_, projectId, sessionId) => { clearSessionMessages(projectId, sessionId); return { ok: true } })
ipcMain.handle('set-session-messages', (_, projectId, sessionId, messages) => setSessionMessages(projectId, sessionId, messages))

// ── IPC: context settings ─────────────────────────────────────────────────────
ipcMain.handle('get-settings', (_, projectId) => getSettings(projectId))
ipcMain.handle('save-settings', (_, projectId, settings) => saveSettings(projectId, settings))
ipcMain.handle('get-default-settings', () => DEFAULT_SETTINGS)

// ── IPC: compactor ────────────────────────────────────────────────────────────
ipcMain.handle('compactor-status', async () => {
  const py = findPython()
  return compactor.getStatus(py)
})
ipcMain.handle('compactor-compress-messages', async (_, messages, options) => {
  const py = findPython()
  return compactor.compressMessages(py, messages, options)
})
ipcMain.handle('compactor-compress-text', async (_, text, contentType) => {
  const py = findPython()
  return compactor.compressText(py, text, contentType)
})

// ── IPC: task graph ───────────────────────────────────────────────────────────
ipcMain.handle('task-graph-parse', async (_, filePath) => {
  try {
    const md = fs.readFileSync(filePath, 'utf-8')
    const graph = parseTaskGraph(md)
    // Serialize Map to plain object for IPC
    const nodes = {}
    for (const [id, node] of graph.nodes) nodes[id] = node
    return { nodes, startNodeId: graph.startNodeId, errors: graph.errors }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('task-graph-execute', async (_, filePath) => {
  try {
    const md = fs.readFileSync(filePath, 'utf-8')
    const graph = parseTaskGraph(md)
    orchestratorInstance = new Orchestrator({ taskGraph: graph, agentPool, tasksFilePath: filePath })
    orchestratorInstance.on('task-status-event', (evt) => {
      mainWindow?.webContents.send('task-status-event', evt)
    })
    orchestratorInstance.start().catch(() => {})
    return { ok: true }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('task-graph-pause', async () => {
  try {
    if (orchestratorInstance) await orchestratorInstance.pause()
    return { ok: true }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('task-graph-resume', async () => {
  try {
    if (orchestratorInstance) await orchestratorInstance.resume()
    return { ok: true }
  } catch (e) { return { error: e.message } }
})

ipcMain.handle('task-graph-status', async () => {
  try {
    if (!orchestratorInstance) return { state: 'idle', graph: null }
    const status = orchestratorInstance.getStatus()
    const nodes = {}
    for (const [id, node] of status.graph.nodes) nodes[id] = node
    return { state: status.state, graph: { nodes, startNodeId: status.graph.startNodeId, errors: status.graph.errors } }
  } catch (e) { return { error: e.message } }
})

// ── IPC: background tasks ─────────────────────────────────────────────────────
agentPool.on('bg-task-event', (evt) => {
  mainWindow?.webContents.send('bg-task-event', evt)
})

ipcMain.handle('bg-task-list', async () => {
  try { return agentPool.getBackgroundTasks() }
  catch (e) { return { error: e.message } }
})

ipcMain.handle('bg-task-cancel', async (_, taskId) => {
  try { await agentPool.cancel(taskId); return { ok: true } }
  catch (e) { return { error: e.message } }
})

ipcMain.handle('bg-task-output', async (_, taskId) => {
  try {
    const tasks = agentPool.getBackgroundTasks()
    const task = tasks.find(t => t.id === taskId)
    return task ? (task.output || '') : ''
  } catch (e) { return { error: e.message } }
})

// ── IPC: AST search ───────────────────────────────────────────────────────────
ipcMain.handle('ast-search', async (_, pattern, cwd) => {
  try { return astSearch(pattern, cwd || currentProject) }
  catch (e) { return { error: e.message } }
})

ipcMain.handle('ast-patterns', async () => {
  try { return getSupportedPatterns() }
  catch (e) { return { error: e.message } }
})

ipcMain.handle('ast-search-status', async () => {
  try { return getSearchStatus() }
  catch (e) { return { error: e.message } }
})

// ── IPC: spec workflow ────────────────────────────────────────────────────────
ipcMain.handle('spec-init', async (_, featureName) => {
  try { return initSpec(featureName, currentProject) }
  catch (e) { return { error: e.message } }
})

ipcMain.handle('spec-phase', async (_, specDir) => {
  try { return getSpecPhase(specDir) }
  catch (e) { return { error: e.message } }
})

ipcMain.handle('spec-advance', async (_, specDir) => {
  try { return advancePhase(specDir) }
  catch (e) { return { error: e.message } }
})

// ── IPC: file watcher ─────────────────────────────────────────────────────────
function watchProject(dir) {
  if (projectWatcher) { projectWatcher.close(); projectWatcher = null }
  if (!dir || !fs.existsSync(dir)) return
  try {
    projectWatcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename || filename.startsWith('.')) return
      // Debounce: batch rapid changes into a single notification
      if (watchProject._timer) clearTimeout(watchProject._timer)
      watchProject._timer = setTimeout(() => {
        mainWindow?.webContents.send('files-changed', { dir, eventType, filename })
      }, 300)
    })
  } catch (e) {
    console.log('[main] fs.watch failed:', e.message)
  }
}

ipcMain.handle('watch-project', (_, dir) => {
  watchProject(dir)
  return { ok: true }
})

ipcMain.handle('unwatch-project', () => {
  if (projectWatcher) { projectWatcher.close(); projectWatcher = null }
  return { ok: true }
})

// ── lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow()
  startServer()
  waitForServer(ok => mainWindow?.webContents.send('server-status', { running: ok }))
})
app.on('window-all-closed', () => { stopServer(); app.quit() })
app.on('activate', () => { if (!mainWindow) createWindow() })
