'use strict'

const fsp = require('fs/promises')
const { parseTaskGraph } = require('../task-graph')
const { Orchestrator } = require('../orchestrator')
const compactor = require('../compactor')
const { astSearch, getSupportedPatterns, getSearchStatus } = require('../ast-search')
const { initSpec, getSpecPhase, advancePhase, getSpecArtifacts } = require('../spec-workflow')
const { generateSteeringDocs } = require('../steering-generator')

// ── validation ────────────────────────────────────────────────────────────────
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0 }

// ── IPC registration ──────────────────────────────────────────────────────────
function register(ipcMain, { getMainWindow, getCurrentProject, getAgentPool, findPython }) {
  let orchestratorInstance = null

  // ── compactor ───────────────────────────────────────────────────────────
  ipcMain.handle('compactor-status', async () => {
    const py = findPython()
    return compactor.getStatus(py)
  })

  ipcMain.handle('compactor-compress-messages', async (_, messages, options) => {
    if (!Array.isArray(messages)) return { error: 'messages must be an array' }
    const py = findPython()
    return compactor.compressMessages(py, messages, options)
  })

  ipcMain.handle('compactor-compress-text', async (_, text, contentType) => {
    if (typeof text !== 'string') return { error: 'text must be a string' }
    const py = findPython()
    return compactor.compressText(py, text, contentType)
  })

  // ── task graph ──────────────────────────────────────────────────────────
  ipcMain.handle('task-graph-parse', async (_, filePath) => {
    if (!isNonEmptyString(filePath)) return { error: 'filePath is required' }
    try {
      const md = await fsp.readFile(filePath, 'utf-8')
      const graph = parseTaskGraph(md)
      const nodes = {}
      for (const [id, node] of graph.nodes) nodes[id] = node
      return { nodes, startNodeId: graph.startNodeId, errors: graph.errors }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('task-graph-execute', async (_, filePath) => {
    if (!isNonEmptyString(filePath)) return { error: 'filePath is required' }
    try {
      const md = await fsp.readFile(filePath, 'utf-8')
      const graph = parseTaskGraph(md)

      // Read spec context (requirements + design) if this is a spec tasks.md
      let specContext = ''
      const specDir = require('path').dirname(filePath)
      try {
        const reqPath = require('path').join(specDir, 'requirements.md')
        const designPath = require('path').join(specDir, 'design.md')
        const fs = require('fs')
        if (fs.existsSync(reqPath)) {
          specContext += '## Requirements\n\n' + fs.readFileSync(reqPath, 'utf-8') + '\n\n'
        }
        if (fs.existsSync(designPath)) {
          specContext += '## Design\n\n' + fs.readFileSync(designPath, 'utf-8') + '\n\n'
        }
      } catch (_) { /* spec context is optional */ }

      orchestratorInstance = new Orchestrator({
        taskGraph: graph,
        agentPool: getAgentPool(),
        tasksFilePath: filePath,
        specContext,
      })
      orchestratorInstance.on('task-status-event', (evt) => {
        getMainWindow()?.webContents.send('task-status-event', evt)
      })
      orchestratorInstance.on('task-error', (evt) => {
        console.error('[orchestrator] Task error:', evt.nodeId, evt.error)
        getMainWindow()?.webContents.send('task-status-event', { nodeId: evt.nodeId, status: 'failed', error: evt.error })
        // Orchestrator pauses on failure — notify renderer so it can finalize UI
        getMainWindow()?.webContents.send('orchestrator-completed')
      })
      orchestratorInstance.on('completed', () => {
        console.log('[orchestrator] All tasks completed')
        getMainWindow()?.webContents.send('orchestrator-completed')
      })
      orchestratorInstance.start().catch(err => {
        console.error('[orchestrator] Start error:', err)
        getMainWindow()?.webContents.send('task-status-event', { nodeId: 'orchestrator', status: 'failed', error: err.message })
        getMainWindow()?.webContents.send('orchestrator-completed')
      })
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

  // ── background tasks ────────────────────────────────────────────────────
  ipcMain.handle('bg-task-list', async () => {
    try { return getAgentPool().getBackgroundTasks() }
    catch (e) { return { error: e.message } }
  })

  ipcMain.handle('bg-task-cancel', async (_, taskId) => {
    if (!isNonEmptyString(taskId)) return { error: 'taskId is required' }
    try { await getAgentPool().cancel(taskId); return { ok: true } }
    catch (e) { return { error: e.message } }
  })

  ipcMain.handle('bg-task-output', async (_, taskId) => {
    if (!isNonEmptyString(taskId)) return { error: 'taskId is required' }
    try {
      const tasks = getAgentPool().getBackgroundTasks()
      const task = tasks.find(t => t.id === taskId)
      return task ? (task.output || '') : ''
    } catch (e) { return { error: e.message } }
  })

  // ── AST search ──────────────────────────────────────────────────────────
  ipcMain.handle('ast-search', async (_, pattern, cwd) => {
    if (!pattern) return { error: 'pattern is required' }
    try { return astSearch(pattern, cwd || getCurrentProject()) }
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

  // ── spec workflow ───────────────────────────────────────────────────────
  ipcMain.handle('spec-init', async (_, featureName) => {
    if (!isNonEmptyString(featureName)) return { error: 'featureName is required' }
    const project = getCurrentProject()
    if (!project) return { error: 'No project open' }
    try { return initSpec(featureName, project) }
    catch (e) { return { error: e.message } }
  })

  ipcMain.handle('spec-phase', async (_, specDir) => {
    if (!isNonEmptyString(specDir)) return { error: 'specDir is required' }
    try { return getSpecPhase(specDir) }
    catch (e) { return { error: e.message } }
  })

  ipcMain.handle('spec-advance', async (_, specDir) => {
    if (!isNonEmptyString(specDir)) return { error: 'specDir is required' }
    try { return advancePhase(specDir) }
    catch (e) { return { error: e.message } }
  })

  // ── spec artifacts (used by renderer for spec workflow) ─────────────────
  ipcMain.handle('spec-artifacts', async (_, specDir) => {
    if (!isNonEmptyString(specDir)) return { error: 'specDir is required' }
    try { return getSpecArtifacts(specDir) }
    catch (e) { return { error: e.message } }
  })

  ipcMain.handle('spec-save-artifact', async (_, specDir, phase, content) => {
    if (!isNonEmptyString(specDir) || !isNonEmptyString(phase)) return { error: 'specDir and phase are required' }
    if (typeof content !== 'string') return { error: 'content must be a string' }
    const path = require('path')
    const filePath = path.join(specDir, `${phase}.md`)
    try {
      await fsp.writeFile(filePath, content, 'utf-8')
      return { ok: true }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('spec-config', async (_, specDir) => {
    if (!isNonEmptyString(specDir)) return { error: 'specDir is required' }
    const path = require('path')
    const configPath = path.join(specDir, '.config.kiro')
    try {
      const raw = await fsp.readFile(configPath, 'utf-8')
      return JSON.parse(raw)
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('spec-list', async () => {
    const project = getCurrentProject()
    if (!project) return []
    const path = require('path')
    const fs = require('fs')
    const specsDir = path.join(project, '.kiro', 'specs')
    if (!fs.existsSync(specsDir)) return []
    try {
      const entries = await fsp.readdir(specsDir, { withFileTypes: true })
      const specs = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const specDir = path.join(specsDir, entry.name)
        const configPath = path.join(specDir, '.config.kiro')
        try {
          const raw = await fsp.readFile(configPath, 'utf-8')
          const config = JSON.parse(raw)
          specs.push({ name: entry.name, specDir, currentPhase: config.currentPhase, lastModified: config.lastModified })
        } catch { specs.push({ name: entry.name, specDir, currentPhase: 'requirements' }) }
      }
      specs.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
      return specs
    } catch { return [] }
  })

  // ── steering docs ───────────────────────────────────────────────────────
  ipcMain.handle('steering-generate', async (_, { projectDir } = {}) => {
    if (!isNonEmptyString(projectDir)) return { error: 'projectDir is required' }
    const win = getMainWindow()
    try {
      win?.webContents.send('steering-progress', { stage: 'starting', message: 'Starting steering doc generation' })
      win?.webContents.send('steering-progress', { stage: 'analyzing', message: 'Analyzing project structure' })
      const result = await generateSteeringDocs(projectDir, getAgentPool())
      win?.webContents.send('steering-progress', { stage: 'complete', message: 'Steering doc generation complete' })
      return { ok: true, docsGenerated: result.docsGenerated }
    } catch (e) { return { error: e.message } }
  })

  ipcMain.handle('steering-status', async (_, { projectDir } = {}) => {
    const dir = projectDir || getCurrentProject()
    if (!isNonEmptyString(dir)) return { error: 'projectDir is required' }
    const path = require('path')
    const fs = require('fs')
    const steeringDir = path.join(dir, '.kiro', 'steering')
    try {
      if (!fs.existsSync(steeringDir)) return { exists: false, docCount: 0 }
      const entries = await fsp.readdir(steeringDir)
      const mdFiles = entries.filter(f => f.endsWith('.md'))
      return { exists: mdFiles.length > 0, docCount: mdFiles.length }
    } catch (e) { return { exists: false, docCount: 0 } }
  })
}

module.exports = { register }
