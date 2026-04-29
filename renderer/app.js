// QwenCoder Mac Studio — renderer
let allModels=[], selectedModel=null, loadedModelId=null, imageB64=null, isGenerating=false
let currentFile=null, currentProject=null
let attachedImgs = [] // [{name, b64}]
let activeProjectId = null
let activeSessionId = null
let activeSessionType = 'vibe'
let conversationHistory = [] // [{role, content, ts}]
let projectSettings = null  // context settings for active project
let compactorInstalled = false
let currentLspStatus = 'stopped' // track LSP status globally
let permMode = 'auto-edit' // 'auto-edit' or 'default'
let agentRole = 'general' // current agent role for vibe mode
let currentTodos = [] // persisted todo list for active session
let _lastCompactionStats = null

// ── fast assistant block renderer ─────────────────────────────────────────────
// Renders a collapsible block showing what the fast (0.8B) model did, similar
// to how tool-blocks show main-model tool activity.
const _FAST_ASSIST_ICONS = {
  vision: '👁️', extract_section: '✂️', fetch_summarize: '🌍',
  git_summarize: '🔀', rank_search: '🔎', error_diagnose: '🩺',
  todo_bootstrap: '📋', todo_watch: '👀', tool_validate: '✅',
}
function renderFastAssistBlock(ev) {
  const task = ev.task || 'assist'
  const icon = _FAST_ASSIST_ICONS[task] || '⚡'
  const label = (ev.label || '⚡ Fast Assistant').replace(/^⚡ Fast Assistant — ?/, '')
  const detail = ev.detail || ''
  const id = 'fa-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
  return `<details class="fast-assist-block" id="${id}">
    <summary class="fast-assist-header">
      <span class="fast-assist-icon">${icon}</span>
      <span class="fast-assist-badge">⚡ Fast</span>
      <span class="fast-assist-label">${esc(label)}</span>
      ${detail ? `<span class="fast-assist-detail">${esc(detail)}</span>` : ''}
    </summary>
  </details>`
}

// ── toast notifications ───────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 5000) {
  let container = document.getElementById('toast-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'toast-container'
    container.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none;'
    document.body.appendChild(container)
  }
  const toast = document.createElement('div')
  const bg = type === 'error' ? 'var(--red, #e74c3c)' : 'var(--green, #2ecc71)'
  toast.style.cssText = `background:${bg};color:#fff;padding:12px 20px;border-radius:8px;font-size:13px;max-width:400px;pointer-events:auto;opacity:0;transition:opacity 0.3s;box-shadow:0 4px 12px rgba(0,0,0,0.3);`
  toast.textContent = message
  container.appendChild(toast)
  requestAnimationFrame(() => { toast.style.opacity = '1' })
  setTimeout(() => {
    toast.style.opacity = '0'
    setTimeout(() => toast.remove(), 300)
  }, duration)
}

// ── init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  window.app.onServerStatus(s => { setServerStatus(s.running); if(s.running) refreshStatus().then(() => autoLoadLastModel()) })
  await refreshStatus()
  await autoLoadLastModel()

  // drag-drop images onto agent input
  const inputWrap = document.querySelector('.input-wrap')
  if (inputWrap) {
    inputWrap.addEventListener('dragover', e => { e.preventDefault(); inputWrap.style.borderColor='var(--green)' })
    inputWrap.addEventListener('dragleave', () => inputWrap.style.borderColor='')
    inputWrap.addEventListener('drop', e => {
      e.preventDefault(); inputWrap.style.borderColor=''
      for (const f of e.dataTransfer.files) { if (f.type.startsWith('image/')) addImageFile(f) }
    })
  }
  // paste images into agent
  document.addEventListener('paste', e => {
    if (document.querySelector('.ed-tab.active')?.dataset?.tab !== 'agent') return
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) { addImageFile(item.getAsFile()); e.preventDefault() }
    }
  })

  const dz = document.getElementById('dropZone')
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.borderColor='var(--accent)' })
  dz.addEventListener('dragleave', () => dz.style.borderColor='')
  dz.addEventListener('drop', e => { e.preventDefault(); dz.style.borderColor=''; const f=e.dataTransfer.files[0]; if(f?.type.startsWith('image/')) readImageFile(f) })
  currentProject = await window.app.getProject()
  if (currentProject) startFileWatcher(currentProject)
  await loadProjectList()
  await loadContextSettings()
  await loadApiKeys()
  await restoreActiveSpec()
  checkCompactor()
  checkSearchEngine()
  refreshTelegramStatus()
  refreshWelcomeProjectBar()
  initLspStatus()
  initCalibrationStatus()
  refreshSteeringDocs()

  // Listen for telegram-unavailable events from the main process
  window.app.onTelegramUnavailable?.(({ reason, recordingPath }) => {
    const msg = recordingPath
      ? `Could not send video to Telegram: ${reason}`
      : `Telegram send failed: ${reason}`
    showToast(msg, 'error', 8000)
  })
})

// ── panels ────────────────────────────────────────────────────────────────────
function showPanel(name, btn) {
  document.querySelectorAll('.ab-btn').forEach(b => b.classList.remove('active'))
  document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('active'))
  btn.classList.add('active')
  document.getElementById('sp-'+name).classList.add('active')
  if(name==='git' && currentProject) refreshGit()
  if(name==='tasks') loadTaskGraph()
  if(name==='specs') loadSpecPanel()
}
function switchMainTab(name, btn) {
  document.querySelectorAll('.ed-tab').forEach(t => t.classList.remove('active'))
  document.querySelectorAll('.main-panel').forEach(p => p.classList.remove('active'))
  btn.classList.add('active')
  document.getElementById('mt-'+name).classList.add('active')
  if (name === 'agents') loadAgentRoles()
}

// ── permission mode toggle ────────────────────────────────────────────────────
function togglePermMode() {
  const btn = document.getElementById('permToggle')
  if (permMode === 'auto-edit') {
    permMode = 'default'
    btn.textContent = '🔒 Ask'
    btn.className = 'perm-toggle ask'
    btn.title = 'Agent will ask before making changes'
  } else {
    permMode = 'auto-edit'
    btn.textContent = '🔓 Auto'
    btn.className = 'perm-toggle auto'
    btn.title = 'Agent auto-approves all changes'
  }
}

// ── agent role picker ─────────────────────────────────────────────────────────
const ROLE_DESCRIPTIONS = {
  'general': 'Full toolset — code, search, browse, LSP diagnostics',
  'implementation': 'Focused on writing code — LSP diagnostics, definitions, code actions',
  'explore': 'Read-only exploration — symbols, hover, definitions, references',
  'context-gather': 'Gather context — symbols, definitions, references, type info',
  'code-search': 'Search-focused — symbols, references, workspace search, call hierarchy',
}

function changeAgentRole(role) {
  agentRole = role
  const sel = document.getElementById('roleSelect')
  if (sel) sel.title = ROLE_DESCRIPTIONS[role] || 'Agent role'
}

// ── server ────────────────────────────────────────────────────────────────────
async function refreshStatus() {
  const s = await window.app.serverStatus()
  setServerStatus(s.running)
  if(s.running) { if(s.models) renderModels(s.models); if(s.loaded) setLoadedModel(s.loaded) }
}

async function autoLoadLastModel() {
  if (loadedModelId) return  // already loaded
  if (!allModels.length) return  // no models available
  try {
    const appSettings = await window.app.getAppSettings()
    // Prefer saved last model, then fall back to the 35B default by name match
    const targetPath = appSettings.lastModelPath ||
      allModels.find(m => m.path && m.path.includes('Qwen3.6-35B-A3B-MLX-8bit'))?.path ||
      allModels[0]?.path
    if (!targetPath) return
    const match = allModels.find(m => m.path === targetPath) || allModels[0]
    if (!match) return
    const modelName = _formatModelName(match.id)
    _showModelLoadingOverlay(modelName)
    appendMsg('system', `⏳ Auto-loading model: ${modelName}`)
    const r = await window.app.loadModel(match.path)
    if (r && r.error) {
      _hideModelLoadingOverlay()
      appendMsg('system', `⚠️ Auto-load failed: ${r.error}`)
    } else {
      setLoadedModel(r.model_id || match.id)
      window.app.saveAppSettings({ lastModelPath: match.path })
      _hideModelLoadingOverlay()
      appendMsg('system', `✅ Model loaded: ${modelName}`)
    }
  } catch (err) {
    _hideModelLoadingOverlay()
    appendMsg('system', `⚠️ Auto-load failed: ${err.message || 'Unknown error'}`)
  }
}
function setServerStatus(r) {
  document.getElementById('statusDot').className = 'status-dot'+(r?' online':'')
  document.getElementById('statusText').textContent = r?'Server running':'Starting...'
  if(r) setTimeout(refreshStatus, 8000)
}

// ── models ────────────────────────────────────────────────────────────────────
function renderModels(models) {
  allModels = models
  // Update sidebar model list
  const l = document.getElementById('modelList')
  if(!models.length) { l.innerHTML='<div class="model-empty">No models</div>'; return }
  l.innerHTML = models.map(m => {
    const name = _formatModelName(m.id)
    const cls = m.id===loadedModelId ? 'model-card loaded' : (selectedModel?.id===m.id ? 'model-card selected' : 'model-card')
    return `<div class="${cls}" id="card-${CSS.escape(m.id)}" onclick="selectModel('${m.id}','${m.path}')">
      <div class="model-card-name">${esc(name)}</div>
      <div class="model-card-meta"><span class="badge ${m.vision?'badge-vision':'badge-text'}">${m.vision?'👁 Vision':'💬 Text'}</span><span class="badge badge-type">${esc(m.model_type)}</span></div></div>`
  }).join('')
  // Also update the central model switcher
  _renderModelSwitcher(models)
  // Update extraction model dropdown
  populateExtractionModelList(models)
  // Refresh extraction model status
  refreshExtractionModelStatus()
}

function _formatModelName(id) {
  // Turn "qwen3-vl-lmstudio-community-Qwen3-30B-A3B-MLX-4bit" into "Qwen3 30B A3B MLX 4bit"
  // Strip the qwen3-vl- prefix the server adds, then clean up
  let name = id.replace(/^qwen3-vl-/, '')
  // Remove common org prefixes
  name = name.replace(/^(lmstudio-community|mlx-community|bartowski|unsloth)-?/i, '')
  // Replace hyphens with spaces for readability
  name = name.replace(/-/g, ' ')
  return name || id
}

function _renderModelSwitcher(models) {
  const list = document.getElementById('modelSwitcherList')
  const nameEl = document.getElementById('modelSwitcherName')
  if (!list) return

  // Update current model display
  if (loadedModelId) {
    nameEl.textContent = _formatModelName(loadedModelId)
    nameEl.style.color = ''
  } else {
    nameEl.textContent = 'No model loaded'
    nameEl.style.color = 'var(--muted)'
  }

  if (!models.length) { list.innerHTML = '<div class="ms-empty">No models found in ~/.lmstudio/models/</div>'; return }

  list.innerHTML = models.map((m, i) => {
    const name = _formatModelName(m.id)
    const isLoaded = m.id === loadedModelId
    const icon = m.vision ? '👁️' : '💬'
    const cls = isLoaded ? 'ms-item active' : 'ms-item'
    // Show the original path segments for context
    const pathDisplay = m.id.replace(/^qwen3-vl-/, '').replace(/-/g, '/')
    return `<div class="${cls}" data-ms-idx="${i}">
      <div class="ms-item-icon">${icon}</div>
      <div class="ms-item-info">
        <div class="ms-item-name">${esc(name)}</div>
        <div class="ms-item-path">${esc(pathDisplay)}</div>
        <div class="ms-item-badges">
          <span class="badge ${m.vision?'badge-vision':'badge-text'}">${m.vision?'Vision':'Text'}</span>
          <span class="badge badge-type">${esc(m.model_type)}</span>
        </div>
      </div>
      ${isLoaded ? '<div class="ms-item-check">✓</div>' : ''}
    </div>`
  }).join('')

  // Use event delegation instead of inline onclick to avoid string escaping issues
  list.onclick = (e) => {
    const item = e.target.closest('[data-ms-idx]')
    if (!item) return
    const idx = parseInt(item.dataset.msIdx, 10)
    const m = models[idx]
    if (m) switchModelFromSwitcher(m.id, m.path)
  }
}

function toggleModelSwitcher() {
  const bar = document.getElementById('modelSwitcherBar')
  const dd = document.getElementById('modelSwitcherDropdown')
  const isOpen = dd.style.display !== 'none'
  dd.style.display = isOpen ? 'none' : 'block'
  bar.classList.toggle('open', !isOpen)
  // Close on outside click
  if (!isOpen) {
    const closer = (e) => {
      if (!bar.contains(e.target)) {
        dd.style.display = 'none'
        bar.classList.remove('open')
        document.removeEventListener('click', closer)
      }
    }
    setTimeout(() => document.addEventListener('click', closer), 0)
  }
}

async function switchModelFromSwitcher(id, modelPath) {
  if (id === loadedModelId) {
    // Already loaded, just close
    document.getElementById('modelSwitcherDropdown').style.display = 'none'
    document.getElementById('modelSwitcherBar').classList.remove('open')
    return
  }
  // Show loading state
  const nameEl = document.getElementById('modelSwitcherName')
  const prevText = nameEl.textContent
  const modelName = _formatModelName(id)
  nameEl.innerHTML = '<span class="model-loading-spinner"></span> Loading ' + esc(modelName) + '...'
  // Mark the clicked item as loading
  document.querySelectorAll('.ms-item').forEach(el => el.classList.remove('loading'))
  const idx = allModels.findIndex(m => m.id === id)
  const targetItem = idx >= 0 ? document.querySelector(`.ms-item[data-ms-idx="${idx}"]`) : null
  if (targetItem) targetItem.classList.add('loading')

  // Show the loading overlay in the chat area
  _showModelLoadingOverlay(modelName)
  document.getElementById('modelSwitcherBtn').classList.add('loading')

  try {
    const r = await window.app.loadModel(modelPath)
    if (r && r.error) {
      nameEl.textContent = prevText
      if (targetItem) targetItem.classList.remove('loading')
      document.getElementById('modelSwitcherBtn').classList.remove('loading')
      _hideModelLoadingOverlay()
      appendMsg('system', `⚠️ Failed to load model: ${r.error}`)
    } else {
      setLoadedModel(r.model_id || id)
      window.app.saveAppSettings({ lastModelPath: modelPath })
      document.getElementById('modelSwitcherBtn').classList.remove('loading')
      _hideModelLoadingOverlay()
      appendMsg('system', `✅ Model loaded: ${modelName}`)
    }
  } catch (err) {
    nameEl.textContent = prevText
    if (targetItem) targetItem.classList.remove('loading')
    document.getElementById('modelSwitcherBtn').classList.remove('loading')
    _hideModelLoadingOverlay()
    appendMsg('system', `⚠️ Failed to load model: ${err.message || 'Unknown error'}`)
  }
  document.getElementById('modelSwitcherDropdown').style.display = 'none'
  document.getElementById('modelSwitcherBar').classList.remove('open')
}

function selectModel(id, path) {
  selectedModel={id,path}
  document.querySelectorAll('.model-card').forEach(c => { c.className = c.id==='card-'+CSS.escape(loadedModelId)?'model-card loaded':(c.id==='card-'+CSS.escape(id)?'model-card selected':'model-card') })
  const b=document.getElementById('loadBtn'), t=document.getElementById('loadBtnText')
  b.disabled=id===loadedModelId; t.textContent=id===loadedModelId?'Already loaded':`Load ${_formatModelName(id)}`
}
async function loadSelected() {
  if(!selectedModel) return
  const b=document.getElementById('loadBtn'), t=document.getElementById('loadBtnText')
  const modelName = _formatModelName(selectedModel.id)
  b.disabled=true; t.innerHTML='<span class="spinner"></span> Loading...'
  _showModelLoadingOverlay(modelName)
  try {
    const r=await window.app.loadModel(selectedModel.path)
    setLoadedModel(r.model_id||selectedModel.id)
    window.app.saveAppSettings({ lastModelPath: selectedModel.path })
    t.textContent='Already loaded'
    _hideModelLoadingOverlay()
    appendMsg('system', `✅ Model loaded: ${modelName}`)
  }
  catch {
    t.textContent='Failed'
    b.disabled=false
    _hideModelLoadingOverlay()
    appendMsg('system', `⚠️ Failed to load model: ${modelName}`)
  }
}
function setLoadedModel(id) {
  loadedModelId=id
  document.getElementById('loadedModelName').textContent = id ? _formatModelName(id) : 'None'
  document.getElementById('f-modelid').textContent=id||'—'
  renderModels(allModels)
  if (!id && typeof clearCalibrationUI === 'function') clearCalibrationUI()
}

// ── model loading overlay ─────────────────────────────────────────────────────
let _modelLoadTimer = null
function _showModelLoadingOverlay(modelName) {
  // Remove any existing overlay
  _hideModelLoadingOverlay()
  const out = document.getElementById('agentOutput')
  if (!out) return
  // Show overlay on top of the build picker or chat
  const overlay = document.createElement('div')
  overlay.id = 'modelLoadingOverlay'
  overlay.className = 'model-loading-overlay'
  overlay.innerHTML = `
    <div class="model-loading-card">
      <div class="model-loading-icon">
        <div class="model-loading-ring"></div>
        <span class="model-loading-emoji">🤖</span>
      </div>
      <div class="model-loading-title">Loading Model</div>
      <div class="model-loading-name">${esc(modelName)}</div>
      <div class="model-loading-hint" id="modelLoadingHint">Initializing...</div>
      <div class="model-loading-bar"><div class="model-loading-bar-fill" id="modelLoadingBarFill"></div></div>
    </div>`
  out.appendChild(overlay)

  // Animate the hint text through stages
  let stage = 0
  const hints = ['Initializing...', 'Loading weights into memory...', 'Preparing inference engine...', 'Almost ready...']
  _modelLoadTimer = setInterval(() => {
    stage++
    const hint = document.getElementById('modelLoadingHint')
    if (hint && stage < hints.length) hint.textContent = hints[stage]
  }, 3000)
}

function _hideModelLoadingOverlay() {
  if (_modelLoadTimer) { clearInterval(_modelLoadTimer); _modelLoadTimer = null }
  const overlay = document.getElementById('modelLoadingOverlay')
  if (overlay) {
    overlay.classList.add('fade-out')
    setTimeout(() => overlay.remove(), 300)
  }
}

// ── files ─────────────────────────────────────────────────────────────────────
async function openProject() {
  const p = await window.app.openFolder()
  if(!p) return
  currentProject = p
  await renderFileTree(p, document.getElementById('fileTree'))
  startFileWatcher(p)
}

// ── file watcher for auto-refresh ─────────────────────────────────────────────
let _lastWatchedDir = null
function startFileWatcher(dir) {
  if (!dir) return
  if (_lastWatchedDir === dir) return // already watching
  _lastWatchedDir = dir
  window.app.offFilesChanged()
  window.app.watchProject(dir)
  window.app.onFilesChanged((ev) => {
    // Refresh the file tree
    if (currentProject) {
      renderFileTree(currentProject, document.getElementById('fileTree'))
    }
    // Auto-refresh live preview if an HTML file changed and preview is open
    if (previewOpen && ev.filename && /\.(html?|svg)$/i.test(ev.filename)) {
      autoRefreshLivePreview(ev)
    }
    // Auto-reload task graph when tasks.md changes on disk (e.g. from orchestrator persistence)
    if (currentTasksPath && ev.filename && ev.filename.endsWith('tasks.md')) {
      // Debounce: only reload if we're not mid-execution (status events handle that)
      // This catches external edits and post-execution persistence
      loadTaskGraph(currentTasksPath).catch(() => {})
    }
  })
}

async function autoRefreshLivePreview(ev) {
  // If we have a current file open that matches, re-read and refresh
  if (currentFile && ev.filename && currentFile.endsWith(ev.filename)) {
    const content = await window.app.readFile(currentFile)
    if (content !== null) {
      document.getElementById('editorArea').value = content
      refreshPreview()
    }
  }
}
async function renderFileTree(dir, container) {
  const entries = await window.app.readDir(dir)
  if(!entries.length) { container.innerHTML='<div class="model-empty">Empty</div>'; return }
  container.innerHTML = entries.map(e =>
    e.isDir
      ? `<div class="ft-item dir" onclick="toggleDir(this,'${e.path.replace(/'/g,"\\'")}')">📁 ${e.name}</div><div class="ft-children" style="display:none;padding-left:12px"></div>`
      : `<div class="ft-item file" onclick="openFile('${e.path.replace(/'/g,"\\'")}','${e.name}')">${fileIcon(e.name)} ${e.name}</div>`
  ).join('')
}
async function toggleDir(el, path) {
  const children = el.nextElementSibling
  if(children.style.display==='none') { children.style.display='block'; await renderFileTree(path, children) }
  else children.style.display='none'
}
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase()
  const map = {js:'📜',ts:'📘',py:'🐍',html:'🌐',css:'🎨',json:'📋',md:'📝',sh:'⚡',swift:'🦅',rs:'🦀',go:'🐹',rb:'💎',java:'☕',c:'⚙️',cpp:'⚙️',h:'⚙️'}
  return map[ext]||'📄'
}
async function openFile(path, name) {
  const content = await window.app.readFile(path)
  if(content===null) return
  currentFile = path
  document.getElementById('editorFileName').textContent = name
  document.getElementById('editorArea').value = content
  document.getElementById('saveBtn').style.display = 'inline-block'
  updatePreviewToggle()
  switchMainTab('editor', document.querySelector('[data-tab="editor"]'))
  // Fetch symbols when LSP is ready
  if (currentLspStatus === 'ready') {
    fetchAndRenderSymbols(path)
  }
}
async function saveFile() {
  if(!currentFile) return
  const r = await window.app.writeFile(currentFile, document.getElementById('editorArea').value)
  if(r.ok) { const b=document.getElementById('saveBtn'); b.textContent='Saved!'; setTimeout(()=>b.textContent='Save',1000) }
}

// ── git ───────────────────────────────────────────────────────────────────────
async function refreshGit() {
  if(!currentProject) return
  const s = await window.app.gitStatus(currentProject)
  document.getElementById('gitBranch').textContent = s.branch ? `⎇ ${s.branch}` : 'Not a git repo'
  const stMap = {M:'st-m',A:'st-a',D:'st-d','??':'st-a'}
  document.getElementById('gitChanges').innerHTML = s.files.length
    ? s.files.map(f => `<div class="git-file"><span class="st ${stMap[f.status]||'st-u'}">${f.status}</span><span>${f.file}</span></div>`).join('')
    : '<div class="model-empty">Clean</div>'
  const log = await window.app.gitLog(currentProject)
  document.getElementById('gitLog').innerHTML = log.map(c => `<div class="git-commit"><span class="hash">${c.hash}</span>${c.message}</div>`).join('')
}

// ── projects ──────────────────────────────────────────────────────────────────
async function loadProjectList() {
  const projects = await window.app.listProjects()
  const sel = document.getElementById('projectSelect')
  if (!sel) return
  sel.innerHTML = '<option value="">— No project —</option>' +
    projects.map(p => `<option value="${p.id}" ${p.id===activeProjectId?'selected':''}>${p.name}</option>`).join('')
}

async function newProject() {
  const dir = await window.app.openFolder()
  if (!dir) return
  const name = dir.split('/').pop()
  const p = await window.app.createProject(name, dir)
  activeProjectId = p.id
  currentProject = p.directory
  await loadProjectList()
  await renderFileTree(dir, document.getElementById('fileTree'))
  startFileWatcher(dir)
  document.getElementById('projectPath').textContent = dir
  conversationHistory = []
  clearChatOutput()
  appendMsg('system', `📁 Project "${p.name}" created`)
  await loadContextSettings()
  await loadSessions()
}

async function switchProject(id) {
  if (!id) {
    activeProjectId=null; activeSessionId=null; currentProject=null; conversationHistory=[]
    clearChatOutput(); document.getElementById('projectPath').textContent=''
    renderSessionSelect([]); updateSessionInfo()
    window.app.unwatchProject(); _lastWatchedDir = null
    await loadContextSettings(); return
  }
  const p = await window.app.openProjectById(id)
  if (!p) return
  activeProjectId = p.id
  currentProject = p.directory
  document.getElementById('projectPath').textContent = p.directory
  await renderFileTree(p.directory, document.getElementById('fileTree'))
  startFileWatcher(p.directory)
  await loadContextSettings()
  await restoreActiveSpec()
  await loadSessions(p.activeSession)
  refreshWelcomeProjectBar()
  refreshSteeringDocs()
}

// ── sessions ──────────────────────────────────────────────────────────────────
async function loadSessions(preferredId) {
  if (!activeProjectId) { renderSessionSelect([]); updateSessionInfo(); return }
  const sessions = await window.app.listSessions(activeProjectId)
  renderSessionSelect(sessions)
  // pick preferred or first
  const target = preferredId && sessions.find(s => s.id === preferredId) ? preferredId : sessions[0]?.id
  if (target) {
    activeSessionId = target
    const sess = sessions.find(s => s.id === target)
    activeSessionType = (sess && sess.type) || 'vibe'
    document.getElementById('sessionSelect').value = target
    conversationHistory = await window.app.getSessionMsgs(activeProjectId, target)
    await restoreChatFromSnapshot()
    await restoreTodos()
    await restoreWorkflowState()
  } else {
    activeSessionId = null; activeSessionType = 'vibe'; conversationHistory = []; clearChatOutput()
  }
  updateSessionInfo()
}

function renderSessionSelect(sessions) {
  const sel = document.getElementById('sessionSelect')
  if (!sel) return
  sel.innerHTML = sessions.map(s => {
    const icon = (s.type || 'vibe') === 'spec' ? '📋' : '💬'
    return `<option value="${s.id}" ${s.id===activeSessionId?'selected':''}>${icon} ${s.name} (${s.messageCount || 0})</option>`
  }).join('') || '<option value="">No sessions</option>'
}

async function switchSession(id) {
  if (!id || !activeProjectId) return
  // Save current session's chat snapshot and workflow state before switching
  await saveChatSnapshot()
  await saveWorkflowState()

  // Tear down any in-flight agent event listeners from the previous session.
  // Without this, stale onQwenEvent handlers keep firing into the new session's
  // DOM, causing the old status to flash/fight with the new session's UI.
  window.app.offQwenEvents()
  window.app.offOrchestratorCompleted()
  if (isGenerating) {
    finishGeneration()
  }

  activeSessionId = id
  const sessions = await window.app.listSessions(activeProjectId)
  const sess = sessions.find(s => s.id === id)
  activeSessionType = (sess && sess.type) || 'vibe'
  conversationHistory = await window.app.getSessionMsgs(activeProjectId, id)
  // Reset agent stats bar from previous session to prevent visual overlap
  const statsBar = document.getElementById('agentStats')
  if (statsBar) { statsBar.style.display = 'none'; statsBar.innerHTML = '' }
  await restoreChatFromSnapshot()
  await restoreTodos()
  await restoreWorkflowState()
  updateSessionInfo()
}

async function newSession(sessionType) {
  if (!activeProjectId) { appendMsg('system', '⚠️ Select a project first.'); return }
  // Save current session's chat snapshot and workflow state before creating new one
  await saveChatSnapshot()
  await saveWorkflowState()

  // Tear down stale agent event listeners from the previous session
  window.app.offQwenEvents()
  window.app.offOrchestratorCompleted()
  if (isGenerating) {
    finishGeneration()
  }

  const sessions = await window.app.listSessions(activeProjectId)
  const type = sessionType || 'vibe'
  const prefix = type === 'spec' ? 'Spec' : 'Vibe'
  const count = sessions.filter(s => (s.type || 'vibe') === type).length
  const name = `${prefix} ${count + 1}`
  const sess = await window.app.createSession(activeProjectId, name, type)
  activeSessionId = sess.id
  activeSessionType = type
  conversationHistory = []
  clearChatOutput()
  await loadSessions(sess.id)
  appendMsg('system', `💬 New ${type} session: ${name}`)
  if (type === 'spec') {
    showInlineSpecWorkflow()
  }
}

async function startSessionWithType(type) {
  if (!activeProjectId) { appendMsg('system', '⚠️ Select a project first.'); return }
  await newSession(type)
}

// ── welcome page project selector ─────────────────────────────────────────────
async function welcomePickProject() {
  const dir = await window.app.openFolder()
  if (!dir) return
  const name = dir.split('/').pop()
  const p = await window.app.createProject(name, dir)
  activeProjectId = p.id
  currentProject = p.directory
  await loadProjectList()
  await renderFileTree(dir, document.getElementById('fileTree'))
  startFileWatcher(dir)
  document.getElementById('projectPath').textContent = dir
  await loadContextSettings()
  await loadSessions()
  refreshWelcomeProjectBar()
}

async function welcomeSwitchProject(id) {
  if (!id) return
  await switchProject(id)
  refreshWelcomeProjectBar()
}

async function refreshWelcomeProjectBar() {
  const sel = document.getElementById('welcomeProjectSelect')
  const pathEl = document.getElementById('welcomeProjectPath')
  if (!sel) return
  const projects = await window.app.listProjects()
  sel.innerHTML = '<option value="">— Select a project —</option>' +
    projects.map(p => `<option value="${p.id}" ${p.id === activeProjectId ? 'selected' : ''}>${p.name}</option>`).join('')
  if (pathEl) {
    pathEl.textContent = currentProject || ''
  }
}

async function renameCurrentSession() {
  if (!activeProjectId || !activeSessionId) return
  const sel = document.getElementById('sessionSelect')
  const current = sel.options[sel.selectedIndex]?.text?.replace(/\s*\(\d+\)$/, '') || 'Session'
  const name = prompt('Session name:', current)
  if (!name) return
  await window.app.renameSession(activeProjectId, activeSessionId, name)
  await loadSessions(activeSessionId)
}

async function deleteCurrentSession() {
  if (!activeProjectId || !activeSessionId) return
  if (!confirm('Delete this session and its history?')) return
  await window.app.deleteSession(activeProjectId, activeSessionId)
  activeSessionId = null
  await loadSessions()
}

function updateSessionInfo() {
  const el = document.getElementById('sessionInfo')
  if (!el) return
  if (!activeSessionId) { el.textContent = ''; return }
  const count = conversationHistory.length
  el.textContent = `${count} msg${count !== 1 ? 's' : ''}`
  // update compact button state
  const btn = document.getElementById('compactBtn')
  if (btn) {
    if (!compactorInstalled) {
      btn.className = 'compact-btn missing'
      btn.title = 'claw-compactor not installed'
    } else {
      btn.className = 'compact-btn'
      btn.title = 'Compress conversation with claw-compactor'
    }
  }
}

function clearChatOutput() {
  // Reset the persistent todo panel
  const todoPanel = document.getElementById('todoPanel')
  if (todoPanel) { todoPanel.style.display = 'none'; todoPanel.classList.remove('collapsed') }
  const todoPanelBody = document.getElementById('todoPanelBody')
  if (todoPanelBody) todoPanelBody.innerHTML = ''
  currentTodos = []

  // Clear persisted snapshot and todos for this session
  if (activeProjectId && activeSessionId) {
    window.app.saveSessionSnapshot(activeProjectId, activeSessionId, null)
    window.app.saveSessionTodos(activeProjectId, activeSessionId, [])
  }

  // Reset the stats bar
  const statsBar = document.getElementById('agentStats')
  if (statsBar) { statsBar.style.display = 'none'; statsBar.innerHTML = '' }

  const specResumeHtml = currentSpecDir ? `
        <button class="build-card build-card-spec" onclick="showInlineSpecWorkflow()">
          <span class="build-card-icon">📐</span>
          <span class="build-card-label">Resume Spec</span>
          <span class="build-card-desc">Continue working on "${currentSpecName || 'spec'}"</span>
        </button>` : `
        <button class="build-card build-card-spec" onclick="openSpecPanel()">
          <span class="build-card-icon">📐</span>
          <span class="build-card-label">Spec</span>
          <span class="build-card-desc">Plan first. AI generates requirements, design, and tasks before you code.</span>
        </button>`

  document.getElementById('agentOutput').innerHTML = `
    <div class="build-picker">
      <div class="build-picker-icon">✦</div>
      <div class="build-picker-title">Let's build</div>
      <div class="build-picker-subtitle">Plan, search, or build anything</div>
      <div class="build-picker-project" id="welcomeProjectBar">
        <div class="bp-project-row" id="welcomeProjectRow">
          <span class="bp-project-icon">📁</span>
          <select id="welcomeProjectSelect" class="bp-project-select" onchange="welcomeSwitchProject(this.value)">
            <option value="">— Select a project —</option>
          </select>
          <button class="bp-project-btn" onclick="welcomePickProject()" title="Open folder">Open Folder</button>
        </div>
        <div class="bp-project-path" id="welcomeProjectPath"></div>
      </div>
      <div class="build-picker-cards">
        <button class="build-card build-card-vibe" onclick="startSessionWithType('vibe')">
          <span class="build-card-icon">💬</span>
          <span class="build-card-label">Vibe</span>
          <span class="build-card-desc">Chat and build. Jump straight in and iterate.</span>
        </button>
        ${specResumeHtml}
      </div>
    </div>`
  refreshWelcomeProjectBar()
}

function restoreChat() {
  const out = document.getElementById('agentOutput')
  out.innerHTML = ''
  if (!conversationHistory.length) { clearChatOutput(); return }
  for (const msg of conversationHistory) {
    if (msg.role === 'user') appendMsg('user', esc(msg.content))
    else if (msg.role === 'assistant') {
      out.insertAdjacentHTML('beforeend', `<div class="msg-block"><div class="msg-text">${renderMd(msg.content)}</div></div>`)
    }
  }
  scrollOutput()
}

/** Save the current chat HTML + todo state as a snapshot for the active session */
async function saveChatSnapshot() {
  if (!activeProjectId || !activeSessionId) return
  const out = document.getElementById('agentOutput')
  if (!out) return
  // Don't snapshot the empty "Let's build" picker
  if (out.querySelector('.build-picker')) return
  const snapshot = out.innerHTML
  if (snapshot) {
    await window.app.saveSessionSnapshot(activeProjectId, activeSessionId, snapshot)
  }
  // Also persist workflow state alongside the snapshot
  await saveWorkflowState()
}

/** Restore chat from a rich HTML snapshot, falling back to plain message replay */
async function restoreChatFromSnapshot() {
  if (!activeProjectId || !activeSessionId) {
    restoreChat()
    return
  }
  const snapshot = await window.app.getSessionSnapshot(activeProjectId, activeSessionId)
  if (snapshot) {
    const out = document.getElementById('agentOutput')
    out.innerHTML = snapshot
    scrollOutput()
  } else {
    restoreChat()
  }
}

/** Restore persisted todos for the active session */
async function restoreTodos() {
  if (!activeProjectId || !activeSessionId) return
  const todos = await window.app.getSessionTodos(activeProjectId, activeSessionId)
  currentTodos = todos || []
  if (currentTodos.length > 0) {
    updateTodoPanel(currentTodos, 'restored')
  } else {
    const todoPanel = document.getElementById('todoPanel')
    if (todoPanel) { todoPanel.style.display = 'none' }
    const todoPanelBody = document.getElementById('todoPanelBody')
    if (todoPanelBody) todoPanelBody.innerHTML = ''
  }
}

/** Save the current spec + task graph state for the active session */
async function saveWorkflowState() {
  if (!activeProjectId || !activeSessionId) return
  const state = {
    specDir: currentSpecDir || null,
    specName: currentSpecName || null,
    tasksPath: currentTasksPath || null,
  }
  await window.app.saveSessionWorkflowState(activeProjectId, activeSessionId, state)
}

/** Restore spec + task graph state for the active session */
async function restoreWorkflowState() {
  if (!activeProjectId || !activeSessionId) {
    currentTaskGraph = null
    currentTasksPath = null
    renderTaskGraph({ nodes: {} })
    return
  }
  const state = await window.app.getSessionWorkflowState(activeProjectId, activeSessionId)
  if (state) {
    // Restore spec context
    if (state.specDir) {
      currentSpecDir = state.specDir
      currentSpecName = state.specName || null
    } else {
      currentSpecDir = null
      currentSpecName = null
    }
    // Restore task graph from persisted tasks.md path
    if (state.tasksPath) {
      currentTasksPath = state.tasksPath
      try {
        await loadTaskGraph(state.tasksPath)
      } catch (_) {
        // Task file may have been deleted — clear gracefully
        currentTaskGraph = null
        currentTasksPath = null
      }
    } else if (state.specDir) {
      // No explicit tasksPath but we have a spec — try loading its tasks.md
      const specTasksPath = state.specDir + '/tasks.md'
      try {
        await loadTaskGraph(specTasksPath)
      } catch (_) {
        currentTaskGraph = null
        currentTasksPath = null
      }
    } else {
      currentTaskGraph = null
      currentTasksPath = null
      document.getElementById('taskNodeList').innerHTML = '<div class="model-empty" id="taskGraphEmpty">No task graph loaded. Open a Tasks.md file or start a spec workflow.</div>'
    }
  } else {
    // No workflow state — clear task graph sidebar
    currentTaskGraph = null
    currentTasksPath = null
    document.getElementById('taskNodeList').innerHTML = '<div class="model-empty" id="taskGraphEmpty">No task graph loaded. Open a Tasks.md file or start a spec workflow.</div>'
  }
}

async function saveToHistory(role, content) {
  if (!activeProjectId || !activeSessionId) return
  await window.app.appendSessionMsg(activeProjectId, activeSessionId, { role, content })
  conversationHistory = await window.app.getSessionMsgs(activeProjectId, activeSessionId)
  updateSessionInfo()
}

// ── copy ──────────────────────────────────────────────────────────────────────
function copy(id,btn){copyText(document.getElementById(id).textContent,btn)}
function copyText(t,btn){navigator.clipboard.writeText(t).then(()=>{const o=btn.textContent;btn.textContent='✓';setTimeout(()=>btn.textContent=o,1000)})}

// ── image attachments ──────────────────────────────────────────────────────────
function addImageFile(file) {
  const reader = new FileReader()
  reader.onload = ev => {
    attachedImgs.push({ name: file.name, b64: ev.target.result })
    renderAttachedImages()
  }
  reader.readAsDataURL(file)
}
function attachImages(e) { for (const f of e.target.files) { if (f.type.startsWith('image/')) addImageFile(f) } }
function removeAttachedImg(idx) { attachedImgs.splice(idx, 1); renderAttachedImages() }
function renderAttachedImages() {
  const c = document.getElementById('attachedImages')
  c.innerHTML = attachedImgs.map((img, i) =>
    `<div class="attached-img"><img src="${img.b64}"><button class="remove-img" onclick="removeAttachedImg(${i})">×</button></div>`
  ).join('')
}

// ── agent: streaming generation ───────────────────────────────────────────────
const THINK_OPEN=/<think>/i, THINK_CLOSE=/<\/think>/i

function sendAgent() {
  if(isGenerating) return
  const prompt = document.getElementById('agentPrompt').value.trim()
  if(!prompt) return

  // ── slash command interception (Task 10.7) ──
  if (prompt.startsWith('/')) {
    const parsed = parseSlashCommand(prompt)
    if (parsed && SLASH_COMMANDS.has(parsed.command)) {
      document.getElementById('agentPrompt').value = ''
      hideSlashAutocomplete()
      SLASH_COMMANDS.get(parsed.command)(parsed.args)
      return
    } else if (parsed) {
      document.getElementById('agentPrompt').value = ''
      hideSlashAutocomplete()
      appendMsg('system', `⚠️ Unknown command: /${esc(parsed.command)}`)
      SLASH_COMMANDS.get('help')('')
      return
    }
  }

  if(!loadedModelId) { appendMsg('system','⚠️ Load a model first.'); return }

  // auto-create session if none
  if (!activeSessionId && activeProjectId) {
    newSession(activeSessionType || 'vibe').then(() => {
      sendAgentMode(prompt)
    })
    return
  }

  sendAgentMode(prompt)
}

// ── agent mode (Qwen Code SDK with tools) ─────────────────────────────────────
async function sendAgentMode(prompt, opts = {}) {
  if (!currentProject) {
    appendMsg('system', '📁 Agent mode needs a project folder. Opening picker...')
    const p = await window.app.openFolder()
    if (!p) { appendMsg('system', '⚠️ No folder selected. Agent cancelled.'); return }
    currentProject = p
    await renderFileTree(p, document.getElementById('fileTree'))
    startFileWatcher(p)
    showPanel('files', document.querySelector('[data-panel="files"]'))
    appendMsg('system', `📁 Working directory: ${p}`)
  }

  isGenerating = true
  const btn = document.getElementById('sendBtn')
  btn.disabled=false; btn.innerHTML='<span class="spinner"></span>Stop'; btn.className='btn-send btn-stop'
  btn.onclick = () => { window.app.qwenInterrupt(); finishGeneration() }

  const out = document.getElementById('agentOutput')
  if(out.querySelector('.agent-welcome') || out.querySelector('.build-picker')) out.innerHTML = ''

  if (!opts.skipUserMsg) {
    appendMsg('user', esc(prompt))
  }
  // Save a compact version to history for spec prompts (avoid storing massive task lists)
  const historyContent = (opts.historyLabel) ? opts.historyLabel : prompt
  saveToHistory('user', historyContent)
  document.getElementById('agentPrompt').value = ''

  // show attached images in the user message bubble
  if (attachedImgs.length > 0) {
    const lastUserMsg = document.querySelector('#agentOutput .msg-user:last-child')
    if (lastUserMsg) {
      const imgHtml = attachedImgs.map(img => `<img class="agent-img-in-chat" src="${img.b64}" style="max-width:200px;max-height:200px;border-radius:8px;margin-top:6px;margin-right:6px;">`).join('')
      lastUserMsg.insertAdjacentHTML('beforeend', `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">${imgHtml}</div>`)
    }
  }

  const respId = 'resp-'+Date.now()
  out.insertAdjacentHTML('beforeend', `<div class="msg-block" id="${respId}">
    <div class="msg-system" id="${respId}-status" style="display:none"></div>
    <div id="${respId}-fast"></div>
    <div id="${respId}-tools"></div>
    <details class="msg-thinking" id="${respId}-think" style="display:none">
      <summary>🧠 Thinking</summary>
      <div class="msg-thinking-body" id="${respId}-think-body"></div>
    </details>
    <div class="msg-text" id="${respId}-text"></div>
    <div class="msg-activity" id="${respId}-activity">🤖 Agent starting in ${esc(currentProject)}... <span class="activity-dot">●</span></div>
  </div>`)
  scrollOutput()

  // Fast model instant acknowledgement — fire immediately, don't await the agent
  // Shows a short reply from the 0.8B while the 35B loads context and starts its loop
  window.app.assistChatReply(prompt, agentRole || 'general').then(reply => {
    if (!reply) return
    const fastEl = document.getElementById(respId + '-fast')
    if (fastEl) {
      fastEl.insertAdjacentHTML('beforeend', `<div class="fast-reply-badge"><span class="fast-reply-icon">⚡</span><span class="fast-reply-model">Fast Assistant</span><span class="fast-reply-text">${esc(reply)}</span></div>`)
      scrollOutput()
    }
  }).catch(() => {})

  let lastText = '', lastThinking = '', tokenCount = 0, startTime = null
  let agentFinished = false
  let lastToolName = ''
  let inputTokens = 0, outputTokens = 0
  let serverTps = null // real tk/s from server, used when available
  let allTextSegments = [] // accumulates text across all turns (text→tool→text→...)
  _lastCompactionStats = null // reset so stale stats don't persist across runs
  window._rawCount = 0
  window._rawToolCalls = null
  window.app.offQwenEvents()
  updateStatusBar('initializing', { progress: -1, activity: 'Starting agent...' })
  updateAgentStatsBar({ state: 'initializing', progress: -1, activity: 'Starting agent...' })

  // ── Crash-safe session persistence ───────────────────────────────────────
  // Save the in-progress assistant response every 15s so a crash doesn't
  // lose the full generation. The final save on session-end overwrites this.
  let _autoSaveTimer = null
  function _startAutoSave() {
    if (_autoSaveTimer) return
    _autoSaveTimer = setInterval(() => {
      if (!activeProjectId || !activeSessionId) return
      const partial = allTextSegments.filter(Boolean).join('\n\n')
      if (partial && partial.length > 50) {
        // Save as a draft — prefixed so it's identifiable if the session ends abruptly
        window.app.appendSessionMsg(activeProjectId, activeSessionId, {
          role: 'assistant',
          content: partial,
          draft: true,
          ts: Date.now(),
        }).catch(() => {})
      }
    }, 15000)
  }
  function _stopAutoSave() {
    if (_autoSaveTimer) { clearInterval(_autoSaveTimer); _autoSaveTimer = null }
  }
  _startAutoSave()

  // Helper: update the bottom activity line in the chat (always visible)
  function setActivity(html) {
    const el = document.getElementById(respId + '-activity')
    if (el) { el.innerHTML = html; el.classList.remove('hidden') }
    scrollOutput()
  }
  function hideActivity() {
    const el = document.getElementById(respId + '-activity')
    if (el) el.classList.add('hidden')
  }

  let _agentToolCount = 0
  let _promptProgress = -1
  let _promptProgressTimer = null

  // Simulated prompt-eval progress: smoothly animates from 0→90% while waiting
  // for the first token, then jumps to 100% when generation starts.
  function startPromptProgress() {
    // Always stop any existing timer first to reset cleanly
    if (_promptProgressTimer) { clearInterval(_promptProgressTimer); _promptProgressTimer = null }
    _promptProgress = 0
    let elapsed = 0
    // Immediately show 0% so the UI resets visually
    updateStatusBar('prompt-eval')
    updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens: tokenCount, progress: 0, toolCount: _agentToolCount, activity: 'Evaluating prompt...' })
    _promptProgressTimer = setInterval(() => {
      elapsed += 200
      // Asymptotic curve: approaches 90% but never reaches it
      _promptProgress = 90 * (1 - Math.exp(-elapsed / 8000))
      updateStatusBar('prompt-eval')
      updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens: tokenCount, progress: _promptProgress, toolCount: _agentToolCount, activity: 'Evaluating prompt...' })
    }, 200)
  }
  function stopPromptProgress() {
    if (_promptProgressTimer) { clearInterval(_promptProgressTimer); _promptProgressTimer = null }
    _promptProgress = null
  }

  // Debounced markdown rendering — avoids O(n²) re-render on every delta
  // Debounced markdown rendering — avoids O(n²) re-render on every delta
  let _mdRenderTimer = null
  let _mdDirty = false
  function scheduleRender() {
    _mdDirty = true
    if (_mdRenderTimer) return // already scheduled
    _mdRenderTimer = requestAnimationFrame(() => {
      _mdRenderTimer = null
      if (_mdDirty) {
        _mdDirty = false
        document.getElementById(respId+'-text').innerHTML = renderMd(lastText, true) + '<span class="cursor">▌</span>'
        scrollOutput()
      }
    })
  }

  // Debounced scroll for tool preview — avoids excessive scrolling during fast streaming
  let _toolPreviewScrollTimer = null
  function _scheduleToolPreviewScroll() {
    if (_toolPreviewScrollTimer) return
    _toolPreviewScrollTimer = requestAnimationFrame(() => {
      _toolPreviewScrollTimer = null
      scrollOutput()
    })
  }

  window.app.onQwenEvent(ev => {
    if (agentFinished && ev.type !== 'session-end') return
    switch(ev.type) {
      case 'agent-type':
        if (ev.agentType && ev.agentType !== 'general') {
          _currentAgentType = ev.agentType
          const sel = document.getElementById('roleSelect')
          if (sel && sel.value === 'general') {
            sel.value = ev.agentType
            sel.style.outline = '1px solid var(--accent, #7c6af7)'
            setTimeout(() => { sel.style.outline = '' }, 2000)
          }
        }
        break
      case 'routing-decision':
        if (ev.source === 'small model' || ev.source === 'keyword' || ev.source === 'todo') {
          const roleIcons = { implementation: '🔨', explore: '🔍', 'context-gather': '📚', 'code-search': '🔎', general: '⚡', debug: '🐛', tester: '🧪', requirements: '📋', design: '📐' }
          const label = ev.source === 'keyword' ? '⚡ Fast routed'
            : ev.source === 'todo' ? '⚡ Todo routed'
            : '🤖 Fast model routed'
          const icon = roleIcons[ev.agentType] || '⚡'
          // Insert into the current response block's tools area so it's visible inline
          const toolsEl = document.getElementById(respId + '-tools')
          const html = `<div class="msg-system" style="color:var(--accent,#7c6af7);font-size:11px;padding:2px 8px">${label} → ${icon} ${ev.agentType}</div>`
          if (toolsEl) toolsEl.insertAdjacentHTML('afterbegin', html)
          else appendMsg('system', `<span style="color:var(--accent,#7c6af7);font-size:11px">${label} → ${icon} ${ev.agentType}</span>`)
        }
        break
      case 'fast-assist': {
        const fastEl = document.getElementById(respId + '-fast')
        if (fastEl) fastEl.insertAdjacentHTML('beforeend', renderFastAssistBlock(ev))
        else appendMsg('system', `<span style="color:var(--accent,#7c6af7);font-size:11px">${ev.label || '⚡ Fast Assistant'}</span>`)
        break
      }
      case 'session-start':
        setActivity('🤖 Agent running in ' + esc(ev.cwd||'.') + ' <span class="activity-dot">●</span>')
        startPromptProgress()
        break
      case 'text-delta':
        lastText = ev.text
        if (!startTime) startTime = Date.now()
        stopPromptProgress()
        tokenCount++ // each text-delta ≈ 1 token
        // Keep the latest segment in allTextSegments (last entry = current turn)
        if (allTextSegments.length === 0) allTextSegments.push(ev.text)
        else allTextSegments[allTextSegments.length - 1] = ev.text
        // Extract <think> content from text-delta and route to thinking box
        const thinkContent = extractThinking(lastText)
        if (thinkContent) {
          const thinkEl2 = document.getElementById(respId+'-think')
          thinkEl2.style.display = ''
          document.getElementById(respId+'-think-body').textContent = thinkContent + '▌'
        }
        scheduleRender()
        { const tks = serverTps || _calcTks(tokenCount, startTime)
          setActivity(`✍️ Generating — ${outputTokens || tokenCount} tokens${tks ? ' · ' + tks + ' tk/s' : ''} <span class="activity-dot">●</span>`)
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: outputTokens || tokenCount, tks, toolCount: _agentToolCount, activity: 'Writing response...' })
        }
        break
      case 'thinking-delta':
        lastThinking = ev.text
        stopPromptProgress()
        const thinkEl = document.getElementById(respId+'-think')
        thinkEl.style.display = ''
        document.getElementById(respId+'-think-body').textContent = lastThinking + '▌'
        setActivity('🧠 Reasoning <span class="activity-dot">●</span>')
        updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: tokenCount, activity: 'Reasoning...' })
        break
      case 'tool-delta': {
        // Live streaming preview of tool call arguments as they're generated
        stopPromptProgress()
        const toolName = ev.name || ''
        const args = ev.argumentsSoFar || ''

        // Show what the agent is generating in the status line and stats bar
        const WRITE_TOOLS = ['write_file', 'edit_file', 'create_file']
        const isWriteTool = WRITE_TOOLS.includes(toolName)

        // Extract file path from partial args for a more specific status
        let toolFile = ''
        const pathMatch = args.match(/"(?:path|file_path)"\s*:\s*"([^"]+)"/)
        if (pathMatch) toolFile = pathMatch[1].split('/').pop()

        const activityLabel = isWriteTool && toolFile
          ? `Writing ${toolFile}...`
          : isWriteTool ? `Writing code via ${toolName}...`
          : toolName === 'bash' ? 'Preparing command...'
          : `Preparing ${toolName}...`

        // Show live file name + size in the chat activity line
        { const sizeInfo = isWriteTool && args.length > 100 ? ` · ${(args.length / 1024).toFixed(1)}KB` : ''
          setActivity(`⚡ ${esc(activityLabel)}${sizeInfo} <span class="activity-dot">●</span>`)
        }
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: outputTokens || tokenCount, tks: serverTps || _calcTks(tokenCount, startTime), toolCount: _agentToolCount, activity: activityLabel })

        // Update or create the streaming tool preview block
        const previewId = respId + '-tool-preview'
        let previewEl = document.getElementById(previewId)
        if (!previewEl) {
          document.getElementById(respId+'-tools').insertAdjacentHTML('beforeend',
            `<div class="tool-block tool-preview running" id="${previewId}">
              <div class="tool-header">
                <span class="tool-icon">⚡</span>
                <div class="tool-header-info">
                  <span class="tool-name">${esc(_toolDisplayName(toolName))}</span>
                  <span class="tool-name-raw">${esc(toolName)}</span>
                </div>
                <span class="tool-status running"><span class="tool-spinner"></span> Generating…</span>
              </div>
              <div class="tool-preview-file"></div>
              <div class="tool-preview-body"></div>
            </div>`)
          previewEl = document.getElementById(previewId)
        }

        // Parse partial args to extract file path and content for write tools
        if (isWriteTool && args.length > 10) {
          const fileEl = previewEl.querySelector('.tool-preview-file')
          const bodyEl = previewEl.querySelector('.tool-preview-body')

          // Try to extract path from partial JSON: {"path":"some/file.js","content":"...
          const pathMatch = args.match(/"path"\s*:\s*"([^"]*)"/)
          if (pathMatch && fileEl) {
            fileEl.textContent = '📄 ' + pathMatch[1]
            fileEl.style.display = 'block'
          }

          // Extract content being written — show as live code preview
          const contentStart = args.indexOf('"content"')
          if (contentStart !== -1) {
            // Find the start of the content value (after "content":" )
            const valStart = args.indexOf(':"', contentStart + 9)
            if (valStart !== -1) {
              let raw = args.slice(valStart + 2)
              // Unescape basic JSON escapes for display
              raw = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
              // Trim trailing incomplete escape or quote
              if (raw.endsWith('\\')) raw = raw.slice(0, -1)
              // Strip trailing JSON closure: "} or just "
              if (raw.endsWith('"}')) raw = raw.slice(0, -2)
              else if (raw.endsWith('"')) raw = raw.slice(0, -1)

              if (bodyEl) {
                // Detect language from file extension for syntax hint
                const ext = (pathMatch?.[1] || '').split('.').pop() || ''
                const lineCount = raw.split('\n').length
                const lines = raw.split('\n').map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`).join('\n')
                bodyEl.innerHTML = `<div class="tool-preview-lang">${esc(ext)} · ${lineCount} lines</div><pre><code>${lines}</code></pre><span class="cursor">▌</span>`
                bodyEl.style.display = 'block'
              }
            }
          }
        } else if (toolName === 'bash' && args.length > 5) {
          const bodyEl = previewEl.querySelector('.tool-preview-body')
          const cmdMatch = args.match(/"command"\s*:\s*"([^"]*(?:\\.[^"]*)*)/)
          if (cmdMatch && bodyEl) {
            let cmd = cmdMatch[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
            bodyEl.innerHTML = `<pre><code>$ ${esc(cmd)}</code></pre><span class="cursor">▌</span>`
            bodyEl.style.display = 'block'
          }
        }

        _scheduleToolPreviewScroll()
        break
      }
      case 'tool-use':
        lastToolName = ev.name || ''
        _agentToolCount++
        stopPromptProgress()
        // Remove the streaming preview — the real tool block replaces it
        const previewToRemove = document.getElementById(respId + '-tool-preview')
        if (previewToRemove) previewToRemove.remove()
        // Start a new text segment for the next turn after this tool call
        allTextSegments.push('')

        // Route update_todos to the todo panel instead of showing a tool block
        if (ev.name === 'update_todos' && ev.input?.todos) {
          // Map status values to what updateTodoPanel expects
          const mapped = ev.input.todos.map(t => ({
            id: t.id,
            content: t.content || t.title || t.text || '',
            status: t.status === 'done' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
          }))
          updateTodoPanel(mapped, 'running')
          document.getElementById(respId+'-status').textContent = `📋 Updated todo list`
          updateStatusBar('tool', { toolName: ev.name, activity: 'Updating progress...' })
          updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: 'Updating progress...' })
          scrollOutput()
          break
        }

        document.getElementById(respId+'-tools').insertAdjacentHTML('beforeend', renderToolUse(ev.name, ev.input, 'running'))
        setActivity(`🔧 ${esc(activity)} <span class="activity-dot">●</span>`)
        // Show specific activity based on tool type
        const toolActivity = {
          'read_file': `Reading ${ev.input?.path?.split('/').pop() || 'file'}...`,
          'write_file': `Writing ${ev.input?.path?.split('/').pop() || 'file'}...`,
          'edit_file': `Editing ${ev.input?.path?.split('/').pop() || 'file'}...`,
          'bash': 'Running command...',
          'list_dir': 'Listing directory...',
          'search_files': `Searching for "${(ev.input?.pattern || '').slice(0, 30)}"...`,
          'browser_navigate': `Navigating to ${(ev.input?.url || '').slice(0, 40)}...`,
          'browser_screenshot': 'Taking screenshot...',
          'browser_click': 'Clicking element...',
          'web_search': `Searching: ${(ev.input?.query || '').slice(0, 30)}...`,
          'web_fetch': 'Fetching page...',
        }
        const activity = toolActivity[ev.name] || `Running ${ev.name}...`
        updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity })
        scrollOutput()
        break
      case 'tool-result': {
        // Skip rendering tool-result for update_todos — it's handled by the todo panel
        if (lastToolName === 'update_todos') {
          setActivity('📋 Updated progress <span class="activity-dot">●</span>')
          updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: 'Thinking about next step...' })
          break
        }
        const toolsDiv = document.getElementById(respId+'-tools')
        const lastTool = toolsDiv.querySelector('.tool-block:last-child')

        if (lastTool) {
          const newStatus = ev.is_error ? 'error' : 'done'
          lastTool.className = lastTool.className.replace(/\b(running|done|error)\b/g, '').trim() + ' ' + newStatus
          const statusEl = lastTool.querySelector('.tool-status')
          if (statusEl) {
            statusEl.className = 'tool-status ' + newStatus
            statusEl.innerHTML = (ev.is_error ? '✗ Error' : '✓ Done')
          }
          const todoStatus = lastTool.querySelector('.todo-status')
          if (todoStatus) {
            todoStatus.className = 'todo-status ' + (ev.is_error ? 'todo-status-error' : 'todo-status-done')
            todoStatus.textContent = ev.is_error ? '✗ Error' : '✓ Done'
          } else {
            lastTool.insertAdjacentHTML('beforeend', renderToolResult(ev.content, ev.is_error))
          }
        }
        const FILE_TOOLS = ['write_file', 'edit_file', 'create_file', 'bash', 'str_replace_editor']
        if (!ev.is_error && FILE_TOOLS.some(t => lastToolName.includes(t))) {
          if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
        }
        document.getElementById(respId+'-status').innerHTML = `🤖 ${lastToolName ? esc(lastToolName) + ' done — ' : ''}deciding next step <span class="activity-dot">●</span>`
        setActivity(`🤖 ${lastToolName ? esc(lastToolName) + ' done — ' : ''}deciding next step <span class="activity-dot">●</span>`)
        // Restart prompt progress — the server is now processing the tool
        // result and deciding what to do next. This is a real wait period.
        startPromptProgress()
        updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, progress: 0, activity: 'Processing tool result...' })
        scrollOutput()
        break
      }
      case 'assistant': {
        let html = ''
        for (const block of (ev.blocks || [])) {
          if (block.type === 'text') {
            html += renderMd(block.text)
            allTextSegments.push(block.text)
          }
          else if (block.type === 'thinking') { document.getElementById(respId+'-think').style.display = ''; document.getElementById(respId+'-think-body').textContent = block.text }
          else if (block.type === 'tool_use') document.getElementById(respId+'-tools').insertAdjacentHTML('beforeend', renderToolUse(block.name, block.input, 'done'))
          else if (block.type === 'tool_result') { const td = document.getElementById(respId+'-tools'); const lt = td.querySelector('.tool-block:last-child'); if (lt) lt.insertAdjacentHTML('beforeend', renderToolResult(block.content, block.is_error)) }
        }
        if (html) document.getElementById(respId+'-text').innerHTML = html
        if (ev.usage) {
          inputTokens = ev.usage.input_tokens || inputTokens
          outputTokens = ev.usage.output_tokens || outputTokens || tokenCount
        }
        updateStatusBar('processing', { activity: 'Processing response...' })
        updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens, toolCount: _agentToolCount, activity: 'Processing response...' })
        scrollOutput()
        break
      }
      case 'lsp-activity': {
        // Show LSP activity in the status line and flash the LSP chip
        const lspChip = document.getElementById('lspChip')
        const lspDot = document.getElementById('lspDot')
        const action = ev.action || ''
        const filePath = ev.path ? ev.path.split('/').pop() : ''

        // Flash the LSP dot to indicate activity
        if (lspDot) {
          lspDot.style.background = 'var(--accent2)'
          lspDot.style.boxShadow = '0 0 6px var(--accent2)'
          setTimeout(() => {
            // Restore to current status color
            const colors = { ready: 'var(--green)', starting: '#f5a623', degraded: '#f5a623', error: 'var(--red)', stopped: 'var(--muted)' }
            lspDot.style.background = colors[currentLspStatus] || 'var(--muted)'
            lspDot.style.boxShadow = ''
          }, 800)
        }

        if (action === 'speculative-check') {
          setActivity(`🔬 LSP: validating ${filePath} before write... <span class="activity-dot">●</span>`)
        } else if (action === 'speculative-ok') {
          const toolsEl = document.getElementById(respId+'-tools')
          if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--green)">✅ LSP validated ${filePath} — no new errors</div>`)
        } else if (action === 'speculative-warn') {
          const toolsEl = document.getElementById(respId+'-tools')
          if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--yellow)">⚠️ LSP found ${ev.count} issue${ev.count > 1 ? 's' : ''} in ${filePath}</div>`)
        } else if (action === 'diagnostics-check') {
          setActivity(`🔬 LSP: checking ${filePath} for errors... <span class="activity-dot">●</span>`)
        } else if (action === 'diagnostics-ok') {
          const toolsEl = document.getElementById(respId+'-tools')
          if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--green)">✅ LSP: ${filePath} — clean</div>`)
        } else if (action === 'diagnostics-errors') {
          const toolsEl = document.getElementById(respId+'-tools')
          if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--red)">⚠️ LSP: ${filePath} — ${ev.count} error${ev.count > 1 ? 's' : ''} found</div>`)
        } else if (action === 'session-diagnostics') {
          const toolsEl = document.getElementById(respId+'-tools')
          if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--accent2)">📋 LSP: ${ev.count} existing error${ev.count > 1 ? 's' : ''} in project — agent is aware</div>`)
        }
        break
      }
      case 'memory-extract': {
        // Show a subtle notification when the extraction model processes a turn
        const toolsEl = document.getElementById(respId+'-tools')
        if (toolsEl && ev.message) {
          toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--muted);font-size:10px;opacity:0.7">${esc(ev.message)}</div>`)
        }
        break
      }
      case 'system':
        if (ev.subtype === 'debug') {
          setActivity(`🔍 ${esc(ev.data)} <span class="activity-dot">●</span>`)
          // Show retries and important debug info inline in chat
          if (ev.data && (ev.data.includes('retrying') || ev.data.includes('Trimmed') || ev.data.includes('Repetition'))) {
            const toolsEl = document.getElementById(respId+'-tools')
            if (toolsEl) toolsEl.insertAdjacentHTML('beforeend', `<div class="msg-system" style="color:var(--muted)">🔍 ${esc(ev.data)}</div>`)
          }
        } else {
          setActivity(ev.subtype === 'init' ? '🤖 Agent initialized <span class="activity-dot">●</span>' : `⚙️ ${esc(ev.subtype)} <span class="activity-dot">●</span>`)
        }
        updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: ev.subtype === 'debug' ? ev.data : ev.subtype })
        scrollOutput()
        break
      case 'compaction-stats':
        // Only update the badge for conversation-level compaction, not per-tool-result compressions
        if (!ev.data.source || ev.data.source !== 'tool-result') {
          _lastCompactionStats = ev.data
        } else if (!_lastCompactionStats) {
          _lastCompactionStats = ev.data
        }
        updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: 'Compressed context' })
        break
      case 'usage':
        if (ev.usage) {
          inputTokens = ev.usage.input_tokens || ev.usage.prompt_tokens || inputTokens
          outputTokens = ev.usage.output_tokens || ev.usage.completion_tokens || outputTokens
        }
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens })
        break
      case 'result':
        hideActivity()
        document.getElementById(respId+'-status').textContent = ev.is_error ? `❌ ${ev.subtype}: ${ev.result||'error'}` : '✅ Done'
        document.getElementById(respId+'-status').style.display = ''
        if (!agentFinished && !window._pendingTasksExecute) {
          agentFinished = true
          stopPromptProgress()
          updateStatusBar('idle')
          updateAgentStatsBar({ state: 'done', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount })
          finishGeneration()
        }
        break
      case 'tasks-file-written':
        // The agent wrote a tasks.md / todo.md file — remember it for orchestrator
        if (ev.path && currentProject) {
          window._pendingTasksExecute = ev.path
        }
        break
      case 'session-end':
        document.getElementById(respId+'-status').textContent = '✅ Agent finished'
        _stopAutoSave()  // stop crash-safe auto-save — we're about to do the real save
        // Reset role dropdown back to general so next message starts fresh
        _currentAgentType = null
        { const sel = document.getElementById('roleSelect'); if (sel) sel.value = 'general' }
        // Combine all text segments from every turn (text→tool→text→...)
        const fullText = allTextSegments.filter(Boolean).join('\n\n')
        const textEl = document.getElementById(respId+'-text')
        if (textEl) textEl.innerHTML = renderMd(fullText)
        // Finalize thinking box with extracted content
        const finalThink = extractThinking(fullText)
        const tb = document.getElementById(respId+'-think-body')
        if (finalThink && tb) {
          document.getElementById(respId+'-think').style.display = ''
          tb.textContent = finalThink
        } else if (tb && tb.textContent.endsWith('▌')) {
          tb.textContent = tb.textContent.slice(0,-1)
        }
        if (fullText) saveToHistory('assistant', fullText)
        if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
        showPreviewButton(respId)
        saveChatSnapshot()

        // If the agent wrote a tasks file, parse it and trigger the orchestrator
        if (window._pendingTasksExecute) {
          const tasksPath = window._pendingTasksExecute
          window._pendingTasksExecute = null
          console.log('[orchestrator] Triggering execution for:', tasksPath)

          // Wrap in async IIFE — parse must complete before execute starts
          ;(async () => {
          // Parse FIRST, then execute — avoid race where status events fire before graph is loaded
          let parsed = null
          try {
            parsed = await window.app.taskGraphParse(tasksPath)
          } catch (_) { /* best-effort */ }

          if (parsed && parsed.nodes) {
            currentTaskGraph = parsed
            currentTasksPath = tasksPath
            renderTaskGraph(parsed)
            saveWorkflowState() // persist task graph path for session restore

            const todos = Object.values(parsed.nodes).map(n => ({
              id: n.id,
              content: n.title,
              status: n.status === 'not_started' ? 'pending' : n.status,
            }))
            if (todos.length > 0) updateTodoPanel(todos, 'done')
          }

          agentFinished = false
          isGenerating = true
          const btn = document.getElementById('sendBtn')
          btn.disabled = false; btn.innerHTML = '<span class="spinner"></span>Stop'; btn.className = 'btn-send btn-stop'
          btn.onclick = () => { window.app.qwenInterrupt(); finishGeneration() }

          // Sync task graph sidebar buttons to show running state
          document.getElementById('tgRunBtn').style.display = 'none'
          document.getElementById('tgPauseBtn').style.display = 'inline-block'
          document.getElementById('tgAbortBtn').style.display = 'inline-block'

          // Switch to tasks panel in sidebar so user can see progress
          showPanel('tasks', document.querySelector('[data-panel="tasks"]'))

          const orchId = 'resp-orch-' + Date.now()
          const out = document.getElementById('agentOutput')
          out.insertAdjacentHTML('beforeend', `<div class="msg-block" id="${orchId}">
            <div class="msg-system" id="${orchId}-status">🚀 Orchestrator: executing tasks...</div>
            <div id="${orchId}-tasks"></div>
          </div>`)
          scrollOutput()

          window.app.offQwenEvents()
          let orchToolName = ''
          let orchTaskBlockId = null
          let orchTaskText = ''
          let orchTaskCount = 0

          function newOrchTaskBlock(label) {
            orchTaskCount++
            orchTaskText = ''
            orchTaskBlockId = orchId + '-task-' + orchTaskCount
            const tasksDiv = document.getElementById(orchId + '-tasks')
            tasksDiv.insertAdjacentHTML('beforeend', `<div class="msg-block" id="${orchTaskBlockId}" style="margin:6px 0;padding:8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg3)">
              <div class="msg-system" id="${orchTaskBlockId}-status" style="font-weight:600">${label}</div>
              <div id="${orchTaskBlockId}-fast"></div>
              <div id="${orchTaskBlockId}-tools"></div>
              <details class="msg-thinking" id="${orchTaskBlockId}-think" style="display:none">
                <summary>🧠 Thinking</summary>
                <div class="msg-thinking-body" id="${orchTaskBlockId}-think-body"></div>
              </details>
              <div class="msg-text" id="${orchTaskBlockId}-text"></div>
            </div>`)
            scrollOutput()
          }

          window.app.onQwenEvent(ev => {
            switch (ev.type) {
              case 'agent-type':
                if (ev.agentType && ev.agentType !== 'general') {
                  _currentAgentType = ev.agentType
                  const sel = document.getElementById('roleSelect')
                  if (sel && sel.value === 'general') {
                    sel.value = ev.agentType
                    sel.style.outline = '1px solid var(--accent, #7c6af7)'
                    setTimeout(() => { sel.style.outline = '' }, 2000)
                  }
                }
                break
              case 'routing-decision':
                if (ev.source === 'small model' || ev.source === 'keyword' || ev.source === 'todo') {
                  const roleIcons = { implementation: '🔨', explore: '🔍', 'context-gather': '📚', 'code-search': '🔎', general: '⚡', debug: '🐛', tester: '🧪', requirements: '📋', design: '📐' }
                  const label = ev.source === 'keyword' ? '⚡ Fast routed'
                    : ev.source === 'todo' ? '⚡ Todo routed'
                    : '🤖 Fast model routed'
                  const icon = roleIcons[ev.agentType] || '⚡'
                  const toolsEl = document.getElementById(respId + '-tools')
                  const html = `<div class="msg-system" style="color:var(--accent,#7c6af7);font-size:11px;padding:2px 8px">${label} → ${icon} ${ev.agentType}</div>`
                  if (toolsEl) toolsEl.insertAdjacentHTML('afterbegin', html)
                  else appendMsg('system', `<span style="color:var(--accent,#7c6af7);font-size:11px">${label} → ${icon} ${ev.agentType}</span>`)
                }
                break
              case 'fast-assist': {
                const fastEl2 = orchTaskBlockId ? document.getElementById(orchTaskBlockId + '-fast') : null
                if (fastEl2) fastEl2.insertAdjacentHTML('beforeend', renderFastAssistBlock(ev))
                else appendMsg('system', `<span style="color:var(--accent,#7c6af7);font-size:11px">${ev.label || '⚡ Fast Assistant'}</span>`)
                break
              }
              case 'session-start': {
                // Find the current in-progress task from the todo panel or task graph
                const activeTask = currentTodos.find(t => t.status === 'in_progress')
                // Use _currentAgentType which is set by onTaskStatusEvent (fires before session-start)
                const agentType = _currentAgentType
                const agentBadge = agentType && agentType !== 'general' ? ` <span class="orch-agent-badge">${agentType}</span>` : ''
                const taskLabel = activeTask ? `🔧 Task ${activeTask.id}: ${activeTask.content}${agentBadge}` : '🔧 Working on task...'
                newOrchTaskBlock(taskLabel)
                document.getElementById(orchId + '-status').textContent = `🚀 Orchestrator: task ${orchTaskCount}...`
                // Start prompt progress for this task
                startPromptProgress()
                updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens: tokenCount, progress: 0, toolCount: _agentToolCount, agentType, activity: activeTask ? `Task ${activeTask.id}: Evaluating prompt...` : 'Evaluating prompt...' })
                break
              }
              case 'text-delta': {
                if (!orchTaskBlockId) newOrchTaskBlock('🔧 Working...')
                stopPromptProgress()
                orchTaskText = ev.text
                // Strip thinking tags from display
                let displayText = orchTaskText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
                // If still inside an unclosed <think> tag, don't show the thinking content
                const openThink = orchTaskText.lastIndexOf('<think>')
                const closeThink = orchTaskText.lastIndexOf('</think>')
                if (openThink > closeThink) {
                  displayText = orchTaskText.slice(0, openThink).trim()
                  // Show thinking in the thinking box
                  const thinkContent = orchTaskText.slice(openThink + 7)
                  const thinkEl = document.getElementById(orchTaskBlockId + '-think')
                  if (thinkEl) { thinkEl.style.display = ''; document.getElementById(orchTaskBlockId + '-think-body').textContent = thinkContent + '▌' }
                }
                const textEl = document.getElementById(orchTaskBlockId + '-text')
                if (textEl && displayText) textEl.innerHTML = renderMd(displayText, true) + '<span class="cursor">▌</span>'
                tokenCount++
                updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: 'Writing response...' })
                scrollOutput()
                break
              }
              case 'tool-use':
                if (!orchTaskBlockId) newOrchTaskBlock('🔧 Working...')
                stopPromptProgress()
                orchToolName = ev.name || ''
                _agentToolCount++
                document.getElementById(orchTaskBlockId + '-tools').insertAdjacentHTML('beforeend', renderToolUse(ev.name, ev.input, 'running'))
                document.getElementById(orchTaskBlockId + '-status').textContent = `🔧 Using tool: ${ev.name}`
                updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: `Running ${ev.name}...` })
                scrollOutput()
                break
              case 'tool-result': {
                if (!orchTaskBlockId) break
                const toolsDiv = document.getElementById(orchTaskBlockId + '-tools')
                const lastTool = toolsDiv?.querySelector('.tool-block:last-child')
                if (lastTool) {
                  const newStatus = ev.is_error ? 'error' : 'done'
                  lastTool.className = lastTool.className.replace(/\b(running|done|error)\b/g, '').trim() + ' ' + newStatus
                  const statusEl = lastTool.querySelector('.tool-status')
                  if (statusEl) { statusEl.className = 'tool-status ' + newStatus; statusEl.innerHTML = ev.is_error ? '✗ Error' : '✓ Done' }
                  lastTool.insertAdjacentHTML('beforeend', renderToolResult(ev.content, ev.is_error))
                }
                const FILE_TOOLS = ['write_file', 'edit_file', 'create_file', 'bash']
                if (!ev.is_error && FILE_TOOLS.some(t => orchToolName.includes(t))) {
                  if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
                }
                updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: 'Thinking about next step...' })
                scrollOutput()
                break
              }
              case 'result':
                if (orchTaskBlockId && ev.result && !ev.is_error) {
                  const textEl = document.getElementById(orchTaskBlockId + '-text')
                  if (textEl) {
                    let cleanResult = ev.result.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
                    textEl.innerHTML = renderMd(cleanResult)
                  }
                }
                break
              case 'raw-stream': {
                const sev = ev.event; if (!sev) break
                if (sev.usage) {
                  inputTokens = sev.usage.prompt_tokens || inputTokens
                  outputTokens = sev.usage.completion_tokens || outputTokens
                  const genTps = sev.x_stats?.generation_tps
                  const promptTps = sev.x_stats?.prompt_tps
                  if (genTps) serverTps = genTps
                  updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks: genTps, promptTps, peakMemory: sev.x_stats?.peak_memory_gb, toolCount: _agentToolCount, agentType: _currentAgentType })
                }
                break
              }
              case 'session-end':
                // Finalize current task block and prepare for next
                if (orchTaskBlockId) {
                  const statusEl = document.getElementById(orchTaskBlockId + '-status')
                  if (statusEl) statusEl.textContent = '✅ Task completed'
                  // Finalize thinking box
                  const tb = document.getElementById(orchTaskBlockId + '-think-body')
                  if (tb && tb.textContent.endsWith('▌')) tb.textContent = tb.textContent.slice(0, -1)
                }
                orchTaskBlockId = null
                orchTaskText = ''
                document.getElementById(orchId + '-status').textContent = '🚀 Orchestrator: moving to next task...'
                scrollOutput()
                break
              case 'error':
                appendMsg('system', '❌ Task error: ' + ev.error)
                break
            }
          })

          window.app.onOrchestratorCompleted(() => {
            window.app.offOrchestratorCompleted()
            window.app.offQwenEvents()
            const allDone = currentTodos.every(t => t.status === 'completed' || t.status === 'done')
            document.getElementById(orchId + '-status').textContent = allDone ? '✅ All tasks completed' : '⚠️ Orchestrator stopped'
            if (allDone) appendMsg('system', '🎉 All tasks completed!')
            if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
            saveChatSnapshot()
            agentFinished = true
            isGenerating = false
            updateStatusBar('idle')
            updateAgentStatsBar({ state: 'done', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount })
            finishGeneration()

            // Reset task graph sidebar buttons
            document.getElementById('tgRunBtn').style.display = 'inline-block'
            document.getElementById('tgPauseBtn').style.display = 'none'
            document.getElementById('tgResumeBtn').style.display = 'none'
            document.getElementById('tgAbortBtn').style.display = 'none'

            // Refresh task graph to show final statuses
            if (currentTasksPath) loadTaskGraph(currentTasksPath).catch(() => {})
          })

          window.app.taskGraphExecute(tasksPath).then(r => {
            console.log('[orchestrator] Result:', r)
            if (r.error) appendMsg('system', `⚠️ Orchestrator error: ${r.error}`)
          }).catch(err => {
            console.error('[orchestrator] Error:', err)
            appendMsg('system', `⚠️ Orchestrator failed: ${err.message}`)
          })
          })() // end async IIFE
        }

        if (!agentFinished) {
          agentFinished = true
          updateStatusBar('idle')
          updateAgentStatsBar({ state: 'done', inputTokens, outputTokens: outputTokens || tokenCount })
          finishGeneration()
        }
        break
      case 'error':
        appendMsg('system', '❌ ' + ev.error)
        if (!agentFinished) {
          agentFinished = true
          updateStatusBar('idle')
          updateAgentStatsBar({ state: 'done', inputTokens, outputTokens: tokenCount })
          finishGeneration()
        }
        break
      case 'raw-stream': {
        const sev = ev.event; if (!sev) break
        if (!startTime) startTime = Date.now()
        // Handle prompt processing progress
        if (sev.x_progress) {
          if (sev.x_progress.stage === 'processing') {
            // Server confirmed prompt processing — simulated progress handles the animation
            if (!_promptProgressTimer) startPromptProgress()
          } else if (sev.x_progress.stage === 'done') {
            stopPromptProgress()
          }
          break
        }
        if (sev.choices?.[0]?.delta?.content) {
          stopPromptProgress()
          if (!startTime) startTime = Date.now()
          const content = sev.choices[0].delta.content
          lastText += content
          // Keep allTextSegments in sync for raw-stream path
          if (allTextSegments.length === 0) allTextSegments.push(content)
          else allTextSegments[allTextSegments.length - 1] = lastText
          // Check for <think> tags in accumulated text
          const thinkInText = extractThinking(lastText)
          if (thinkInText) {
            document.getElementById(respId+'-think').style.display = ''
            document.getElementById(respId+'-think-body').textContent = thinkInText + '▌'
          }
          scheduleRender()
          tokenCount++ // each SSE chunk ≈ 1 token
          const tks = serverTps || _calcTks(tokenCount, startTime)
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: outputTokens || tokenCount, tks, toolCount: _agentToolCount, activity: 'Writing response...' })
        }
        // Handle OpenAI-compatible tool_calls streaming deltas
        if (sev.choices?.[0]?.delta?.tool_calls) {
          stopPromptProgress()
          for (const tc of sev.choices[0].delta.tool_calls) {
            const idx = tc.index ?? 0
            // Initialize accumulator for this tool call index
            if (!window._rawToolCalls) window._rawToolCalls = {}
            if (!window._rawToolCalls[idx]) {
              window._rawToolCalls[idx] = { id: '', name: '', arguments: '' }
            }
            const acc = window._rawToolCalls[idx]
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            if (tc.function?.arguments) acc.arguments += tc.function.arguments
            // When we have a name and this is the first chunk, show the tool block
            if (acc.name && !acc._shown) {
              acc._shown = true
              _agentToolCount++
              lastToolName = acc.name
              allTextSegments.push('')
              document.getElementById(respId+'-tools').insertAdjacentHTML('beforeend', renderToolUse(acc.name, acc.arguments || '{}', 'running'))
              document.getElementById(respId+'-status').textContent = `🔧 Using tool: ${acc.name}`
              updateAgentStatsBar({ state: 'tool', toolName: acc.name, inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, activity: `Running ${acc.name}...` })
              scrollOutput()
            }
          }
        }
        // Handle OpenAI-compatible finish_reason for tool_calls
        if (sev.choices?.[0]?.finish_reason === 'tool_calls' || sev.choices?.[0]?.finish_reason === 'stop') {
          if (window._rawToolCalls) {
            // Update tool blocks with final parsed arguments
            for (const idx of Object.keys(window._rawToolCalls)) {
              const acc = window._rawToolCalls[idx]
              if (acc.name && acc._shown) {
                let parsedInput = acc.arguments
                try { parsedInput = JSON.parse(acc.arguments) } catch {}
                // Update the last tool block with final input
                const toolsDiv = document.getElementById(respId+'-tools')
                const lastTool = toolsDiv.querySelector('.tool-block:last-child')
                if (lastTool) {
                  const bodyRaw = lastTool.querySelector('.tool-body-raw')
                  if (bodyRaw) bodyRaw.textContent = typeof parsedInput === 'string' ? parsedInput : JSON.stringify(parsedInput, null, 2)
                }
              }
            }
            window._rawToolCalls = null
          }
        }
        if (sev.type === 'content_block_delta' && sev.delta?.text) {
          stopPromptProgress()
          if (!startTime) startTime = Date.now()
          const deltaText = sev.delta.text
          lastText += deltaText
          // Keep allTextSegments in sync for content_block_delta path
          if (allTextSegments.length === 0) allTextSegments.push(deltaText)
          else allTextSegments[allTextSegments.length - 1] = lastText
          const thinkInText2 = extractThinking(lastText)
          if (thinkInText2) {
            document.getElementById(respId+'-think').style.display = ''
            document.getElementById(respId+'-think-body').textContent = thinkInText2 + '▌'
          }
          scheduleRender()
          tokenCount++ // each content_block_delta ≈ 1 token
          const tks2 = serverTps || _calcTks(tokenCount, startTime)
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: outputTokens || tokenCount, tks: tks2, toolCount: _agentToolCount, activity: 'Writing response...' })
        } else if (sev.type === 'content_block_delta' && sev.delta?.thinking) {
          stopPromptProgress()
          lastThinking += sev.delta.thinking
          document.getElementById(respId+'-think').style.display = ''
          document.getElementById(respId+'-think-body').textContent = lastThinking + '▌'
          updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: 'Reasoning...' })
        } else if (sev.usage) {
          inputTokens = sev.usage.prompt_tokens || inputTokens
          outputTokens = sev.usage.completion_tokens || outputTokens || tokenCount
          const genTps = sev.x_stats?.generation_tps
          const promptTps = sev.x_stats?.prompt_tps
          if (genTps) serverTps = genTps // lock in the server's real tps
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks: genTps, promptTps, peakMemory: sev.x_stats?.peak_memory_gb, toolCount: _agentToolCount })
        }
        break
      }
    }
  })

  // include attached images if any
  const sentImages = [...attachedImgs]
  if (sentImages.length > 0) {
    attachedImgs = []
    renderAttachedImages()
  }

  // Send conversation history so the agent has multi-turn context
  const maxHist = (projectSettings?.maxHistoryMessages || 40)
  const historyForAgent = conversationHistory.slice(-maxHist).map(m => ({ role: m.role, content: m.content }))

  window.app.qwenRun({
    prompt,
    cwd: currentProject || undefined,
    permissionMode: permMode,
    agentRole: agentRole,
    model: loadedModelId,
    images: sentImages.length > 0 ? sentImages : undefined,
    conversationHistory: historyForAgent.length > 0 ? historyForAgent : undefined,
    samplingParams: getSamplingParams(),
    taskGraphPath: currentTasksPath || undefined,
  })
}

function finishGeneration() {
  isGenerating = false
  const btn = document.getElementById('sendBtn')
  btn.disabled=false; btn.textContent='Send ↵'; btn.className='btn-send'; btn.onclick=sendAgent
  updateStatusBar('idle')
  // Reset the agent stats bar so it doesn't linger into the next session
  updateAgentStatsBar({ state: 'idle' })
}

function appendMsg(role, text) {
  const out = document.getElementById('agentOutput')
  if(role==='user') out.insertAdjacentHTML('beforeend', `<div class="msg-user"><div class="msg-user-label">You</div>${text}</div>`)
  else if(role==='system') out.insertAdjacentHTML('beforeend', `<div class="msg-system">${text}</div>`)
  scrollOutput()
}

function scrollOutput() {
  const o = document.getElementById('agentOutput')
  // Only auto-scroll if the user is near the bottom (within 150px).
  // If they've scrolled up to read earlier messages, don't yank them down.
  const distanceFromBottom = o.scrollHeight - o.scrollTop - o.clientHeight
  if (distanceFromBottom < 150) {
    o.scrollTop = o.scrollHeight
  }
}

// ── vision ────────────────────────────────────────────────────────────────────
function loadImage(e){const f=e.target.files[0];if(f)readImageFile(f)}
function readImageFile(file){const r=new FileReader();r.onload=ev=>{imageB64=ev.target.result;const i=document.getElementById('imgPreview');i.src=imageB64;i.style.display='block';document.getElementById('dropHint').style.display='none';document.getElementById('dropZone').classList.add('has-image')};r.readAsDataURL(file)}
async function sendVision(){
  if(isGenerating)return;const p=document.getElementById('visionPrompt').value.trim();if(!p)return
  if(!loadedModelId){document.getElementById('visionOutput').innerHTML='<span style="color:var(--red)">⚠️ Load a model first.</span>';return}
  const btn=document.getElementById('sendVisionBtn');btn.disabled=true;btn.innerHTML='<span class="spinner"></span>Asking...';isGenerating=true
  document.getElementById('visionOutput').innerHTML='<div class="output-placeholder">Generating...</div>'
  const content=imageB64?[{type:'text',text:p},{type:'image_url',image_url:{url:imageB64}}]:p
  try{const r=await window.app.chat({messages:[{role:'user',content}],max_tokens:512})
    if(r.error) { document.getElementById('visionOutput').innerHTML=`<span style="color:var(--red)">⚠️ ${r.error}</span>` }
    else {
      const t=r.choices?.[0]?.message?.content||JSON.stringify(r)
      let html=renderMd(t)
      if(r.usage) html+=`<div class="vision-stats">${r.usage.prompt_tokens} prompt · ${r.usage.completion_tokens||r.usage.generation_tokens||0} gen · ${r.usage.generation_tps||'—'} tk/s · ${r.usage.peak_memory_gb||'—'} GB</div>`
      document.getElementById('visionOutput').innerHTML=html
    }
  }catch(e){document.getElementById('visionOutput').innerHTML=`<span style="color:var(--red)">❌ ${e.message}</span>`}
  btn.disabled=false;btn.textContent='Ask ↵';isGenerating=false
}

// ── markdown (loaded from lib/markdown.js) ─────────────────────────────────────

function copyCodeBlock(id, btn) {
  const el = document.getElementById(id)
  if (!el) return
  const text = el.textContent.replace(/^\d+/gm, '').trim()
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!'; btn.classList.add('copied')
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied') }, 1500)
  })
}

async function saveCodeToFile(id, lang, btn) {
  const el = document.getElementById(id)
  if (!el) return
  if (!currentProject) { const p = await window.app.openFolder(); if(p) currentProject=p; else return }
  const text = el.textContent.replace(/^\d+/gm, '').trim()
  const ext = {html:'html',css:'css',js:'js',ts:'ts',py:'py',json:'json',sh:'sh',swift:'swift',go:'go',rs:'rs'}[lang] || 'txt'
  const filepath = currentProject + '/generated.' + ext
  const r = await window.app.writeFile(filepath, text)
  if (r.ok) {
    btn.textContent = '✓ Saved!'; btn.classList.add('copied')
    setTimeout(() => { btn.textContent = '💾 Save'; btn.classList.remove('copied') }, 2000)
    if (document.getElementById('fileTree')) await renderFileTree(currentProject, document.getElementById('fileTree'))
  }
}

// ── context settings ──────────────────────────────────────────────────────────
async function loadContextSettings() {
  if (!activeProjectId) {
    projectSettings = await window.app.getDefaultSettings()
  } else {
    projectSettings = await window.app.getSettings(activeProjectId)
  }
  const el = (id) => document.getElementById(id)
  if (el('cs-maxTokens')) el('cs-maxTokens').value = projectSettings.maxContextTokens
  if (el('cs-maxFileTokens')) el('cs-maxFileTokens').value = projectSettings.maxFileTokens
  if (el('cs-maxHistory')) el('cs-maxHistory').value = projectSettings.maxHistoryMessages
  if (el('cs-ignore')) el('cs-ignore').value = (projectSettings.ignorePatterns || []).join(',')
  if (el('cs-autoCompact')) el('cs-autoCompact').checked = projectSettings.autoCompact !== false
  if (el('cs-compactThreshold')) el('cs-compactThreshold').value = projectSettings.compactThreshold || 30
  if (el('cs-keepRecent')) el('cs-keepRecent').value = projectSettings.compactKeepRecent || 10
  loadSamplingSettings()
}

async function saveContextSettings() {
  if (!activeProjectId) return
  const settings = {
    ...projectSettings,
    maxContextTokens: parseInt(document.getElementById('cs-maxTokens')?.value) || 8000,
    maxFileTokens: parseInt(document.getElementById('cs-maxFileTokens')?.value) || 2000,
    maxHistoryMessages: parseInt(document.getElementById('cs-maxHistory')?.value) || 40,
    ignorePatterns: (document.getElementById('cs-ignore')?.value || '').split(',').map(s => s.trim()).filter(Boolean),
    autoCompact: document.getElementById('cs-autoCompact')?.checked !== false,
    compactThreshold: parseInt(document.getElementById('cs-compactThreshold')?.value) || 30,
    compactKeepRecent: parseInt(document.getElementById('cs-keepRecent')?.value) || 10,
  }
  projectSettings = await window.app.saveSettings(activeProjectId, settings)
}

// ── sampling settings ─────────────────────────────────────────────────────────
const SAMPLING_PRESETS = {
  recommended: { label: '⚡ Recommended (Coding)', temperature: 0.6, top_p: 0.9, repetition_penalty: 1.05 },
  qwen_official: { label: '🤖 Qwen Official (Thinking)', temperature: 0.6, top_p: 0.95, repetition_penalty: 1.0 },
  creative: { label: '🎨 Creative', temperature: 0.9, top_p: 0.95, repetition_penalty: 1.0 },
  precise: { label: '🎯 Precise / Deterministic', temperature: 0.2, top_p: 0.8, repetition_penalty: 1.1 },
  custom: { label: '✏️ Custom', temperature: null, top_p: null, repetition_penalty: null },
}

function getSamplingParams() {
  return {
    temperature: parseFloat(document.getElementById('sp-temperature')?.value) || 0.6,
    top_p: parseFloat(document.getElementById('sp-top-p')?.value) || 0.95,
    repetition_penalty: parseFloat(document.getElementById('sp-rep-penalty')?.value) || 1.0,
  }
}

function applySamplingPreset(presetKey) {
  const preset = SAMPLING_PRESETS[presetKey]
  if (!preset || presetKey === 'custom') return
  const tEl = document.getElementById('sp-temperature')
  const pEl = document.getElementById('sp-top-p')
  const rEl = document.getElementById('sp-rep-penalty')
  if (tEl) tEl.value = preset.temperature
  if (pEl) pEl.value = preset.top_p
  if (rEl) rEl.value = preset.repetition_penalty
  saveSamplingSettings()
}

function loadSamplingSettings() {
  const saved = projectSettings || {}
  const t = saved.samplingTemperature ?? 0.6
  const p = saved.samplingTopP ?? 0.95
  const r = saved.samplingRepPenalty ?? 1.05
  const preset = saved.samplingPreset || 'recommended'
  const tEl = document.getElementById('sp-temperature')
  const pEl = document.getElementById('sp-top-p')
  const rEl = document.getElementById('sp-rep-penalty')
  const selEl = document.getElementById('sp-preset')
  if (tEl) tEl.value = t
  if (pEl) pEl.value = p
  if (rEl) rEl.value = r
  if (selEl) selEl.value = preset
}

async function saveSamplingSettings() {
  if (!activeProjectId) return
  const presetEl = document.getElementById('sp-preset')
  const settings = {
    ...projectSettings,
    samplingTemperature: parseFloat(document.getElementById('sp-temperature')?.value) || 0.6,
    samplingTopP: parseFloat(document.getElementById('sp-top-p')?.value) || 0.95,
    samplingRepPenalty: parseFloat(document.getElementById('sp-rep-penalty')?.value) || 1.0,
    samplingPreset: presetEl?.value || 'recommended',
  }
  projectSettings = await window.app.saveSettings(activeProjectId, settings)
}

// ── API keys ──────────────────────────────────────────────────────────────────
async function loadApiKeys() {
  const keys = await window.app.getApiKeys()
  const el = document.getElementById('ak-brave')
  if (el && keys.brave) el.value = keys.brave
}

async function saveApiKeys() {
  const keys = {
    brave: document.getElementById('ak-brave')?.value?.trim() || '',
  }
  await window.app.saveApiKeys(keys)
}

// ── telegram bot ──────────────────────────────────────────────────────────────
async function telegramConnect() {
  const token = document.getElementById('tg-token').value.trim()
  if (!token) { alert('Enter a bot token first'); return }
  const btn = document.getElementById('tgConnectBtn')
  btn.textContent = '⏳ Connecting...'
  btn.disabled = true
  try {
    const res = await window.app.telegramStart(token)
    if (res.error) { alert('Failed: ' + res.error); return }
    await refreshTelegramStatus()
  } catch (e) { alert('Error: ' + e.message) }
  finally { btn.textContent = '⚡ Connect Bot'; btn.disabled = false }
}

async function telegramDisconnect() {
  await window.app.telegramStop()
  await refreshTelegramStatus()
  // Keep the token in the input so user can reconnect easily
}

async function telegramPair() {
  const res = await window.app.telegramPair()
  if (res.error) { alert(res.error); return }
  const link = document.getElementById('tgPairLink')
  link.textContent = res.qrDataUrl
  link.href = '#'
}

async function refreshTelegramStatus() {
  const status = await window.app.telegramStatus()
  const el = document.getElementById('tgStatus')
  const connectBtn = document.getElementById('tgConnectBtn')
  const disconnectBtn = document.getElementById('tgDisconnectBtn')
  const pairSection = document.getElementById('tgPairSection')
  const miniAppSection = document.getElementById('tgMiniAppSection')
  const tokenInput = document.getElementById('tg-token')

  // Pre-fill the token input if we have a saved token
  if (!tokenInput.value) {
    const saved = await window.app.telegramGetToken()
    if (saved.token) tokenInput.value = saved.token
  }

  if (status.connected) {
    el.innerHTML = `<span style="color:var(--green)">● Connected</span> @${status.bot_username}`
    connectBtn.style.display = 'none'
    disconnectBtn.style.display = 'inline-block'
    pairSection.style.display = 'block'
    miniAppSection.style.display = 'block'
    refreshMiniappStatus()
  } else {
    el.innerHTML = status.last_error
      ? `<span style="color:var(--red)">● Error:</span> ${status.last_error}`
      : '<span style="color:var(--muted)">● Disconnected</span>'
    connectBtn.style.display = 'inline-block'
    disconnectBtn.style.display = 'none'
    pairSection.style.display = 'none'
    miniAppSection.style.display = 'none'
  }
}

// ── mini app ──────────────────────────────────────────────────────────────────
async function miniappStart() {
  const btn = document.getElementById('miniappStartBtn')
  btn.textContent = '⏳ Starting...'
  btn.disabled = true
  try {
    const res = await window.app.miniappStart()
    if (res.error) { alert('Failed: ' + res.error); return }
    refreshMiniappStatus()
  } catch (e) { alert('Error: ' + e.message) }
  finally { btn.textContent = '🚀 Start Mini App'; btn.disabled = false }
}

async function miniappStop() {
  await window.app.miniappStop()
  refreshMiniappStatus()
}

async function refreshMiniappStatus() {
  const status = await window.app.miniappStatus()
  const statusEl = document.getElementById('miniappStatus')
  const startBtn = document.getElementById('miniappStartBtn')
  const stopBtn = document.getElementById('miniappStopBtn')
  const urlSection = document.getElementById('miniappUrlSection')
  const urlEl = document.getElementById('miniappUrl')

  if (status.running) {
    statusEl.innerHTML = '<span style="color:var(--green)">● Running</span>'
    startBtn.style.display = 'none'
    stopBtn.style.display = 'inline-block'
    if (status.publicUrl) {
      urlSection.style.display = 'block'
      urlEl.textContent = status.publicUrl
    } else {
      urlSection.style.display = 'block'
      urlEl.textContent = status.localUrl || 'http://localhost:3847'
    }
  } else {
    statusEl.innerHTML = '<span style="color:var(--muted)">● Not running</span>'
    startBtn.style.display = 'inline-block'
    stopBtn.style.display = 'none'
    urlSection.style.display = 'none'
  }
}

// ── compactor ─────────────────────────────────────────────────────────────────
async function checkCompactor() {
  const status = await window.app.compactorStatus()
  compactorInstalled = status.installed
  const btn = document.getElementById('compactBtn')
  const installBtn = document.getElementById('installCompactorBtn')
  if (status.installed) {
    if (btn) { btn.className = 'compact-btn'; btn.innerHTML = '🦞 Compact' }
    if (installBtn) installBtn.style.display = 'none'
    const statusEl = document.getElementById('compactorStatus')
    if (statusEl) statusEl.innerHTML = `<span class="compact-badge ok">🦞 v${status.version || '7+'}</span>`
  } else {
    if (btn) { btn.className = 'compact-btn missing'; btn.innerHTML = '🦞 Not installed' }
    if (installBtn) installBtn.style.display = 'inline-block'
    const statusEl = document.getElementById('compactorStatus')
    if (statusEl) statusEl.innerHTML = `<span class="compact-badge missing">Not installed</span>`
  }
  updateSessionInfo()
}

async function installCompactor() {
  const btn = document.getElementById('installCompactorBtn')
  btn.disabled = true; btn.textContent = '⏳ Installing...'
  appendMsg('system', '📦 Run in your terminal: pip install claw-compactor')
  btn.disabled = false; btn.textContent = '📦 Install claw-compactor'
}

function showCompactNotice(text) {
  const el = document.getElementById('compactNotice')
  const txt = document.getElementById('compactNoticeText')
  if (el && txt) { txt.textContent = text; el.style.display = 'flex' }
}

async function runCompactNow() {
  if (!activeProjectId || !activeSessionId) { appendMsg('system', '⚠️ Select a project and session first.'); return }
  if (!compactorInstalled) { appendMsg('system', '⚠️ claw-compactor not installed. Run: pip install claw-compactor'); return }

  const btn = document.getElementById('compactBtn')
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Compacting...'

  const history = await window.app.getSessionMsgs(activeProjectId, activeSessionId)
  if (history.length < 5) {
    btn.disabled = false; btn.innerHTML = '🦞 Compact'
    appendMsg('system', 'ℹ️ Not enough messages to compact.')
    return
  }

  const messages = history.map(m => ({ role: m.role, content: m.content }))
  const result = await window.app.compactMessages(messages)

  if (result.stats?.compressed) {
    const compacted = result.messages.map((m, i) => ({ ...m, ts: history[i]?.ts || Date.now() }))
    await window.app.setSessionMsgs(activeProjectId, activeSessionId, compacted)
    conversationHistory = await window.app.getSessionMsgs(activeProjectId, activeSessionId)
    updateSessionInfo()

    const pct = result.stats.reduction_pct
    const statsText = pct ? `🦞 Compressed ${pct.toFixed(1)}%` : `🦞 Compacted ${history.length} → ${compacted.length} messages`
    showCompactNotice(statsText)
    // refresh session list to update message counts
    const sessions = await window.app.listSessions(activeProjectId)
    renderSessionSelect(sessions)
  } else {
    appendMsg('system', `⚠️ Compaction: ${result.stats?.error || 'no change'}`)
  }

  btn.disabled = false; btn.innerHTML = '🦞 Compact'
}

async function maybeAutoCompact() {
  if (!activeProjectId || !activeSessionId || !projectSettings?.autoCompact || !compactorInstalled) return
  const history = await window.app.getSessionMsgs(activeProjectId, activeSessionId)
  if (history.length >= (projectSettings.compactThreshold || 30)) {
    await runCompactNow()
  }
}

// ── keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){const t=document.querySelector('.ed-tab.active')?.dataset?.tab;if(t==='agent')sendAgent();else if(t==='vision')sendVision()}
  if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();if(currentFile)saveFile()}
})

// ── live preview ──────────────────────────────────────────────────────────────
let previewOpen = false

function previewCode(codeBlockId) {
  const el = document.getElementById(codeBlockId)
  if (!el) return
  const raw = el.innerText.replace(/^\d+\s*/gm, '')
  const code = raw.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
  switchMainTab('editor', document.querySelector('[data-tab="editor"]'))
  document.getElementById('editorArea').value = code
  document.getElementById('editorFileName').textContent = 'preview.html'
  document.getElementById('saveBtn').style.display = 'none'
  document.getElementById('previewToggle').style.display = 'inline-block'
  if (!previewOpen) togglePreview()
  refreshPreview()
}

function togglePreview() {
  previewOpen = !previewOpen
  const pane = document.getElementById('previewPane')
  const handle = document.getElementById('previewResizeHandle')
  const btn = document.getElementById('previewToggle')
  pane.style.display = previewOpen ? 'flex' : 'none'
  handle.style.display = previewOpen ? 'block' : 'none'
  btn.textContent = previewOpen ? 'Preview ◂' : 'Preview ▸'
  if (previewOpen) {
    setPreviewDevice(_currentPreviewDevice || 'responsive')
    refreshPreview()
  }
}

// ── preview device presets ─────────────────────────────────────────────────
const _previewDevices = {
  responsive: { w: null, h: null, label: 'Responsive' },
  desktop:    { w: 1440, h: 900, label: '1440 × 900' },
  laptop:     { w: 1280, h: 800, label: '1280 × 800' },
  tablet:     { w: 768,  h: 1024, label: '768 × 1024' },
  mobile:     { w: 375,  h: 667, label: '375 × 667' }
}
let _currentPreviewDevice = 'responsive'

function setPreviewDevice(name) {
  _currentPreviewDevice = name
  const dev = _previewDevices[name]
  const viewport = document.getElementById('previewViewport')
  const frame = document.getElementById('previewFrame')
  const label = document.getElementById('previewSizeLabel')

  // update active button
  document.querySelectorAll('.preview-device-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.device === name)
  })

  if (!dev.w) {
    // responsive — fill the viewport
    viewport.className = 'preview-viewport responsive'
    frame.style.width = '100%'
    frame.style.height = '100%'
    label.textContent = ''
  } else {
    viewport.className = 'preview-viewport device'
    frame.style.width = dev.w + 'px'
    frame.style.height = dev.h + 'px'
    label.textContent = dev.label
  }
}

// ── preview pane resize handle ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const handle = document.getElementById('previewResizeHandle')
  const pane = document.getElementById('previewPane')
  const split = document.querySelector('.editor-split')
  if (!handle || !pane || !split) return

  let dragging = false
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    dragging = true
    handle.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  })
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return
    const rect = split.getBoundingClientRect()
    const x = e.clientX - rect.left
    const total = rect.width
    const editorW = Math.max(200, Math.min(x, total - 220))
    const previewW = total - editorW - 5 // 5 = handle width
    pane.style.width = previewW + 'px'
    pane.style.flex = 'none'
  })
  document.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    handle.classList.remove('dragging')
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })
})

function refreshPreview() {
  const frame = document.getElementById('previewFrame')
  // If previewing a real file on disk, use file:// URL so relative assets (JS, CSS) load correctly
  if (currentFile && /\.(html?|svg)$/i.test(currentFile)) {
    // Remove sandbox to allow file:// navigation and relative resource loading
    frame.removeAttribute('sandbox')
    frame.removeAttribute('srcdoc')
    frame.src = 'file://' + currentFile + '?t=' + Date.now()
  } else {
    // Inline preview for code blocks not saved to disk
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
    frame.removeAttribute('src')
    frame.srcdoc = document.getElementById('editorArea').value
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const editor = document.getElementById('editorArea')
  if (editor) {
    let debounce = null
    editor.addEventListener('input', () => {
      if (!previewOpen) return
      clearTimeout(debounce)
      debounce = setTimeout(async () => {
        // If editing a real file, save it first so the file:// preview picks up changes
        if (currentFile) {
          await window.app.writeFile(currentFile, editor.value)
        }
        refreshPreview()
      }, 400)
    })
  }
})

function updatePreviewToggle() {
  const name = (currentFile || '').toLowerCase()
  const btn = document.getElementById('previewToggle')
  btn.style.display = (name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.svg')) ? 'inline-block' : 'none'
}

async function showPreviewButton(respId) {
  if (!currentProject) return
  const entries = await window.app.readDir(currentProject)
  const htmlFile = entries.find(e => !e.isDir && e.name === 'index.html')
    || entries.find(e => !e.isDir && /\.html?$/i.test(e.name))
  if (!htmlFile) return
  const container = document.getElementById(respId)
  if (!container) return
  container.insertAdjacentHTML('beforeend',
    `<button class="btn-preview-chat" onclick="openLivePreviewFromChat('${htmlFile.path.replace(/'/g,"\\'")}','${htmlFile.name}')">▶ Preview ${htmlFile.name}</button>`)
}

async function openLivePreviewFromChat(filePath, fileName) {
  const content = await window.app.readFile(filePath)
  if (!content) return
  currentFile = filePath
  document.getElementById('editorFileName').textContent = fileName
  document.getElementById('editorArea').value = content
  document.getElementById('saveBtn').style.display = 'inline-block'
  document.getElementById('previewToggle').style.display = 'inline-block'
  switchMainTab('editor', document.querySelector('[data-tab="editor"]'))
  if (!previewOpen) togglePreview()
  refreshPreview()
}

// ── tool use rendering (loaded from lib/tools-render.js) ──────────────────────

// ── task graph panel ──────────────────────────────────────────────────────────
let currentTaskGraph = null
let selectedTaskNodeId = null
let currentTasksPath = null
let _currentAgentType = null

async function loadTaskGraph(filePath) {
  if (!currentProject) return
  const tasksPath = filePath || currentTasksPath || currentProject + '/tasks.md'
  const content = await window.app.readFile(tasksPath)
  if (!content) {
    document.getElementById('taskGraphEmpty').style.display = 'block'
    document.getElementById('taskNodeList').innerHTML = '<div class="model-empty" id="taskGraphEmpty">No task graph loaded. Open a Tasks.md file or start a spec workflow.</div>'
    return
  }
  const graph = await window.app.taskGraphParse(tasksPath)
  if (graph.error) {
    document.getElementById('taskNodeList').innerHTML = `<div class="model-empty" style="color:var(--red)">Error: ${esc(graph.error)}</div>`
    return
  }
  currentTaskGraph = graph
  currentTasksPath = tasksPath
  renderTaskGraph(graph)
  saveWorkflowState() // persist for session restore
}

function renderTaskGraph(graph) {
  if (!graph || !graph.nodes) return
  const container = document.getElementById('taskNodeList')
  const nodes = graph.nodes
  const ids = Object.keys(nodes).sort((a, b) => {
    const ap = a.split('.').map(Number), bp = b.split('.').map(Number)
    for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
      if ((ap[i]||0) !== (bp[i]||0)) return (ap[i]||0) - (bp[i]||0)
    }
    return 0
  })
  if (ids.length === 0) {
    container.innerHTML = '<div class="model-empty">Task graph is empty.</div>'
    return
  }
  container.innerHTML = ids.map(id => {
    const node = nodes[id]
    const indent = (node.depth || 0) * 12
    const agentTag = node.agentType && node.agentType !== 'general' ? `<span class="tg-node-agent">${esc(node.agentType)}</span>` : ''
    const elapsedTag = node.status === 'in_progress'
      ? `<span class="tg-node-elapsed" data-start="${node._startTime || Date.now()}">0s</span>`
      : ''
    const activityTag = node.status === 'in_progress'
      ? `<span class="tg-node-activity" data-node-id="${id}"></span>`
      : ''
    return `<div class="tg-node status-${node.status}" data-node-id="${id}" style="padding-left:${8 + indent}px" onclick="showTaskDetail('${id}')">
      <span class="tg-node-dot ${node.status}"></span>
      <span class="tg-node-id">${esc(id)}</span>
      <span class="tg-node-title">${esc(node.title)}</span>
      ${agentTag}${elapsedTag}${activityTag}
    </div>`
  }).join('')

  // Auto-scroll the active (in_progress) task into view
  const activeNode = container.querySelector('.status-in_progress')
  if (activeNode) activeNode.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function showTaskDetail(nodeId) {
  selectedTaskNodeId = nodeId
  const detail = document.getElementById('taskDetail')
  const content = document.getElementById('taskDetailContent')
  detail.style.display = 'block'
  if (!currentTaskGraph || !currentTaskGraph.nodes[nodeId]) {
    content.innerHTML = '<span style="color:var(--muted)">No data</span>'
    return
  }
  const node = currentTaskGraph.nodes[nodeId]
  const agentType = node.agentType || node.metadata?.agentType || 'general'
  content.innerHTML = `<div><strong>ID:</strong> ${esc(node.id)}</div>
    <div><strong>Title:</strong> ${esc(node.title)}</div>
    <div><strong>Status:</strong> <span class="tg-node-dot ${node.status}" style="display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle"></span> ${node.status}</div>
    <div><strong>Agent Type:</strong> ${agentType}</div>
    <div><strong>Dependencies:</strong> ${(node.dependencies||[]).join(', ') || 'none'}</div>`
}

async function taskGraphRun() {
  if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
  const tasksPath = currentTasksPath || currentProject + '/tasks.md'

  // Ensure the task graph is loaded before execution so status events can update it
  if (!currentTaskGraph) {
    await loadTaskGraph(tasksPath)
    if (!currentTaskGraph) { appendMsg('system', '❌ No task graph found at ' + tasksPath); return }
  }

  const result = await window.app.taskGraphExecute(tasksPath)
  if (result.error) { appendMsg('system', '❌ ' + result.error); return }
  document.getElementById('tgPauseBtn').style.display = 'inline-block'
  document.getElementById('tgAbortBtn').style.display = 'inline-block'
  document.getElementById('tgRunBtn').style.display = 'none'

  // Listen for orchestrator completion to reload the final persisted state
  window.app.onOrchestratorCompleted(() => {
    window.app.offOrchestratorCompleted()
    if (currentTasksPath) loadTaskGraph(currentTasksPath).catch(() => {})
    document.getElementById('tgRunBtn').style.display = 'inline-block'
    document.getElementById('tgPauseBtn').style.display = 'none'
    document.getElementById('tgResumeBtn').style.display = 'none'
    document.getElementById('tgAbortBtn').style.display = 'none'
  })
}

async function taskGraphPause() {
  await window.app.taskGraphPause()
  document.getElementById('tgPauseBtn').style.display = 'none'
  document.getElementById('tgResumeBtn').style.display = 'inline-block'
}

async function taskGraphResume() {
  await window.app.taskGraphResume()
  document.getElementById('tgResumeBtn').style.display = 'none'
  document.getElementById('tgPauseBtn').style.display = 'inline-block'
}

async function taskGraphAbort() {
  if (!confirm('Abort task graph execution?')) return
  const result = await window.app.taskGraphPause()
  document.getElementById('tgPauseBtn').style.display = 'none'
  document.getElementById('tgResumeBtn').style.display = 'none'
  document.getElementById('tgAbortBtn').style.display = 'none'
  document.getElementById('tgRunBtn').style.display = 'inline-block'
}

async function openTasksMd() {
  const path = await window.app.openFile?.({ filters: [{ name: 'Markdown', extensions: ['md'] }] })
  if (!path) return
  const graph = await window.app.taskGraphParse(path)
  if (graph.error) { appendMsg('system', '❌ ' + graph.error); return }
  currentTaskGraph = graph
  renderTaskGraph(graph)
}

// Listen for task status events
if (window.app.onTaskStatusEvent) {
  window.app.onTaskStatusEvent(evt => {
    // Track the current agent type for the stats bar
    if (evt.agentType) _currentAgentType = evt.agentType
    if (evt.status === 'completed' || evt.status === 'failed') {
      // Clear agent type when task finishes (will be set again by next task)
      _currentAgentType = null
    }

    if (currentTaskGraph && currentTaskGraph.nodes) {
      if (currentTaskGraph.nodes[evt.nodeId]) {
        currentTaskGraph.nodes[evt.nodeId].status = evt.status
        if (evt.agentType) currentTaskGraph.nodes[evt.nodeId].agentType = evt.agentType
        // Record start time for elapsed timer
        if (evt.status === 'in_progress') {
          currentTaskGraph.nodes[evt.nodeId]._startTime = Date.now()
        }
        renderTaskGraph(currentTaskGraph)
        renderSpecTaskProgress() // sync spec panel
      } else {
        // Node not found — task graph may be stale, try reloading
        if (currentTasksPath) loadTaskGraph(currentTasksPath).catch(() => {})
      }
    }
    // Also update the todo panel if it's showing items
    if (currentTodos.length > 0) {
      const statusMap = { 'in_progress': 'in_progress', 'completed': 'completed', 'failed': 'pending', 'not_started': 'pending' }
      const todoStatus = statusMap[evt.status] || evt.status
      const updated = currentTodos.map(t => {
        if (String(t.id) === String(evt.nodeId)) {
          return { ...t, status: todoStatus }
        }
        return t
      })

      // Show status change in chat (read from updated array, not stale currentTodos)
      const todo = updated.find(t => String(t.id) === String(evt.nodeId))
      const label = todo ? todo.content : `Task ${evt.nodeId}`
      if (evt.status === 'in_progress') {
        const agentTag = evt.agentType && evt.agentType !== 'general' ? ` [${evt.agentType}]` : ''
        appendMsg('system', `🔄 Task ${evt.nodeId}${agentTag}: ${esc(label)}`)
      } else if (evt.status === 'completed') {
        appendMsg('system', `✅ Task ${evt.nodeId}: ${esc(label)}`)
      } else if (evt.status === 'failed') {
        appendMsg('system', `❌ Task ${evt.nodeId}: ${esc(label)}${evt.error ? ' — ' + esc(evt.error) : ''}`)
      }

      updateTodoPanel(updated, 'done')
    }
  })
}

// ── Elapsed timer for in-progress task nodes ──────────────────────────────────
setInterval(() => {
  const elapsedEls = document.querySelectorAll('.tg-node-elapsed')
  elapsedEls.forEach(el => {
    const start = parseInt(el.dataset.start, 10)
    if (!start) return
    const secs = Math.floor((Date.now() - start) / 1000)
    const mins = Math.floor(secs / 60)
    el.textContent = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`
  })
}, 1000)

// ── Forward agent streaming events to active task activity indicator ──────────
if (window.app.onOrchestratorEvent) {
  window.app.onOrchestratorEvent(evt => {
    // evt.taskId, evt.channel, evt.data
    const taskId = evt.taskId
    if (!taskId) return
    const activityEl = document.querySelector(`.tg-node-activity[data-node-id="${taskId}"]`)
    if (!activityEl) return
    // Show the tool/channel name as a brief activity hint
    let hint = ''
    if (evt.channel === 'tool_use') {
      hint = `⚙ ${evt.data?.name || 'tool'}`
    } else if (evt.channel === 'tool_result') {
      hint = `✓ ${evt.data?.name || 'done'}`
    } else if (evt.channel === 'text' && evt.data) {
      // Show last ~40 chars of streamed text
      const text = typeof evt.data === 'string' ? evt.data : (evt.data.text || '')
      hint = text.slice(-40).replace(/\n/g, ' ')
    } else if (evt.channel) {
      hint = evt.channel
    }
    if (hint) activityEl.textContent = hint
  })
}


let currentSpecDir = null
let currentSpecName = null
let specGenerating = false

// ── spec task progress (in spec sidebar panel) ───────────────────────────────
function renderSpecTaskProgress() {
  const panel = document.getElementById('specTaskProgress')
  const list = document.getElementById('specTaskList')
  const countEl = document.getElementById('specTaskProgressCount')
  if (!panel || !list) return

  if (!currentTaskGraph || !currentTaskGraph.nodes) {
    panel.style.display = 'none'
    return
  }

  const nodes = currentTaskGraph.nodes
  const ids = Object.keys(nodes).sort((a, b) => {
    const ap = a.split('.').map(Number), bp = b.split('.').map(Number)
    for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
      if ((ap[i]||0) !== (bp[i]||0)) return (ap[i]||0) - (bp[i]||0)
    }
    return 0
  })

  if (ids.length === 0) { panel.style.display = 'none'; return }

  const completed = ids.filter(id => nodes[id].status === 'completed').length
  const total = ids.length
  if (countEl) countEl.textContent = `${completed}/${total}`

  panel.style.display = ''
  list.innerHTML = ids.map(id => {
    const node = nodes[id]
    const indent = (node.depth || 0) * 10
    const statusClass = node.status || 'not_started'
    return `<div class="spec-task-item ${statusClass}" style="padding-left:${6 + indent}px">
      <span class="st-dot ${statusClass}"></span>
      <span class="st-id">${esc(id)}</span>
      <span class="st-title">${esc(node.title)}</span>
    </div>`
  }).join('')
}

async function restoreActiveSpec() {
  if (!window.app.specList) return
  const specs = await window.app.specList()
  if (!specs || specs.length === 0) {
    currentSpecDir = null
    currentSpecName = null
    return
  }
  // Restore the most recently modified spec
  const latest = specs[0]
  currentSpecDir = latest.specDir
  currentSpecName = latest.name
}

function openSpecPanel() {
  // Open the sidebar spec panel AND show inline workflow in chat
  showPanel('specs', document.querySelector('[data-panel="specs"]'))
  showInlineSpecWorkflow()
}

async function showInlineSpecWorkflow() {
  const out = document.getElementById('agentOutput')
  // Clear the build picker if present
  const picker = out.querySelector('.build-picker')
  if (picker) picker.remove()
  // Remove any existing inline spec
  const existing = out.querySelector('.inline-spec-workflow')
  if (existing) existing.remove()

  // Fetch existing specs for the switcher
  let specs = []
  if (window.app.specList) {
    specs = await window.app.specList() || []
  }

  const specOptionsHtml = specs.map(s => {
    const selected = s.specDir === currentSpecDir ? 'selected' : ''
    const phase = s.currentPhase || 'requirements'
    return `<option value="${esc(s.specDir)}" data-name="${esc(s.name)}" ${selected}>${esc(s.name)} — ${phase}</option>`
  }).join('')

  const switcherHtml = specs.length > 0 ? `
    <div class="inline-spec-switcher" id="inlineSpecSwitcher">
      <select class="inline-spec-select" id="inlineSpecSelect">
        <option value="">— Select a spec —</option>
        ${specOptionsHtml}
      </select>
      <button class="inline-spec-new-btn" id="inlineSpecNewBtn">＋ New</button>
    </div>` : ''

  const html = `
  <div class="inline-spec-workflow" id="inlineSpecWorkflow">
    ${switcherHtml}

    <!-- create new spec -->
    <div class="inline-spec-create" id="inlineSpecCreate" ${currentSpecDir ? 'style="display:none"' : ''}>
      <div class="inline-spec-header">
        <span class="inline-spec-icon">📐</span>
        <span class="inline-spec-title">Create a Spec</span>
      </div>
      <div class="inline-spec-desc">Plan before you build. The AI will generate requirements, design, and tasks for you.</div>
      <input type="text" id="inlineSpecName" class="inline-spec-input" placeholder="feature-name">
      <textarea id="inlineSpecDescription" class="inline-spec-textarea" placeholder="Describe what you want to build..." rows="3"></textarea>
      <button class="inline-spec-btn" onclick="createInlineSpec()">📐 Create Spec</button>
    </div>

    <!-- active spec view -->
    <div class="inline-spec-active" id="inlineSpecActive" style="${currentSpecDir ? '' : 'display:none'}">
      <div class="inline-spec-name-bar">
        <span class="inline-spec-icon">📐</span>
        <span class="inline-spec-name" id="inlineSpecNameLabel">${currentSpecName || ''}</span>
        <button class="inline-spec-close" onclick="closeInlineSpec()" title="Close spec">✕</button>
      </div>

      <!-- phase stepper -->
      <div class="inline-spec-stepper" id="inlineSpecStepper">
        <div class="inline-spec-step" data-phase="requirements">
          <div class="inline-spec-step-dot" id="inlineStepDot-requirements"></div>
          <div class="inline-spec-step-info">
            <div class="inline-spec-step-label">Requirements</div>
            <div class="inline-spec-step-status" id="inlineStepStatus-requirements">Pending</div>
          </div>
          <button class="spec-gen-btn" id="inlineGenBtn-requirements" onclick="generateInlineSpecPhase('requirements')">✦ Generate</button>
        </div>
        <div class="inline-spec-step-line"></div>
        <div class="inline-spec-step" data-phase="design">
          <div class="inline-spec-step-dot" id="inlineStepDot-design"></div>
          <div class="inline-spec-step-info">
            <div class="inline-spec-step-label">Design</div>
            <div class="inline-spec-step-status" id="inlineStepStatus-design">Pending</div>
          </div>
          <button class="spec-gen-btn" id="inlineGenBtn-design" onclick="generateInlineSpecPhase('design')">✦ Generate</button>
        </div>
        <div class="inline-spec-step-line"></div>
        <div class="inline-spec-step" data-phase="tasks">
          <div class="inline-spec-step-dot" id="inlineStepDot-tasks"></div>
          <div class="inline-spec-step-info">
            <div class="inline-spec-step-label">Tasks</div>
            <div class="inline-spec-step-status" id="inlineStepStatus-tasks">Pending</div>
          </div>
          <button class="spec-gen-btn" id="inlineGenBtn-tasks" onclick="generateInlineSpecPhase('tasks')">✦ Generate</button>
        </div>
        <div class="inline-spec-step-line"></div>
        <div class="inline-spec-step" data-phase="implementation">
          <div class="inline-spec-step-dot" id="inlineStepDot-implementation"></div>
          <div class="inline-spec-step-info">
            <div class="inline-spec-step-label">Implementation</div>
            <div class="inline-spec-step-status" id="inlineStepStatus-implementation">Pending</div>
          </div>
          <button class="spec-gen-btn" id="inlineGenBtn-implementation" onclick="startInlineSpecImplementation()">▶ Build</button>
        </div>
      </div>

      <!-- artifact viewer -->
      <div class="inline-spec-artifact" id="inlineSpecArtifact">
        <div class="inline-spec-artifact-empty" id="inlineSpecArtifactEmpty">Select a phase above to view or generate its content.</div>
        <div class="inline-spec-artifact-content" id="inlineSpecArtifactContent" style="display:none">
          <div class="inline-spec-artifact-header" id="inlineSpecArtifactHeader"></div>
          <div class="inline-spec-artifact-body" id="inlineSpecArtifactBody"></div>
        </div>
      </div>
    </div>
  </div>`
  out.insertAdjacentHTML('afterbegin', html)

  // Wire up switcher events
  const selectEl = document.getElementById('inlineSpecSelect')
  if (selectEl) {
    selectEl.addEventListener('change', () => {
      const specDir = selectEl.value
      if (!specDir) return
      const opt = selectEl.selectedOptions[0]
      const name = opt?.dataset?.name || ''
      switchToSpec(specDir, name)
    })
  }
  const newBtn = document.getElementById('inlineSpecNewBtn')
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      currentSpecDir = null
      currentSpecName = null
      if (selectEl) selectEl.value = ''
      document.getElementById('inlineSpecCreate').style.display = ''
      document.getElementById('inlineSpecActive').style.display = 'none'
      // Clear artifact viewer and reset stepper
      const artifactContent = document.getElementById('inlineSpecArtifactContent')
      const artifactEmpty = document.getElementById('inlineSpecArtifactEmpty')
      if (artifactContent) artifactContent.style.display = 'none'
      if (artifactEmpty) artifactEmpty.style.display = ''
      // Clear any previous chat messages below the spec workflow
      const out = document.getElementById('agentOutput')
      const workflow = out.querySelector('.inline-spec-workflow')
      if (workflow) {
        while (workflow.nextSibling) workflow.nextSibling.remove()
      }
    })
  }

  scrollOutput()
  if (currentSpecDir) {
    await refreshInlineSpecStepper()
    // Load the task graph if this spec has tasks.md
    const specTasksPath = currentSpecDir + '/tasks.md'
    if (!currentTaskGraph || currentTasksPath !== specTasksPath) {
      try { await loadTaskGraph(specTasksPath) } catch (_) { /* tasks may not exist yet */ }
    }
  }
}

async function switchToSpec(specDir, name) {
  currentSpecDir = specDir
  currentSpecName = name
  document.getElementById('inlineSpecCreate').style.display = 'none'
  document.getElementById('inlineSpecActive').style.display = ''
  document.getElementById('inlineSpecNameLabel').textContent = name
  // Reset artifact viewer
  document.getElementById('inlineSpecArtifactContent').style.display = 'none'
  document.getElementById('inlineSpecArtifactEmpty').style.display = ''
  await refreshInlineSpecStepper()
  // Load the task graph if this spec has tasks.md
  const specTasksPath = specDir + '/tasks.md'
  try { await loadTaskGraph(specTasksPath) } catch (_) { /* tasks may not exist yet */ }
  saveWorkflowState() // persist spec context for session restore
}

async function refreshInlineSpecSwitcher() {
  const selectEl = document.getElementById('inlineSpecSelect')
  if (!selectEl || !window.app.specList) return
  const specs = await window.app.specList() || []
  selectEl.innerHTML = '<option value="">— Select a spec —</option>' +
    specs.map(s => {
      const selected = s.specDir === currentSpecDir ? 'selected' : ''
      const phase = s.currentPhase || 'requirements'
      return `<option value="${esc(s.specDir)}" data-name="${esc(s.name)}" ${selected}>${esc(s.name)} — ${phase}</option>`
    }).join('')
}

async function createInlineSpec() {
  const nameInput = document.getElementById('inlineSpecName')
  const descInput = document.getElementById('inlineSpecDescription')
  const name = (nameInput?.value || '').trim()
  const description = (descInput?.value || '').trim()
  if (!name) { appendMsg('system', '⚠️ Enter a feature name.'); return }
  if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
  const result = await window.app.specInit(name)
  if (result.error) { appendMsg('system', '❌ ' + result.error); return }
  currentSpecDir = result.specDir
  currentSpecName = result.featureName
  if (description) {
    await window.app.specSaveArtifact(currentSpecDir, 'requirements', `# ${name}\n\n## Description\n${description}\n`)
  }
  document.getElementById('inlineSpecCreate').style.display = 'none'
  document.getElementById('inlineSpecActive').style.display = ''
  document.getElementById('inlineSpecNameLabel').textContent = name
  await refreshInlineSpecStepper()
  // Update the switcher dropdown with the new spec
  await refreshInlineSpecSwitcher()
  saveWorkflowState() // persist spec context for session restore
  appendMsg('system', `📐 Spec "${name}" created. Generating requirements...`)
  // Auto-start generating requirements immediately
  generateInlineSpecPhase('requirements')
}

function closeInlineSpec() {
  currentSpecDir = null
  currentSpecName = null
  const workflow = document.getElementById('inlineSpecWorkflow')
  if (workflow) workflow.remove()
  saveWorkflowState() // persist cleared spec state
}

async function refreshInlineSpecStepper() {
  if (!currentSpecDir) return
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (artifacts.error) return
  const config = await window.app.specConfig(currentSpecDir)
  const currentPhase = config.currentPhase || 'requirements'
  const phases = ['requirements', 'design', 'tasks', 'implementation']
  const currentIdx = phases.indexOf(currentPhase)

  for (const phase of phases) {
    const dot = document.getElementById('inlineStepDot-' + phase)
    const status = document.getElementById('inlineStepStatus-' + phase)
    const btn = document.getElementById('inlineGenBtn-' + phase)
    if (!dot || !status) continue
    const idx = phases.indexOf(phase)
    const hasArtifact = !!artifacts[phase]

    dot.className = 'inline-spec-step-dot'
    status.className = 'inline-spec-step-status'

    if (hasArtifact) {
      dot.classList.add('completed')
      status.classList.add('done')
      status.textContent = '✓ Generated'
      if (btn && phase !== 'implementation') { btn.textContent = '👁 View'; btn.disabled = false; btn.onclick = () => viewInlineSpecArtifact(phase) }
    } else if (idx === currentIdx) {
      dot.classList.add('active')
      status.textContent = 'Ready to generate'
      if (btn && phase !== 'implementation') { btn.textContent = '✦ Generate'; btn.disabled = false; btn.onclick = () => generateInlineSpecPhase(phase) }
    } else {
      status.textContent = idx < currentIdx ? 'Skipped' : 'Pending'
      if (btn && phase !== 'implementation') {
        // Enable the next phase after current, disable anything further out
        const canGenerate = idx <= currentIdx + 1
        btn.disabled = !canGenerate
        btn.textContent = '✦ Generate'
        btn.onclick = canGenerate ? () => generateInlineSpecPhase(phase) : null
      }
    }
  }

  const lines = document.querySelectorAll('.inline-spec-step-line')
  lines.forEach((line, i) => {
    line.className = 'inline-spec-step-line'
    if (artifacts[phases[i]]) line.classList.add('completed')
  })

  const implBtn = document.getElementById('inlineGenBtn-implementation')
  if (implBtn) {
    const ready = artifacts.requirements && artifacts.design && artifacts.tasks
    implBtn.disabled = !ready
  }
}

async function viewInlineSpecArtifact(phase) {
  if (!currentSpecDir) return
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (artifacts.error || !artifacts[phase]) return
  const labels = { requirements: '📋 Requirements', design: '🏗 Design', tasks: '📝 Tasks' }
  document.getElementById('inlineSpecArtifactEmpty').style.display = 'none'
  document.getElementById('inlineSpecArtifactContent').style.display = ''
  const headerEl = document.getElementById('inlineSpecArtifactHeader')
  headerEl.innerHTML = `${labels[phase] || phase} <button class="btn-sm" id="inlineRegenBtn" style="margin-left:auto;font-size:9px;padding:2px 6px">✦ Regenerate</button>`
  document.getElementById('inlineRegenBtn').onclick = () => generateInlineSpecPhase(phase)
  document.getElementById('inlineSpecArtifactBody').innerHTML = renderMd(artifacts[phase])
}

async function generateInlineSpecPhase(phase) {
  if (!currentSpecDir || !loadedModelId || specGenerating) return
  specGenerating = true

  // Disable ALL phase buttons during generation
  const allPhases = ['requirements', 'design', 'tasks', 'implementation']
  for (const p of allPhases) {
    const b = document.getElementById('inlineGenBtn-' + p)
    if (b) b.disabled = true
  }

  const btn = document.getElementById('inlineGenBtn-' + phase)
  const status = document.getElementById('inlineStepStatus-' + phase)
  const dot = document.getElementById('inlineStepDot-' + phase)
  if (btn) { btn.textContent = '⏳ Generating...'; btn.classList.add('generating') }
  if (status) { status.textContent = 'Generating...'; status.className = 'inline-spec-step-status generating' }
  if (dot) { dot.className = 'inline-spec-step-dot generating' }

  // Show agent stats bar immediately
  const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1)
  updateAgentStatsBar({ state: 'initializing', activity: `Spec: preparing ${phaseLabel}...` })

  // Auto-collapse any previous spec phase blocks
  document.querySelectorAll('.spec-phase-block').forEach(el => {
    el.querySelectorAll('details[open]').forEach(d => d.removeAttribute('open'))
  })

  // Create a live chat message block for streaming output
  const specRespId = 'spec-resp-' + Date.now()
  const out = document.getElementById('agentOutput')
  out.insertAdjacentHTML('beforeend', `<div class="msg-block spec-phase-block" id="${specRespId}">
    <div class="msg-system" id="${specRespId}-status">📐 Generating ${phaseLabel} for "${esc(currentSpecName)}"...</div>
    <details class="msg-thinking" id="${specRespId}-think" style="display:none" open>
      <summary>🧠 Thinking</summary>
      <div class="msg-thinking-body" id="${specRespId}-think-body"></div>
    </details>
    <details class="spec-phase-output" open>
      <summary>📄 ${phaseLabel} output</summary>
      <div class="msg-text" id="${specRespId}-text"></div>
    </details>
  </div>`)
  scrollOutput()

  try {
    const artifacts = await window.app.specArtifacts(currentSpecDir)
    let ctx = ''
    if (currentProject) {
      ctx = await window.app.buildContext(currentProject) || ''
    }

    let prompt
    const desc = artifacts.requirements?.match(/## Description\n([\s\S]*?)(?=\n##|\n$|$)/)?.[1]?.trim() || ''
    if (phase === 'requirements') {
      prompt = SPEC_PROMPTS.requirements(currentSpecName, desc, ctx)
    } else if (phase === 'design') {
      prompt = SPEC_PROMPTS.design(currentSpecName, artifacts.requirements || '', ctx)
    } else if (phase === 'tasks') {
      prompt = SPEC_PROMPTS.tasks(currentSpecName, artifacts.requirements || '', artifacts.design || '')
    }

    // Use streaming chat for real-time stats bar + chat output
    const content = await new Promise((resolve, reject) => {
      let accumulated = ''
      let tokenCount = 0
      let inputTokens = 0
      let outputTokens = 0
      let serverTps = null
      let startTime = null

      // Debounced markdown rendering to avoid O(n²) re-render on every delta
      let _mdRenderTimer = null
      let _mdDirty = false
      function scheduleRender() {
        _mdDirty = true
        if (_mdRenderTimer) return
        _mdRenderTimer = requestAnimationFrame(() => {
          _mdRenderTimer = null
          if (_mdDirty) {
            _mdDirty = false
            // Show thinking content in the thinking section
            const thinkContent = extractThinking(accumulated)
            if (thinkContent) {
              const thinkEl = document.getElementById(specRespId + '-think')
              if (thinkEl) thinkEl.style.display = ''
              const thinkBody = document.getElementById(specRespId + '-think-body')
              if (thinkBody) thinkBody.textContent = thinkContent + '▌'
            }
            // Strip thinking tags from main display
            let displayText = accumulated.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
            const openThink = accumulated.lastIndexOf('<think>')
            const closeThink = accumulated.lastIndexOf('</think>')
            if (openThink > closeThink) displayText = accumulated.slice(0, openThink).trim()
            const textEl = document.getElementById(specRespId + '-text')
            if (textEl && displayText) textEl.innerHTML = renderMd(displayText, true) + '<span class="cursor">▌</span>'
            scrollOutput()
          }
        })
      }

      // Simulated prompt-eval progress while waiting for first token
      let promptProgress = 0
      let promptElapsed = 0
      const promptTimer = setInterval(() => {
        promptElapsed += 200
        promptProgress = 90 * (1 - Math.exp(-promptElapsed / 6000))
        updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens, progress: promptProgress, activity: `Spec ${phaseLabel}: evaluating prompt...` })
      }, 200)

      updateAgentStatsBar({ state: 'prompt-eval', progress: 0, activity: `Spec ${phaseLabel}: evaluating prompt...` })

      window.app.offStream()

      window.app.onStreamChunk((parsed) => {
        if (!startTime) {
          startTime = Date.now()
          clearInterval(promptTimer)
        }
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) {
          accumulated += delta
          tokenCount++
          outputTokens = tokenCount
          const tks = serverTps || _calcTks(tokenCount, startTime)
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks, activity: `Spec ${phaseLabel}: generating...` })
          scheduleRender()
        }
      })

      window.app.onStreamStats((stats) => {
        inputTokens = stats.prompt_tokens || inputTokens
        outputTokens = stats.completion_tokens || outputTokens || tokenCount
        if (stats.generation_tps) serverTps = stats.generation_tps
        const promptTps = stats.prompt_tps || null
        const peakMemory = stats.peak_memory_gb || null
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks: serverTps, promptTps, peakMemory, activity: `Spec ${phaseLabel}: generating...` })
      })

      window.app.onStreamDone(() => {
        clearInterval(promptTimer)
        window.app.offStream()
        resolve(accumulated)
      })

      window.app.onStreamError((err) => {
        clearInterval(promptTimer)
        window.app.offStream()
        reject(new Error(err))
      })

      window.app.chatStream({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
      })
    })

    // Finalize the chat block with rendered markdown (no cursor)
    const statusEl = document.getElementById(specRespId + '-status')
    const textEl = document.getElementById(specRespId + '-text')

    // Finalize thinking section — remove trailing cursor
    const thinkBody = document.getElementById(specRespId + '-think-body')
    if (thinkBody && thinkBody.textContent.endsWith('▌')) {
      thinkBody.textContent = thinkBody.textContent.slice(0, -1)
    }

    if (!content) {
      if (statusEl) statusEl.textContent = `❌ Spec ${phaseLabel} generation failed: empty response`
      appendMsg('system', `❌ Spec generation failed: empty response`)
      updateAgentStatsBar({ state: 'done', activity: 'Spec generation failed' })
    } else {
      // Strip <think> tags
      let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      // Strip plain-text thinking preamble — everything before the first markdown heading
      if (!/^#/m.test(cleaned.split('\n')[0]) && /^#/m.test(cleaned)) {
        cleaned = cleaned.slice(cleaned.search(/^#/m)).trim()
      }

      // Update chat block with final rendered content
      if (statusEl) statusEl.textContent = `✅ ${phaseLabel} generated for "${currentSpecName}"`
      if (textEl) textEl.innerHTML = renderMd(cleaned)

      await window.app.specSaveArtifact(currentSpecDir, phase, cleaned)
      await window.app.specAdvance(currentSpecDir)
      updateAgentStatsBar({ state: 'done', activity: `Spec ${phaseLabel}: complete` })
      viewInlineSpecArtifact(phase)

      // If tasks were generated, write Tasks.md and load into task graph
      if (phase === 'tasks' && currentProject) {
        const tasksPath = currentProject + '/.maccoder/specs/' + currentSpecName + '/tasks.md'
        try {
          await loadTaskGraph(tasksPath)
          showPanel('tasks', document.querySelector('[data-panel="tasks"]'))
          appendMsg('system', `📋 Tasks loaded into task graph.`)
        } catch (e) {
          // task graph load is best-effort
        }
      }
    }
  } catch (e) {
    const statusEl = document.getElementById(specRespId + '-status')
    if (statusEl) statusEl.textContent = `❌ Error: ${e.message}`
    appendMsg('system', `❌ Error: ${e.message}`)
    updateAgentStatsBar({ state: 'done', activity: 'Spec generation failed' })
  }

  if (btn) { btn.classList.remove('generating') }
  specGenerating = false
  await refreshInlineSpecStepper()
}

async function _launchOrchestrator(tasksPath, taskCount) {
  // Parse the task graph first
  let parsed = null
  try {
    parsed = await window.app.taskGraphParse(tasksPath)
  } catch (_) { /* best-effort */ }

  if (parsed && parsed.nodes) {
    currentTaskGraph = parsed
    currentTasksPath = tasksPath
    renderTaskGraph(parsed)
    saveWorkflowState()

    const todos = Object.values(parsed.nodes).map(n => ({
      id: n.id,
      content: n.title,
      status: n.status === 'not_started' ? 'pending' : n.status,
    }))
    if (todos.length > 0) updateTodoPanel(todos, 'done')
  }

  agentFinished = false
  isGenerating = true
  const btn = document.getElementById('sendBtn')
  btn.disabled = false; btn.innerHTML = '<span class="spinner"></span>Stop'; btn.className = 'btn-send btn-stop'
  btn.onclick = () => { window.app.qwenInterrupt(); finishGeneration() }

  // Sync task graph sidebar buttons
  document.getElementById('tgRunBtn').style.display = 'none'
  document.getElementById('tgPauseBtn').style.display = 'inline-block'
  document.getElementById('tgAbortBtn').style.display = 'inline-block'

  // Switch to tasks panel in sidebar
  showPanel('tasks', document.querySelector('[data-panel="tasks"]'))

  const orchId = 'resp-orch-' + Date.now()
  const out = document.getElementById('agentOutput')
  out.insertAdjacentHTML('beforeend', `<div class="msg-block" id="${orchId}">
    <div class="msg-system" id="${orchId}-status">🚀 Orchestrator: executing ${taskCount || ''} tasks...</div>
    <div id="${orchId}-tasks"></div>
  </div>`)
  scrollOutput()

  window.app.offQwenEvents()
  let orchToolName = ''
  let orchTaskBlockId = null
  let orchTaskText = ''
  let orchTaskCount = 0

  function newOrchTaskBlock(label) {
    orchTaskCount++
    orchTaskText = ''
    orchTaskBlockId = orchId + '-task-' + orchTaskCount
    const tasksDiv = document.getElementById(orchId + '-tasks')
    tasksDiv.insertAdjacentHTML('beforeend', `<div class="msg-block" id="${orchTaskBlockId}" style="margin:6px 0;padding:8px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg3)">
      <div class="msg-system" id="${orchTaskBlockId}-status" style="font-weight:600">${label}</div>
      <div id="${orchTaskBlockId}-tools"></div>
      <details class="msg-thinking" id="${orchTaskBlockId}-think" style="display:none">
        <summary>🧠 Thinking</summary>
        <div class="msg-thinking-body" id="${orchTaskBlockId}-think-body"></div>
      </details>
      <div class="msg-text" id="${orchTaskBlockId}-text"></div>
    </div>`)
    scrollOutput()
  }

  window.app.onQwenEvent(ev => {
    switch (ev.type) {
      case 'agent-type': {
        // Small model routed this prompt — set agent type before session-start fires
        if (ev.agentType && ev.agentType !== 'general') {
          _currentAgentType = ev.agentType
          // Update the dropdown to show what was auto-picked
          const sel = document.getElementById('roleSelect')
          if (sel && sel.value === 'general') {
            sel.value = ev.agentType
            // Flash it briefly so user notices the auto-selection
            sel.style.outline = '1px solid var(--accent, #7c6af7)'
            setTimeout(() => { sel.style.outline = '' }, 2000)
          }
        }
        break
      }
      case 'routing-decision': {
        const roleIcons = { implementation: '🔨', explore: '🔍', 'context-gather': '📚', 'code-search': '🔎', general: '⚡', debug: '🐛', tester: '🧪', requirements: '📋', design: '📐' }
        const icon = roleIcons[ev.agentType] || '⚡'
        if (ev.source === 'small model' || ev.source === 'keyword' || ev.source === 'todo') {
          const label = ev.source === 'keyword' ? '⚡ Fast routed'
            : ev.source === 'todo' ? '⚡ Todo routed'
            : '🤖 Fast model routed'
          const toolsEl = orchTaskBlockId ? document.getElementById(orchTaskBlockId + '-tools') : null
          const html = `<div class="msg-system" style="color:var(--accent,#7c6af7);font-size:11px;padding:2px 8px">${label} → ${icon} ${ev.agentType}</div>`
          if (toolsEl) toolsEl.insertAdjacentHTML('afterbegin', html)
          else appendMsg('system', `<span style="color:var(--accent,#7c6af7);font-size:11px">${label} → ${icon} ${ev.agentType}</span>`)
        }
        break
      }
      case 'fast-assist': {
        const faOrcEl = orchTaskBlockId ? document.getElementById(orchTaskBlockId + '-fast') : null
        if (faOrcEl) faOrcEl.insertAdjacentHTML('beforeend', renderFastAssistBlock(ev))
        else appendMsg('system', `<span style="color:var(--accent,#7c6af7);font-size:11px">${ev.label || '⚡ Fast Assistant'}</span>`)
        break
      }
      case 'session-start': {
        const activeTask = currentTodos.find(t => t.status === 'in_progress')
        const agentType = _currentAgentType
        const agentBadge = agentType && agentType !== 'general' ? ` <span class="orch-agent-badge">${agentType}</span>` : ''
        const taskLabel = activeTask ? `🔧 Task ${activeTask.id}: ${activeTask.content}${agentBadge}` : '🔧 Working on task...'
        newOrchTaskBlock(taskLabel)
        document.getElementById(orchId + '-status').textContent = `🚀 Orchestrator: task ${orchTaskCount}...`
        startPromptProgress()
        updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens: tokenCount, progress: 0, toolCount: _agentToolCount, agentType, activity: activeTask ? `Task ${activeTask.id}: Evaluating prompt...` : 'Evaluating prompt...' })
        break
      }
      case 'text-delta': {
        if (!orchTaskBlockId) newOrchTaskBlock('🔧 Working...')
        stopPromptProgress()
        orchTaskText = ev.text
        let displayText = orchTaskText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
        const openThink = orchTaskText.lastIndexOf('<think>')
        const closeThink = orchTaskText.lastIndexOf('</think>')
        if (openThink > closeThink) {
          displayText = orchTaskText.slice(0, openThink).trim()
          const thinkContent = orchTaskText.slice(openThink + 7)
          const thinkEl = document.getElementById(orchTaskBlockId + '-think')
          if (thinkEl) { thinkEl.style.display = ''; document.getElementById(orchTaskBlockId + '-think-body').textContent = thinkContent + '▌' }
        }
        const textEl = document.getElementById(orchTaskBlockId + '-text')
        if (textEl && displayText) textEl.innerHTML = renderMd(displayText, true) + '<span class="cursor">▌</span>'
        tokenCount++
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: 'Writing response...' })
        scrollOutput()
        break
      }
      case 'tool-use':
        if (!orchTaskBlockId) newOrchTaskBlock('🔧 Working...')
        stopPromptProgress()
        orchToolName = ev.name || ''
        _agentToolCount++
        document.getElementById(orchTaskBlockId + '-tools').insertAdjacentHTML('beforeend', renderToolUse(ev.name, ev.input, 'running'))
        document.getElementById(orchTaskBlockId + '-status').textContent = `🔧 Using tool: ${ev.name}`
        updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: `Running ${ev.name}...` })
        scrollOutput()
        break
      case 'tool-result': {
        if (!orchTaskBlockId) break
        const toolsDiv = document.getElementById(orchTaskBlockId + '-tools')
        const lastTool = toolsDiv?.querySelector('.tool-block:last-child')
        if (lastTool) {
          const newStatus = ev.is_error ? 'error' : 'done'
          lastTool.className = lastTool.className.replace(/\b(running|done|error)\b/g, '').trim() + ' ' + newStatus
          const statusEl = lastTool.querySelector('.tool-status')
          if (statusEl) { statusEl.className = 'tool-status ' + newStatus; statusEl.innerHTML = ev.is_error ? '✗ Error' : '✓ Done' }
          lastTool.insertAdjacentHTML('beforeend', renderToolResult(ev.content, ev.is_error))
        }
        const FILE_TOOLS = ['write_file', 'edit_file', 'create_file', 'bash']
        if (!ev.is_error && FILE_TOOLS.some(t => orchToolName.includes(t))) {
          if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
        }
        updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: tokenCount, toolCount: _agentToolCount, agentType: _currentAgentType, activity: 'Thinking about next step...' })
        scrollOutput()
        break
      }
      case 'result':
        if (orchTaskBlockId && ev.result && !ev.is_error) {
          const textEl = document.getElementById(orchTaskBlockId + '-text')
          if (textEl) {
            let cleanResult = ev.result.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
            textEl.innerHTML = renderMd(cleanResult)
          }
        }
        break
      case 'raw-stream': {
        const sev = ev.event; if (!sev) break
        if (sev.usage) {
          inputTokens = sev.usage.prompt_tokens || inputTokens
          outputTokens = sev.usage.completion_tokens || outputTokens
          const genTps = sev.x_stats?.generation_tps
          const promptTps = sev.x_stats?.prompt_tps
          if (genTps) serverTps = genTps
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks: genTps, promptTps, peakMemory: sev.x_stats?.peak_memory_gb, toolCount: _agentToolCount, agentType: _currentAgentType })
        }
        break
      }
      case 'session-end':
        if (orchTaskBlockId) {
          const statusEl = document.getElementById(orchTaskBlockId + '-status')
          if (statusEl) statusEl.textContent = '✅ Task completed'
          const tb = document.getElementById(orchTaskBlockId + '-think-body')
          if (tb && tb.textContent.endsWith('▌')) tb.textContent = tb.textContent.slice(0, -1)
        }
        orchTaskBlockId = null
        orchTaskText = ''
        document.getElementById(orchId + '-status').textContent = '🚀 Orchestrator: moving to next task...'
        scrollOutput()
        break
      case 'error':
        appendMsg('system', '❌ Task error: ' + ev.error)
        break
    }
  })

  window.app.onOrchestratorCompleted(() => {
    window.app.offOrchestratorCompleted()
    window.app.offQwenEvents()
    const allDone = currentTodos.every(t => t.status === 'completed' || t.status === 'done')
    document.getElementById(orchId + '-status').textContent = allDone ? '✅ All tasks completed' : '⚠️ Orchestrator stopped'
    if (allDone) appendMsg('system', '🎉 All tasks completed!')
    if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
    saveChatSnapshot()
    agentFinished = true
    isGenerating = false
    updateStatusBar('idle')
    updateAgentStatsBar({ state: 'done', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount })
    finishGeneration()

    document.getElementById('tgRunBtn').style.display = 'inline-block'
    document.getElementById('tgPauseBtn').style.display = 'none'
    document.getElementById('tgResumeBtn').style.display = 'none'
    document.getElementById('tgAbortBtn').style.display = 'none'

    if (currentTasksPath) loadTaskGraph(currentTasksPath).catch(() => {})
  })

  window.app.taskGraphExecute(tasksPath).then(r => {
    console.log('[orchestrator] Result:', r)
    if (r.error) appendMsg('system', `⚠️ Orchestrator error: ${r.error}`)
  }).catch(err => {
    console.error('[orchestrator] Error:', err)
    appendMsg('system', `⚠️ Orchestrator failed: ${err.message}`)
  })
}

async function startInlineSpecImplementation() {
  if (!currentSpecDir || !currentProject) return
  if (isGenerating) return
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (!artifacts.tasks) { appendMsg('system', '⚠️ Generate tasks first.'); return }

  // Load task graph into the sidebar panel first
  const tasksPath = currentProject + '/.maccoder/specs/' + currentSpecName + '/tasks.md'
  try {
    await loadTaskGraph(tasksPath)
    renderSpecTaskProgress()
  } catch (e) { /* best-effort */ }

  // Count tasks for the summary
  const taskLines = artifacts.tasks.split('\n').filter(l => /^- \[[ x]\]/.test(l.trim()))
  const taskCount = taskLines.length

  // Show a clean formatted card in chat
  appendMsg('system', `📐 Starting implementation for "${currentSpecName}"...`)
  const out = document.getElementById('agentOutput')
  out.insertAdjacentHTML('beforeend', `<div class="msg-user">
    <div class="msg-user-label">Spec Implementation</div>
    <div style="margin:6px 0 4px;font-weight:600">📐 ${esc(currentSpecName)}</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:6px">${taskCount} tasks · ${esc(currentProject)}</div>
    <details style="cursor:pointer">
      <summary style="font-size:11px;color:var(--accent2);user-select:none">View task list ▸</summary>
      <div style="font-size:11px;margin-top:6px;max-height:300px;overflow-y:auto;white-space:pre-wrap;color:var(--muted);font-family:'SF Mono',monospace">${esc(artifacts.tasks)}</div>
    </details>
  </div>`)
  scrollOutput()

  // Launch orchestrator directly — no chat agent intermediary
  _launchOrchestrator(tasksPath, taskCount)
}

async function createNewSpec() {
  const nameInput = document.getElementById('newSpecName')
  const descInput = document.getElementById('specDescription')
  const name = (nameInput?.value || '').trim()
  const description = (descInput?.value || '').trim()
  if (!name) { appendMsg('system', '⚠️ Enter a feature name.'); return }
  if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
  const result = await window.app.specInit(name)
  if (result.error) { appendMsg('system', '❌ ' + result.error); return }
  currentSpecDir = result.specDir
  currentSpecName = result.featureName
  // Save description as metadata
  if (description) {
    await window.app.specSaveArtifact(currentSpecDir, 'requirements', `# ${name}\n\n## Description\n${description}\n`)
  }
  nameInput.value = ''
  descInput.value = ''
  document.getElementById('specCreate').style.display = 'none'
  document.getElementById('specActive').style.display = 'flex'
  document.getElementById('specNameLabel').textContent = name
  await refreshSpecStepper()
  appendMsg('system', `📐 Spec "${name}" created. Generate requirements to get started.`)
}

function closeSpec() {
  currentSpecDir = null
  currentSpecName = null
  document.getElementById('specCreate').style.display = ''
  document.getElementById('specActive').style.display = 'none'
  document.getElementById('specArtifactContent').style.display = 'none'
  document.getElementById('specArtifactEmpty').style.display = ''
  saveWorkflowState() // persist cleared spec state
}

async function refreshSpecStepper() {
  if (!currentSpecDir) return
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (artifacts.error) return
  const config = await window.app.specConfig(currentSpecDir)
  const currentPhase = config.currentPhase || 'requirements'
  const phases = ['requirements', 'design', 'tasks', 'implementation']
  const currentIdx = phases.indexOf(currentPhase)

  for (const phase of phases) {
    const dot = document.getElementById('stepDot-' + phase)
    const status = document.getElementById('stepStatus-' + phase)
    const btn = document.getElementById('genBtn-' + phase)
    const idx = phases.indexOf(phase)
    const hasArtifact = !!artifacts[phase]

    // Reset classes
    dot.className = 'spec-step-dot'
    status.className = 'spec-step-status'

    if (hasArtifact) {
      dot.classList.add('completed')
      status.classList.add('done')
      status.textContent = '✓ Generated'
      if (btn && phase !== 'implementation') { btn.textContent = '👁 View'; btn.disabled = false; btn.onclick = () => viewSpecArtifact(phase) }
    } else if (idx === currentIdx) {
      dot.classList.add('active')
      status.textContent = 'Ready to generate'
      if (btn && phase !== 'implementation') { btn.textContent = '✦ Generate'; btn.disabled = false; btn.onclick = () => generateSpecPhase(phase) }
    } else {
      status.textContent = idx < currentIdx ? 'Skipped' : 'Pending'
      if (btn && phase !== 'implementation') { btn.disabled = idx > currentIdx + 1 }
    }
  }

  // Update connecting lines
  const lines = document.querySelectorAll('.spec-step-line')
  lines.forEach((line, i) => {
    line.className = 'spec-step-line'
    if (artifacts[phases[i]]) line.classList.add('completed')
  })

  // Implementation button
  const implBtn = document.getElementById('genBtn-implementation')
  if (implBtn) {
    const ready = artifacts.requirements && artifacts.design && artifacts.tasks
    implBtn.disabled = !ready
  }
}

async function viewSpecArtifact(phase) {
  if (!currentSpecDir) return
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (artifacts.error || !artifacts[phase]) return
  const labels = { requirements: '📋 Requirements', design: '🏗 Design', tasks: '📝 Tasks' }
  document.getElementById('specArtifactEmpty').style.display = 'none'
  document.getElementById('specArtifactContent').style.display = ''
  document.getElementById('specArtifactHeader').innerHTML = `${labels[phase] || phase} <button class="btn-sm" id="sidebarRegenBtn" style="margin-left:auto;font-size:9px;padding:2px 6px">✦ Regenerate</button>`
  document.getElementById('sidebarRegenBtn').onclick = () => generateSpecPhase(phase)
  document.getElementById('specArtifactBody').innerHTML = renderMd(artifacts[phase])
}

const SPEC_PROMPTS = {
  requirements: (name, desc, ctx) => `You are a senior product manager. Generate a detailed requirements document in markdown for a feature called "${name}".
${desc ? `\nFeature description: ${desc}` : ''}
${ctx ? `\nProject context:\n${ctx}` : ''}

Include:
- Overview and goals
- User stories (as a... I want... so that...)
- Functional requirements (numbered)
- Non-functional requirements (performance, security, accessibility)
- Acceptance criteria
- Out of scope items

IMPORTANT: Output ONLY the markdown document. Do NOT include any thinking process, reasoning steps, or preamble. Start directly with the markdown content.`,

  design: (name, requirements, ctx) => `You are a senior software architect. Generate a technical design document in markdown for a feature called "${name}".

Requirements document:
${requirements}
${ctx ? `\nProject context:\n${ctx}` : ''}

Include:
- Architecture overview
- Component design (with responsibilities)
- Data models / schemas
- API design (endpoints, request/response)
- Error handling strategy
- Testing strategy
- Dependencies and risks

IMPORTANT: Output ONLY the markdown document. Do NOT include any thinking process, reasoning steps, or preamble. Start directly with the markdown content.`,

  tasks: (name, requirements, design) => `You are a senior engineering lead. Generate an implementation task list in markdown for a feature called "${name}".

Requirements:
${requirements}

Design:
${design}

Generate a structured task list using this EXACT format (no other format):
- [ ] 1 Task title
  - [ ] 1.1 Subtask title
  - [ ] 1.2 Subtask title
  - dep: 1.1
- [ ] 2 Next task title
  - dep: 1

RULES:
- Use "- dep: <id>" lines to declare dependencies between tasks (things that must be done first)
- Top-level tasks should depend on the previous top-level task (e.g. task 2 depends on task 1)
- Subtasks within a group can depend on sibling subtasks
- Each task should be small enough to complete in 1-2 hours
- Include: Setup/scaffolding, Core implementation, Tests, Documentation
- Use action verbs that match these categories: "Explore/analyze" for exploration, "Gather context/find related" for context gathering, "Search/find/locate" for code search, "Design/architect/plan" for design, "Write requirements/spec" for requirements, "Implement/build/create/fix/add/refactor" for implementation

OUTPUT ONLY the markdown task list. No thinking, no reasoning, no preamble, no explanation. Start with "- [ ] 1" on the very first line.`,
}

async function generateSpecPhase(phase) {
  if (!currentSpecDir || !loadedModelId || specGenerating) return
  specGenerating = true

  const btn = document.getElementById('genBtn-' + phase)
  const status = document.getElementById('stepStatus-' + phase)
  const dot = document.getElementById('stepDot-' + phase)
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating...'; btn.classList.add('generating') }
  if (status) { status.textContent = 'Generating...'; status.className = 'spec-step-status generating' }
  if (dot) { dot.className = 'spec-step-dot generating' }

  // Show agent stats bar immediately
  const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1)
  updateAgentStatsBar({ state: 'initializing', activity: `Spec: preparing ${phaseLabel}...` })

  // Auto-collapse any previous spec phase blocks
  document.querySelectorAll('.spec-phase-block').forEach(el => {
    el.querySelectorAll('details[open]').forEach(d => d.removeAttribute('open'))
  })

  // Create a live chat message block for streaming output
  const specRespId = 'spec-side-resp-' + Date.now()
  const out = document.getElementById('agentOutput')
  out.insertAdjacentHTML('beforeend', `<div class="msg-block spec-phase-block" id="${specRespId}">
    <div class="msg-system" id="${specRespId}-status">📐 Generating ${phaseLabel} for "${esc(currentSpecName)}"...</div>
    <details class="msg-thinking" id="${specRespId}-think" style="display:none" open>
      <summary>🧠 Thinking</summary>
      <div class="msg-thinking-body" id="${specRespId}-think-body"></div>
    </details>
    <details class="spec-phase-output" open>
      <summary>📄 ${phaseLabel} output</summary>
      <div class="msg-text" id="${specRespId}-text"></div>
    </details>
  </div>`)
  scrollOutput()

  try {
    const artifacts = await window.app.specArtifacts(currentSpecDir)
    let ctx = ''
    if (currentProject) {
      ctx = await window.app.buildContext(currentProject) || ''
    }

    let prompt
    const desc = artifacts.requirements?.match(/## Description\n([\s\S]*?)(?=\n##|\n$|$)/)?.[1]?.trim() || ''
    if (phase === 'requirements') {
      prompt = SPEC_PROMPTS.requirements(currentSpecName, desc, ctx)
    } else if (phase === 'design') {
      prompt = SPEC_PROMPTS.design(currentSpecName, artifacts.requirements || '', ctx)
    } else if (phase === 'tasks') {
      prompt = SPEC_PROMPTS.tasks(currentSpecName, artifacts.requirements || '', artifacts.design || '')
    }

    // Use streaming chat for real-time stats bar + chat output
    const content = await new Promise((resolve, reject) => {
      let accumulated = ''
      let tokenCount = 0
      let inputTokens = 0
      let outputTokens = 0
      let serverTps = null
      let startTime = null

      // Debounced markdown rendering
      let _mdRenderTimer = null
      let _mdDirty = false
      function scheduleRender() {
        _mdDirty = true
        if (_mdRenderTimer) return
        _mdRenderTimer = requestAnimationFrame(() => {
          _mdRenderTimer = null
          if (_mdDirty) {
            _mdDirty = false
            // Show thinking content in the thinking section
            const thinkContent = extractThinking(accumulated)
            if (thinkContent) {
              const thinkEl = document.getElementById(specRespId + '-think')
              if (thinkEl) thinkEl.style.display = ''
              const thinkBody = document.getElementById(specRespId + '-think-body')
              if (thinkBody) thinkBody.textContent = thinkContent + '▌'
            }
            let displayText = accumulated.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
            const openThink = accumulated.lastIndexOf('<think>')
            const closeThink = accumulated.lastIndexOf('</think>')
            if (openThink > closeThink) displayText = accumulated.slice(0, openThink).trim()
            const textEl = document.getElementById(specRespId + '-text')
            if (textEl && displayText) textEl.innerHTML = renderMd(displayText, true) + '<span class="cursor">▌</span>'
            scrollOutput()
          }
        })
      }

      // Simulated prompt-eval progress while waiting for first token
      let promptProgress = 0
      let promptElapsed = 0
      const promptTimer = setInterval(() => {
        promptElapsed += 200
        promptProgress = 90 * (1 - Math.exp(-promptElapsed / 6000))
        updateAgentStatsBar({ state: 'prompt-eval', inputTokens, outputTokens, progress: promptProgress, activity: `Spec ${phaseLabel}: evaluating prompt...` })
      }, 200)

      updateAgentStatsBar({ state: 'prompt-eval', progress: 0, activity: `Spec ${phaseLabel}: evaluating prompt...` })

      window.app.offStream()

      window.app.onStreamChunk((parsed) => {
        if (!startTime) {
          startTime = Date.now()
          clearInterval(promptTimer)
        }
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) {
          accumulated += delta
          tokenCount++
          outputTokens = tokenCount
          const tks = serverTps || _calcTks(tokenCount, startTime)
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks, activity: `Spec ${phaseLabel}: generating...` })
          scheduleRender()
        }
      })

      window.app.onStreamStats((stats) => {
        inputTokens = stats.prompt_tokens || inputTokens
        outputTokens = stats.completion_tokens || outputTokens || tokenCount
        if (stats.generation_tps) serverTps = stats.generation_tps
        const promptTps = stats.prompt_tps || null
        const peakMemory = stats.peak_memory_gb || null
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks: serverTps, promptTps, peakMemory, activity: `Spec ${phaseLabel}: generating...` })
      })

      window.app.onStreamDone(() => {
        clearInterval(promptTimer)
        window.app.offStream()
        resolve(accumulated)
      })

      window.app.onStreamError((err) => {
        clearInterval(promptTimer)
        window.app.offStream()
        reject(new Error(err))
      })

      window.app.chatStream({
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
      })
    })

    // Finalize the chat block
    const statusEl = document.getElementById(specRespId + '-status')
    const textEl = document.getElementById(specRespId + '-text')

    // Finalize thinking section — remove trailing cursor
    const thinkBody = document.getElementById(specRespId + '-think-body')
    if (thinkBody && thinkBody.textContent.endsWith('▌')) {
      thinkBody.textContent = thinkBody.textContent.slice(0, -1)
    }

    if (!content) {
      if (statusEl) statusEl.textContent = `❌ Spec ${phaseLabel} generation failed: empty response`
      updateAgentStatsBar({ state: 'done', activity: 'Spec generation failed' })
    } else {
      // Strip thinking tags if present
      let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      // Strip plain-text thinking preamble before first markdown heading
      if (!/^#/m.test(cleaned.split('\n')[0]) && /^#/m.test(cleaned)) {
        cleaned = cleaned.slice(cleaned.search(/^#/m)).trim()
      }

      // Update chat block with final rendered content
      if (statusEl) statusEl.textContent = `✅ ${phaseLabel} generated for "${currentSpecName}"`
      if (textEl) textEl.innerHTML = renderMd(cleaned)

      await window.app.specSaveArtifact(currentSpecDir, phase, cleaned)
      // Advance phase
      await window.app.specAdvance(currentSpecDir)
      updateAgentStatsBar({ state: 'done', activity: `Spec ${phaseLabel}: complete` })
      viewSpecArtifact(phase)
    }
  } catch (e) {
    const statusEl = document.getElementById(specRespId + '-status')
    if (statusEl) statusEl.textContent = `❌ Error: ${e.message}`
    updateAgentStatsBar({ state: 'done', activity: 'Spec generation failed' })
  }

  if (btn) { btn.classList.remove('generating') }
  specGenerating = false
  await refreshSpecStepper()
}

async function startSpecImplementation() {
  if (!currentSpecDir || !currentProject) return
  if (isGenerating) return
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (!artifacts.tasks) { appendMsg('system', '⚠️ Generate tasks first.'); return }

  // Switch to agent tab
  switchMainTab('agent', document.querySelector('[data-tab="agent"]'))

  // Load task graph into sidebar
  const tasksPath = currentProject + '/.maccoder/specs/' + currentSpecName + '/tasks.md'
  try {
    await loadTaskGraph(tasksPath)
    renderSpecTaskProgress()
  } catch (e) { /* best-effort */ }

  // Show spec panel with task progress visible
  showPanel('tasks', document.querySelector('[data-panel="tasks"]'))

  // Count tasks for the summary
  const taskLines = artifacts.tasks.split('\n').filter(l => /^- \[[ x]\]/.test(l.trim()))
  const taskCount = taskLines.length

  // Show a clean formatted card in chat
  appendMsg('system', `📐 Starting implementation for "${currentSpecName}"...`)
  const out = document.getElementById('agentOutput')
  out.insertAdjacentHTML('beforeend', `<div class="msg-user">
    <div class="msg-user-label">Spec Implementation</div>
    <div style="margin:6px 0 4px;font-weight:600">📐 ${esc(currentSpecName)}</div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:6px">${taskCount} tasks · ${esc(currentProject)}</div>
    <details style="cursor:pointer">
      <summary style="font-size:11px;color:var(--accent2);user-select:none">View task list ▸</summary>
      <div style="font-size:11px;margin-top:6px;max-height:300px;overflow-y:auto;white-space:pre-wrap;color:var(--muted);font-family:'SF Mono',monospace">${esc(artifacts.tasks)}</div>
    </details>
  </div>`)
  scrollOutput()

  // Launch orchestrator directly — no chat agent intermediary
  _launchOrchestrator(tasksPath, taskCount)
}

async function loadSpecPanel() {
  if (!currentProject) return
  if (currentSpecDir) {
    document.getElementById('specCreate').style.display = 'none'
    document.getElementById('specActive').style.display = 'flex'
    document.getElementById('specNameLabel').textContent = currentSpecName || 'Spec'
    await refreshSpecStepper()
    // Load the task graph if this spec has tasks
    const specTasksPath = currentSpecDir + '/tasks.md'
    if (!currentTaskGraph || currentTasksPath !== specTasksPath) {
      try { await loadTaskGraph(specTasksPath) } catch (_) { /* tasks may not exist yet */ }
    }
  }
}

// 10.2 — /spec command handler (updated)
async function handleSpecCommand(args) {
  if (args) {
    if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
    const result = await window.app.specInit(args)
    if (result.error) { appendMsg('system', '❌ ' + result.error); return }
    currentSpecDir = result.specDir
    currentSpecName = result.featureName
    showInlineSpecWorkflow()
    appendMsg('system', `📐 Spec "${esc(args)}" initialized.`)
  } else {
    if (!currentSpecDir) { appendMsg('system', 'ℹ️ No spec active. Use /spec <name> to start one.'); return }
    showInlineSpecWorkflow()
    const phase = await window.app.specPhase(currentSpecDir)
    if (phase.error) { appendMsg('system', '❌ ' + phase.error); return }
    appendMsg('system', `📐 Current spec: "${currentSpecName}" — phase: ${phase}`)
  }
}

// ── search engine status ──────────────────────────────────────────────────────
async function checkSearchEngine() {
  if (!window.app.astSearchStatus) return
  const status = await window.app.astSearchStatus()
  if (status.error) return
  const el = document.getElementById('searchEngineStatus')
  const hint = document.getElementById('searchInstallHint')
  if (!el) return
  const label = status.backend === 'ast-grep'
    ? `🔍 ast-grep ${status.version || ''}${status.bundled ? ' (bundled)' : ''}`
    : status.backend === 'ripgrep' ? `🔍 ripgrep ${status.version || ''}`
    : '🔍 built-in (basic)'
  el.textContent = label
  el.style.color = status.backend === 'ast-grep' ? 'var(--green)' : status.backend === 'ripgrep' ? 'var(--yellow)' : 'var(--muted)'
  if (hint) hint.style.display = status.backend !== 'ast-grep' ? 'flex' : 'none'
}

// Hook into panel switching to load data
const _origShowPanel = typeof showPanel === 'function' ? showPanel : null
window._showPanelOrig = _origShowPanel


// ── slash command system ──────────────────────────────────────────────────────

// 10.1.1 — parseSlashCommand(input): returns { command, args } or null
function parseSlashCommand(input) {
  if (!input || !input.startsWith('/')) return null
  const trimmed = input.slice(1).trim()
  if (!trimmed) return null
  const spaceIdx = trimmed.indexOf(' ')
  if (spaceIdx === -1) return { command: trimmed.toLowerCase(), args: '' }
  return { command: trimmed.slice(0, spaceIdx).toLowerCase(), args: trimmed.slice(spaceIdx + 1).trim() }
}

// 10.1.2 — SLASH_COMMANDS Map with registered command handlers
const SLASH_COMMANDS = new Map([
  ['spec',   handleSpecCommand],
  ['search', handleSearchCommand],
  ['tasks',  handleTasksCommand],
  ['help',   handleHelpCommand],
])

// Command descriptions for help and autocomplete
const SLASH_COMMAND_INFO = [
  { command: 'spec',   description: 'Manage spec workflows — /spec <name> or /spec' },
  { command: 'search', description: 'AST code search — /search <pattern>' },
  { command: 'tasks',  description: 'Task graph control — /tasks [run|pause|resume]' },
  { command: 'help',   description: 'Show all available commands' },
]

// /spec handler is defined above in the spec workflow section

// 10.3 — /search command handler
async function handleSearchCommand(args) {
  if (!args) { appendMsg('system', '⚠️ Usage: /search <pattern>'); return }
  if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
  appendMsg('system', `🔍 Searching for: ${esc(args)}...`)
  try {
    const results = await window.app.astSearch({ pattern: args }, currentProject)
    if (results.error) { appendMsg('system', '❌ ' + results.error); return }
    if (!results.length) { appendMsg('system', 'ℹ️ No matches found.'); return }
    // 10.3.1 & 10.3.2 — render results inline with clickable file links
    const out = document.getElementById('agentOutput')
    const html = results.slice(0, 20).map(r =>
      `<div class="search-result-item" onclick="openFile('${r.file.replace(/'/g, "\\'")}','${r.file.split('/').pop()}')" style="cursor:pointer">
        <span class="search-result-file">${esc(r.file)}</span>
        <span class="search-result-lines">:${r.startLine}–${r.endLine}</span>
        <pre class="search-result-snippet">${esc(r.snippet || '')}</pre>
      </div>`
    ).join('')
    out.insertAdjacentHTML('beforeend',
      `<div class="msg-system">🔍 ${results.length} result${results.length !== 1 ? 's' : ''} for "${esc(args)}"</div>
       <div class="search-results-block">${html}</div>`)
    scrollOutput()
  } catch (e) {
    appendMsg('system', '❌ Search error: ' + e.message)
  }
}

// 10.4 — /tasks command handler
async function handleTasksCommand(args) {
  const sub = args.toLowerCase()
  if (sub === 'run') {
    // 10.4.2 — /tasks run
    await taskGraphRun()
    appendMsg('system', '▶ Task graph execution started.')
  } else if (sub === 'pause') {
    // 10.4.3 — /tasks pause
    await taskGraphPause()
    appendMsg('system', '⏸ Task graph paused.')
  } else if (sub === 'resume') {
    // 10.4.3 — /tasks resume
    await taskGraphResume()
    appendMsg('system', '▶ Task graph resumed.')
  } else {
    // 10.4.1 — /tasks (no args): switch to tasks panel, show status
    showPanel('tasks', document.querySelector('[data-panel="tasks"]'))
    if (currentTaskGraph && currentTaskGraph.nodes) {
      const nodes = Object.values(currentTaskGraph.nodes)
      const completed = nodes.filter(n => n.status === 'completed').length
      const inProgress = nodes.filter(n => n.status === 'in_progress').length
      const failed = nodes.filter(n => n.status === 'failed').length
      const total = nodes.length
      appendMsg('system', `📋 Task graph: ${total} tasks — ${completed} completed, ${inProgress} in progress, ${failed} failed, ${total - completed - inProgress - failed} remaining`)
    } else {
      appendMsg('system', '📋 No task graph loaded. Open a Tasks.md file.')
    }
  }
}

// 10.6 — /help command handler
function handleHelpCommand() {
  const lines = SLASH_COMMAND_INFO.map(c => `  /${c.command} — ${c.description}`)
  appendMsg('system', `📖 Available commands:\n${lines.join('\n')}`)
}

// ── slash command autocomplete (Task 10.8) ────────────────────────────────────
function initSlashAutocomplete() {
  const input = document.getElementById('agentPrompt')
  const dropdown = document.getElementById('slashAutocomplete')
  if (!input || !dropdown) return

  input.addEventListener('input', () => {
    const val = input.value
    if (val.startsWith('/')) {
      const typed = val.slice(1).toLowerCase()
      const matches = SLASH_COMMAND_INFO.filter(c => c.command.startsWith(typed))
      if (matches.length > 0 && !val.includes(' ')) {
        showSlashAutocomplete(matches)
      } else {
        hideSlashAutocomplete()
      }
    } else {
      hideSlashAutocomplete()
    }
  })

  input.addEventListener('keydown', e => {
    if (!dropdown || dropdown.style.display === 'none') return
    const items = dropdown.querySelectorAll('.slash-ac-item')
    const activeItem = dropdown.querySelector('.slash-ac-item.active')
    let activeIdx = Array.from(items).indexOf(activeItem)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      activeIdx = (activeIdx + 1) % items.length
      items.forEach(i => i.classList.remove('active'))
      items[activeIdx].classList.add('active')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      activeIdx = activeIdx <= 0 ? items.length - 1 : activeIdx - 1
      items.forEach(i => i.classList.remove('active'))
      items[activeIdx].classList.add('active')
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      if (activeItem) {
        e.preventDefault()
        selectSlashCommand(activeItem.dataset.command)
      }
    } else if (e.key === 'Escape') {
      hideSlashAutocomplete()
    }
  })

  // Hide on blur (with slight delay so click events fire)
  input.addEventListener('blur', () => setTimeout(hideSlashAutocomplete, 150))
}

function showSlashAutocomplete(matches) {
  const dropdown = document.getElementById('slashAutocomplete')
  if (!dropdown) return
  dropdown.innerHTML = matches.map((c, i) =>
    `<div class="slash-ac-item${i === 0 ? ' active' : ''}" data-command="${c.command}" onclick="selectSlashCommand('${c.command}')">
      <span class="slash-ac-cmd">/${c.command}</span>
      <span class="slash-ac-desc">${c.description}</span>
    </div>`
  ).join('')
  dropdown.style.display = 'block'
}

function hideSlashAutocomplete() {
  const dropdown = document.getElementById('slashAutocomplete')
  if (dropdown) dropdown.style.display = 'none'
}

function selectSlashCommand(command) {
  const input = document.getElementById('agentPrompt')
  if (!input) return
  input.value = '/' + command + ' '
  input.focus()
  hideSlashAutocomplete()
}

// Initialize autocomplete on DOM ready
document.addEventListener('DOMContentLoaded', initSlashAutocomplete)

// ── helper: calculate tokens per second ────────────────────────────────────────
function _calcTks(tokens, startTime) {
  if (!startTime) return '—'
  const elapsed = (Date.now() - startTime) / 1000
  return elapsed > 0 ? (tokens / elapsed).toFixed(1) : '—'
}

// ── unified agent stats bar (above text input) ───────────────────────────────
let _agentStartTimestamp = null // tracks when the current agent run started

function updateAgentStatsBar(opts = {}) {
  const bar = document.getElementById('agentStats')
  if (!bar) return

  const { state, inputTokens, outputTokens, tks, promptTps, peakMemory, toolName, progress, activity, toolCount, agentType } = opts

  // Always show the stats bar when agent is active
  if (state === 'idle' && !inputTokens && !outputTokens) {
    bar.style.display = 'none'
    _agentStartTimestamp = null
    return
  }
  bar.style.display = 'flex'

  // Track when agent started
  if (state === 'initializing') _agentStartTimestamp = Date.now()

  // State indicator chip
  const stateMap = {
    initializing: { icon: '⚡', text: 'Initializing', cls: '' },
    'prompt-eval':{ icon: '📊', text: 'Processing prompt', cls: 'thinking' },
    thinking:     { icon: '🧠', text: 'Thinking', cls: 'thinking' },
    generating:   { icon: '✍️', text: 'Generating', cls: 'generating' },
    processing:   { icon: '⚙️', text: 'Processing', cls: 'processing' },
    tool:         { icon: '🔧', text: toolName || 'Tool', cls: 'tool' },
    done:         { icon: '✅', text: 'Done', cls: 'done' },
  }
  const s = stateMap[state] || stateMap.done

  let html = ''

  // Model chip (always show when active)
  const modelName = loadedModelId ? _formatModelName(loadedModelId) : null
  if (modelName) {
    html += `<div class="stat-chip model-chip"><span class="stat-label">Model</span><span class="stat-val">${modelName}</span></div>`
  }

  html += `<div class="stat-chip state-chip ${s.cls}"><span class="stat-label">Status</span><span class="stat-val">${s.icon} ${s.text}</span></div>`

  // Sub-agent chip (shown when an agent type is active)
  const effectiveAgentType = agentType || _currentAgentType
  if (effectiveAgentType && effectiveAgentType !== 'general' && state !== 'done') {
    html += `<div class="stat-chip agent-type-chip"><span class="stat-label">Agent</span><span class="stat-val">🤖 ${effectiveAgentType}</span></div>`
  }

  // Progress chip (shown during prompt eval or when progress is provided)
  if (progress != null) {
    const pct = progress < 0 ? '...' : Math.round(progress) + '%'
    const fillClass = progress < 0 ? 'indeterminate' : ''
    const fillWidth = progress < 0 ? '' : `width:${Math.min(100, progress)}%`
    html += `<div class="stat-chip progress-chip"><span class="stat-label">Prompt</span><span class="stat-val">${pct}</span><div class="progress-mini"><div class="progress-mini-fill ${fillClass}" style="${fillWidth}"></div></div></div>`
  }

  // Input tokens
  html += `<div class="stat-chip"><span class="stat-label">Input</span><span class="stat-val">${inputTokens || 0} tok${promptTps != null ? ' · ' + promptTps + ' tk/s' : ''}</span></div>`

  // Output tokens
  const tksDisplay = tks != null && tks !== '—' ? ' · ' + tks + ' tk/s' : ''
  html += `<div class="stat-chip accent"><span class="stat-label">Output</span><span class="stat-val">${outputTokens || 0} tok${tksDisplay}</span></div>`

  // ── Total Context chip with usage bar ──────────────────────────────────────
  const totalTokens = (inputTokens || 0) + (outputTokens || 0)
  if (totalTokens > 0) {
    // Determine context window from calibration profile or fallback to 84K default
    const ctxWindow = (_calibrationProfile && _calibrationProfile.metrics && _calibrationProfile.metrics.context_window)
      ? _calibrationProfile.metrics.context_window
      : 84000
    const ctxPct = Math.min(100, Math.round((totalTokens / ctxWindow) * 100))
    const ctxCls = ctxPct >= 85 ? 'ctx-danger' : ctxPct >= 60 ? 'ctx-warn' : 'ctx-ok'
    const ctxTooltip = `${totalTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens (${ctxPct}% used)`
    html += `<div class="stat-chip context-chip ${ctxCls}" title="${ctxTooltip}"><span class="stat-label">Context</span><span class="stat-val">${_formatTokenCount(totalTokens)} / ${_formatTokenCount(ctxWindow)}</span><div class="progress-mini"><div class="progress-mini-fill" style="width:${ctxPct}%"></div></div></div>`
  }

  // Tool count if available
  if (toolCount != null && toolCount > 0) {
    html += `<div class="stat-chip"><span class="stat-label">Tools</span><span class="stat-val">🔧 ${toolCount}</span></div>`
  }

  // Peak memory if available
  if (peakMemory != null) {
    html += `<div class="stat-chip"><span class="stat-label">Peak VRAM</span><span class="stat-val">${peakMemory} GB</span></div>`
  }

  // Elapsed time chip
  if (_agentStartTimestamp) {
    const elapsed = Date.now() - _agentStartTimestamp
    html += `<div class="stat-chip"><span class="stat-label">Elapsed</span><span class="stat-val">${_formatElapsed(elapsed)}</span></div>`
  }

  // Compaction stats chip
  if (_lastCompactionStats && _lastCompactionStats.reduction_pct) {
    const pct = Math.round(_lastCompactionStats.reduction_pct)
    const engine = _lastCompactionStats.engine || 'builtin'
    const engineCls = engine === 'python' ? 'compaction-python' : 'compaction-builtin'
    const engineIcon = engine === 'python' ? '🐍' : '⚡'
    const origTok = _lastCompactionStats.original_tokens || '?'
    const compTok = _lastCompactionStats.compressed_tokens || '?'
    const stages = (_lastCompactionStats.stages_applied && _lastCompactionStats.stages_applied.length) ? _lastCompactionStats.stages_applied.join(', ') : 'N/A'
    const tooltip = `Original: ${origTok} tokens\nCompressed: ${compTok} tokens\nReduction: ${pct}%\nEngine: ${engine}\nStages: ${stages}`
    html += `<div class="stat-chip ${engineCls}" title="${tooltip}"><span class="stat-label">Compaction</span><span class="stat-val">${engineIcon} ${pct}% ↓</span></div>`
  }

  // Activity log (right-aligned)
  if (activity) {
    html += `<div class="agent-activity-log"><span class="activity-step active">${activity}</span></div>`
  }

  bar.innerHTML = html
}

// Format token count for compact display (e.g. 84000 → "84K")
function _formatTokenCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K'
  return String(n)
}

// Format elapsed milliseconds as human-readable duration
function _formatElapsed(ms) {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return secs + 's'
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  if (mins < 60) return mins + 'm ' + (remSecs > 0 ? remSecs + 's' : '')
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return hrs + 'h ' + remMins + 'm'
}

// ── persistent bottom status bar — REMOVED ───────────────────────────────────
// All status info is now in the unified chip bar (updateAgentStatsBar).
// This is a no-op stub so existing calls don't break.
function updateStatusBar() {}

// (status bar init removed — all status in chip bar now)

// ── LSP status indicator ──────────────────────────────────────────────────────

function setLspStatus({ status, servers = [], errorMessage = null }) {
  const chip = document.getElementById('lspChip')
  const dot  = document.getElementById('lspDot')
  const txt  = document.getElementById('lspText')
  if (!chip) return

  currentLspStatus = status

  // Always show the chip — gray when stopped/unavailable
  chip.style.display = 'inline-flex'

  const colors = {
    ready:    'var(--green)',
    starting: '#f5a623',
    degraded: '#f5a623',
    error:    'var(--red)',
    stopped:  'var(--muted)',
  }
  dot.style.background = colors[status] || 'var(--muted)'

  const tooltips = {
    ready:    `LSP ready — ${servers.map(s => s.name).join(', ') || 'no language servers'}`,
    starting: 'LSP starting...',
    degraded: 'LSP degraded — no language servers found on PATH',
    error:    `LSP error — ${errorMessage || 'check logs'}`,
    stopped:  'LSP not available — install agent-lsp binary',
  }
  chip.title = tooltips[status] || 'LSP unknown'

  // Show/hide symbol panel based on LSP status
  const symbolPanel = document.getElementById('symbolPanel')
  if (symbolPanel) {
    symbolPanel.style.display = status === 'ready' ? 'flex' : 'none'
  }
  // If LSP just became ready and we have a file open, fetch symbols
  if (status === 'ready' && currentFile) {
    fetchAndRenderSymbols(currentFile)
  }
}

async function initLspStatus() {
  if (!window.app.lspStatus) return // IPC not wired yet
  try {
    const s = await window.app.lspStatus()
    setLspStatus(s)
  } catch { /* ignore */ }

  window.app.onLspStatusChange(({ oldStatus, newStatus }) => {
    // Re-fetch full status to get server list
    window.app.lspStatus().then(setLspStatus).catch(() => {})
  })

  // Listen for push diagnostics from the LSP server
  if (window.app.onLspDiagnostics) {
    window.app.onLspDiagnostics(({ path: filePath, diagnostics }) => {
      const errors = diagnostics.filter(d => d.severity === 'error' || d.severity === 1)
      const warnings = diagnostics.filter(d => d.severity === 'warning' || d.severity === 2)
      const statusLine = document.getElementById('statusLine')
      const lspDot = document.getElementById('lspDot')

      // Flash the LSP chip on diagnostic updates
      if (lspDot && (errors.length > 0 || warnings.length > 0)) {
        lspDot.style.background = errors.length > 0 ? 'var(--red)' : '#f5a623'
        lspDot.style.boxShadow = `0 0 6px ${errors.length > 0 ? 'var(--red)' : '#f5a623'}`
        setTimeout(() => {
          const colors = { ready: 'var(--green)', starting: '#f5a623', degraded: '#f5a623', error: 'var(--red)', stopped: 'var(--muted)' }
          lspDot.style.background = colors[currentLspStatus] || 'var(--muted)'
          lspDot.style.boxShadow = ''
        }, 2000)
      }

      // Update status line with diagnostic info
      if (statusLine && filePath) {
        const shortPath = filePath.split('/').slice(-2).join('/')
        if (errors.length > 0) {
          statusLine.textContent = `⚠️ LSP: ${shortPath} — ${errors.length} error${errors.length > 1 ? 's' : ''}${warnings.length > 0 ? `, ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''}`
        } else if (warnings.length > 0) {
          statusLine.textContent = `⚡ LSP: ${shortPath} — ${warnings.length} warning${warnings.length > 1 ? 's' : ''}`
        }
      }

      // Store diagnostics for popover display
      if (!window._lspDiagnosticsMap) window._lspDiagnosticsMap = new Map()
      if (errors.length > 0 || warnings.length > 0) {
        window._lspDiagnosticsMap.set(filePath, { errors, warnings })
      } else {
        window._lspDiagnosticsMap.delete(filePath)
      }
    })
  }

  // Wire click handler for LSP status popover
  const chip = document.getElementById('lspChip')
  if (chip) chip.addEventListener('click', toggleLspPopover)
}

// ── LSP status popover ────────────────────────────────────────────────────────

let _lspPopoverOpen = false

async function toggleLspPopover() {
  const chip = document.getElementById('lspChip')
  if (!chip) return

  // Close if already open
  const existing = document.querySelector('.lsp-popover')
  if (existing) {
    existing.remove()
    _lspPopoverOpen = false
    return
  }

  // Fetch current status
  let data = { status: currentLspStatus, servers: [] }
  try {
    if (window.app.lspStatus) data = await window.app.lspStatus()
  } catch { /* use defaults */ }

  // Build popover content
  const pop = document.createElement('div')
  pop.className = 'lsp-popover'

  const statusLabel = {
    ready: '🟢 Ready', starting: '🟡 Starting', degraded: '🟡 Degraded',
    error: '🔴 Error', stopped: '⚪ Stopped',
  }
  pop.innerHTML = `<div class="lsp-popover-header">LSP — ${statusLabel[data.status] || data.status}</div>`

  if (data.servers && data.servers.length > 0) {
    for (const srv of data.servers) {
      const langs = (srv.languages || []).join(', ') || 'unknown'
      pop.innerHTML += `<div class="lsp-popover-item"><div><div class="lsp-popover-name">${esc(srv.name)}</div><div class="lsp-popover-langs">${esc(langs)}</div></div></div>`
    }
  } else if (data.status === 'error' && data.errorMessage) {
    pop.innerHTML += `<div class="lsp-popover-empty" style="color:var(--red)">Error: ${esc(data.errorMessage)}</div>`
  } else {
    pop.innerHTML += '<div class="lsp-popover-empty">No language servers active</div>'
  }

  // Show active diagnostics in the popover
  if (window._lspDiagnosticsMap && window._lspDiagnosticsMap.size > 0) {
    pop.innerHTML += '<div class="lsp-popover-header" style="margin-top:4px">Diagnostics</div>'
    for (const [fp, { errors, warnings }] of window._lspDiagnosticsMap) {
      const shortPath = fp.split('/').slice(-2).join('/')
      const counts = []
      if (errors.length > 0) counts.push(`${errors.length} error${errors.length > 1 ? 's' : ''}`)
      if (warnings.length > 0) counts.push(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`)
      pop.innerHTML += `<div class="lsp-popover-item"><div><div class="lsp-popover-name" style="color:${errors.length > 0 ? 'var(--red)' : '#f5a623'}">${esc(shortPath)}</div><div class="lsp-popover-langs">${esc(counts.join(', '))}</div></div></div>`
    }
  }

  document.body.appendChild(pop)
  // Position fixed relative to the chip
  const rect = chip.getBoundingClientRect()
  pop.style.top = (rect.bottom + 6) + 'px'
  pop.style.right = (window.innerWidth - rect.right) + 'px'
  _lspPopoverOpen = true

  // Close on outside click (delayed so the current click doesn't immediately close it)
  setTimeout(() => {
    const onOutside = (e) => {
      if (!pop.contains(e.target) && !chip.contains(e.target)) {
        pop.remove()
        _lspPopoverOpen = false
        document.removeEventListener('click', onOutside)
      }
    }
    document.addEventListener('click', onOutside)
  }, 0)
}

// ── Calibration status chip ────────────────────────────────────────────────────

let _calibrationProfile = null
let _calPopoverOpen = false

function setCalibrationStatus(status, profile) {
  const chip = document.getElementById('calChip')
  const dot  = document.getElementById('calDot')
  const txt  = document.getElementById('calText')
  if (!chip) return

  chip.style.display = 'inline-flex'

  const colors = {
    calibrating:  '#f5a623',
    ready:        'var(--green)',
    unavailable:  'var(--muted)',
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

  let html = '<div class="cal-popover-header">Calibration Profile</div>'
  const rows = [
    ['Gen TPS',       m.generation_tps != null ? m.generation_tps + ' tk/s' : '—'],
    ['Prompt TPS',    m.prompt_tps != null ? m.prompt_tps + ' tk/s' : '—'],
    ['Max Turns',     p.maxTurns],
    ['Timeout/Turn',  (p.timeoutPerTurn / 1000).toFixed(0) + 's'],
    ['Max Input',     p.maxInputTokens != null ? p.maxInputTokens.toLocaleString() + ' tok' : '—'],
    ['Compaction @',  p.compactionThreshold != null ? p.compactionThreshold.toLocaleString() + ' tok' : '—'],
  ]
  for (const [label, value] of rows) {
    html += `<div class="cal-popover-row"><span class="cal-popover-label">${label}</span><span class="cal-popover-value">${value}</span></div>`
  }
  pop.innerHTML = html

  const rect = chip.getBoundingClientRect()
  pop.style.top = (rect.bottom + 4) + 'px'
  pop.style.right = (window.innerWidth - rect.right) + 'px'
  document.body.appendChild(pop)

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

async function initCalibrationStatus() {
  if (!window.app || !window.app.calibrationStatus) return

  try {
    const s = await window.app.calibrationStatus()
    setCalibrationStatus(s.status, s.profile)
    if (s.profile) renderCalibrationDashboard(s.profile)
  } catch { /* ignore */ }

  if (window.app.onCalibrationComplete) {
    window.app.onCalibrationComplete(({ modelId, profile, fallback }) => {
      setCalibrationStatus('ready', profile)
      renderCalibrationDashboard(profile)
    })
  }

  if (window.app.onCalibrationStatus) {
    window.app.onCalibrationStatus(({ status }) => {
      setCalibrationStatus(status, null)
    })
  }

  const chip = document.getElementById('calChip')
  if (chip) chip.addEventListener('click', toggleCalPopover)
}

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

function clearCalibrationUI() {
  setCalibrationStatus('unavailable', null)
  renderCalibrationDashboard(null)
}

// ── Symbol panel ──────────────────────────────────────────────────────────────

const SYMBOL_KIND_ICONS = {
  function: 'ƒ', class: 'C', variable: 'v', method: 'm',
  property: 'p', interface: 'I', enum: 'E', constant: 'K',
}

function symbolKindIcon(kind) {
  const k = (kind || '').toLowerCase()
  return SYMBOL_KIND_ICONS[k] || '•'
}

async function fetchAndRenderSymbols(filePath) {
  const list = document.getElementById('symbolList')
  if (!list) return
  if (!window.app.lspSymbols) { list.innerHTML = ''; return }
  try {
    const result = await window.app.lspSymbols(filePath)
    const symbols = result?.symbols || result || []
    if (!Array.isArray(symbols) || symbols.length === 0) {
      list.innerHTML = '<div class="symbol-empty">No symbols</div>'
      return
    }
    list.innerHTML = renderSymbolTree(symbols)
  } catch {
    list.innerHTML = '<div class="symbol-empty">Failed to load symbols</div>'
  }
}

function renderSymbolTree(symbols) {
  if (!symbols || !symbols.length) return ''
  return '<ul class="symbol-ul">' + symbols.map(s => {
    const icon = symbolKindIcon(s.kind)
    const line = s.line != null ? s.line : (s.range?.start?.line != null ? s.range.start.line : '')
    const lineDisplay = line !== '' ? line + 1 : '' // 0-indexed to 1-indexed
    const children = s.children?.length ? renderSymbolTree(s.children) : ''
    return `<li class="symbol-item" data-line="${line}">
      <div class="symbol-row" onclick="scrollEditorToLine(${line})">
        <span class="symbol-kind symbol-kind-${icon}">${icon}</span>
        <span class="symbol-name">${esc(s.name)}</span>
        ${lineDisplay ? `<span class="symbol-line">:${lineDisplay}</span>` : ''}
      </div>${children}</li>`
  }).join('') + '</ul>'
}

function scrollEditorToLine(line) {
  if (line == null || line === '') return
  const editor = document.getElementById('editorArea')
  if (!editor) return
  // Switch to editor tab if not already there
  const edTab = document.querySelector('[data-tab="editor"]')
  if (edTab && !edTab.classList.contains('active')) {
    switchMainTab('editor', edTab)
  }
  const text = editor.value
  const lines = text.split('\n')
  // Calculate character offset for the target line
  let charOffset = 0
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    charOffset += lines[i].length + 1
  }
  editor.focus()
  editor.setSelectionRange(charOffset, charOffset)
  // Scroll the textarea so the line is visible
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 19.2
  const targetScroll = Math.max(0, line * lineHeight - editor.clientHeight / 3)
  editor.scrollTop = targetScroll
}

// ── Tools panel ───────────────────────────────────────────────────────────────

const AVAILABLE_TOOLS = [
  // File tools
  { name: 'read_file', icon: '📄', category: 'file', desc: 'Read the contents of a file. Returns the full text content.' },
  { name: 'write_file', icon: '✏️', category: 'file', desc: 'Create or overwrite a file. Creates parent directories as needed.' },
  { name: 'edit_file', icon: '🔧', category: 'file', desc: 'Surgical find-and-replace edit. Matches an exact string and replaces it.' },
  { name: 'list_dir', icon: '📂', category: 'file', desc: 'List files and directories. Shows entries with / suffix for folders.' },
  { name: 'search_files', icon: '🔍', category: 'search', desc: 'Grep for a regex pattern across files. Returns matching lines with paths and line numbers.' },
  // Shell
  { name: 'bash', icon: '⚡', category: 'shell', desc: 'Execute a shell command and return output. Used for tests, installs, git, and more.' },
  // Browser tools
  { name: 'browser_navigate', icon: '🌐', category: 'browser', desc: 'Navigate to a URL. Returns the page title and visible text content.' },
  { name: 'browser_screenshot', icon: '📸', category: 'browser', desc: 'Capture a screenshot of the page or a specific element as PNG.' },
  { name: 'browser_click', icon: '👆', category: 'browser', desc: 'Click an element on the page by CSS selector.' },
  { name: 'browser_type', icon: '⌨️', category: 'browser', desc: 'Type text into an input field. Can clear first or append.' },
  { name: 'browser_get_text', icon: '📝', category: 'browser', desc: 'Extract visible text from the full page or a specific element.' },
  { name: 'browser_get_html', icon: '🏷️', category: 'browser', desc: 'Get the HTML source of the page or a specific element.' },
  { name: 'browser_evaluate', icon: '🧪', category: 'browser', desc: 'Execute JavaScript in the browser page context and return the result.' },
  { name: 'browser_wait_for', icon: '⏳', category: 'browser', desc: 'Wait for an element to appear or for navigation to complete.' },
  { name: 'browser_select_option', icon: '☑️', category: 'browser', desc: 'Select an option from a dropdown element.' },
  { name: 'browser_close', icon: '🚪', category: 'browser', desc: 'Close the browser and free resources.' },
]

function renderToolsPanel() {
  const grid = document.getElementById('toolsGrid')
  if (!grid) return

  const groups = { file: [], shell: [], search: [], browser: [] }
  for (const t of AVAILABLE_TOOLS) {
    (groups[t.category] || []).push(t)
  }

  const labels = { file: 'File System', shell: 'Shell', search: 'Search', browser: 'Browser Automation (Playwright)' }
  let html = ''

  for (const [cat, tools] of Object.entries(groups)) {
    if (tools.length === 0) continue
    html += `<div class="tools-section-label" style="grid-column:1/-1">${labels[cat] || cat}</div>`
    for (const t of tools) {
      html += `<div class="tool-card">
        <div class="tool-card-header">
          <span class="tool-card-icon">${t.icon}</span>
          <span class="tool-card-name">${t.name}</span>
          <span class="tool-card-badge ${t.category}">${t.category}</span>
        </div>
        <div class="tool-card-desc">${t.desc}</div>
      </div>`
    }
  }

  grid.innerHTML = html
}

// Render on load
document.addEventListener('DOMContentLoaded', () => { renderToolsPanel() })

// ── Steering docs ─────────────────────────────────────────────────────────────

async function refreshSteeringDocs() {
  const statusEl = document.getElementById('steeringStatus')
  const listEl = document.getElementById('steeringDocList')
  if (!listEl) return

  if (!currentProject) {
    if (statusEl) statusEl.textContent = 'No project open'
    listEl.innerHTML = '<div class="model-empty" style="font-size:10px">Open a project first</div>'
    return
  }

  try {
    const result = await window.app.steeringList()
    const docs = result.docs || []

    if (statusEl) {
      statusEl.textContent = docs.length > 0 ? `${docs.length} doc${docs.length > 1 ? 's' : ''} loaded` : 'No docs'
      statusEl.style.color = docs.length > 0 ? 'var(--green)' : 'var(--muted)'
    }

    if (docs.length === 0) {
      listEl.innerHTML = '<div class="model-empty" style="font-size:10px">No steering docs found. Create one to customize agent behavior.</div>'
      return
    }

    let html = ''
    for (const doc of docs) {
      const badge = doc.autoGenerated ? '<span style="font-size:9px;color:var(--muted);margin-left:4px">auto</span>' : ''
      html += `<div class="steering-doc-item" style="padding:4px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:11px;font-weight:500;color:var(--text)">${esc(doc.name)}${badge}</div>
        ${doc.description ? `<div style="font-size:10px;color:var(--muted)">${esc(doc.description)}</div>` : ''}
      </div>`
    }
    listEl.innerHTML = html
  } catch (err) {
    if (statusEl) { statusEl.textContent = 'Error'; statusEl.style.color = 'var(--red)' }
    listEl.innerHTML = `<div class="model-empty" style="font-size:10px;color:var(--red)">Failed to load: ${esc(err.message)}</div>`
  }
}

async function createSteeringDoc() {
  if (!currentProject) {
    appendMsg('system', '📁 Open a project first to create steering docs.')
    return
  }

  const name = prompt('Steering doc name (e.g. "coding-standards"):')
  if (!name) return

  const description = prompt('Short description (optional):') || ''

  try {
    const result = await window.app.steeringCreate({
      name,
      description,
      body: `# ${name}\n\nAdd your project-specific instructions here. The agent will include this context in every conversation.\n`,
    })
    if (result.error) {
      appendMsg('system', `⚠️ Failed to create steering doc: ${result.error}`)
    } else {
      appendMsg('system', `📝 Created steering doc: ${name}`)
      refreshSteeringDocs()
      // Open the file in the editor if possible
      if (result.path && window.app.readFile) {
        const content = await window.app.readFile(result.path)
        if (content !== null) {
          document.getElementById('editorArea').value = content
          document.getElementById('editorFileName').textContent = result.path.split('/').pop()
          document.getElementById('saveBtn').style.display = ''
        }
      }
    }
  } catch (err) {
    appendMsg('system', `⚠️ Error creating steering doc: ${err.message}`)
  }
}

// Refresh steering docs when project changes
const _origSwitchProject = typeof switchProject === 'function' ? switchProject : null

// ── Extraction Model UI ───────────────────────────────────────────────────────

let _extractionModelStatus = null  // { loaded: bool, modelName: string|null, memoryGb: number|null }
let _extractionModelList = []      // Available models for extraction

/**
 * Refresh extraction model status from the memory backend.
 */
async function refreshExtractionModelStatus() {
  try {
    const status = await window.app.getMemoryStatus()
    if (status && status.extractionModel) {
      _extractionModelStatus = {
        loaded: true,
        modelName: status.extractionModel,
        memoryGb: status.extractionModelMemoryGb || null,
      }
    } else {
      _extractionModelStatus = { loaded: false, modelName: null, memoryGb: null }
    }
    _renderExtractionModelSection()
  } catch (_) {
    _extractionModelStatus = { loaded: false, modelName: null, memoryGb: null }
    _renderExtractionModelSection()
  }
}

/**
 * Render the extraction model section in the model picker panel.
 * Inserts/updates the section below the primary model list.
 */
function _renderExtractionModelSection() {
  let section = document.getElementById('extractionModelSection')
  if (!section) {
    // Create the section and insert it before the sp-footer in sp-models
    const footer = document.querySelector('#sp-models .sp-footer')
    if (!footer) return
    section = document.createElement('div')
    section.id = 'extractionModelSection'
    section.style.cssText = 'padding:8px 12px;border-top:1px solid var(--border,#333);margin-top:4px'
    footer.parentNode.insertBefore(section, footer)
  }

  const status = _extractionModelStatus
  const isLoaded = status && status.loaded

  const statusHtml = isLoaded
    ? `<span style="color:var(--green,#4caf50)">● ${esc(status.modelName)}${status.memoryGb ? ` (${status.memoryGb.toFixed(1)}GB)` : ''}</span> <span style="color:var(--accent,#7c6af7);font-size:10px">⚡ Fast Assistant active</span>`
    : `<span style="color:var(--muted,#666)">Not loaded</span> <span style="color:var(--muted,#666);font-size:10px">Fast Assistant inactive</span>`

  const modelOptions = _extractionModelList.length > 0
    ? _extractionModelList.map(m => `<option value="${esc(m.path)}">${esc(_formatModelName(m.id))}</option>`).join('')
    : '<option value="">No models available</option>'

  section.innerHTML = `
    <div class="section-label" style="margin-bottom:6px">EXTRACTION MODEL</div>
    <div style="font-size:11px;margin-bottom:6px">${statusHtml}</div>
    ${!isLoaded ? `
      <select id="extractionModelSelect" class="mode-select" style="width:100%;margin-bottom:6px">
        <option value="">Select model for extraction...</option>
        ${modelOptions}
      </select>
      <button class="btn-primary" style="width:100%;font-size:11px;padding:4px 8px" onclick="loadExtractionModel()">Load</button>
    ` : `
      <button class="btn-secondary" style="width:100%;font-size:11px;padding:4px 8px" onclick="unloadExtractionModel()">Unload</button>
    `}
  `
}

/**
 * Load the selected extraction model.
 */
async function loadExtractionModel() {
  const select = document.getElementById('extractionModelSelect')
  if (!select || !select.value) {
    showToast('Select a model first', 'warning')
    return
  }
  const modelPath = select.value
  try {
    const result = await window.app.loadExtractionModel(modelPath)
    if (result && result.error) {
      showToast(`Failed to load extraction model: ${result.error}`, 'error')
    } else {
      showToast('Extraction model loaded', 'success')
      await refreshExtractionModelStatus()
    }
  } catch (err) {
    showToast(`Failed to load extraction model: ${err.message || 'Unknown error'}`, 'error')
  }
}

/**
 * Unload the extraction model.
 */
async function unloadExtractionModel() {
  try {
    await window.app.unloadExtractionModel()
    showToast('Extraction model unloaded', 'info')
    await refreshExtractionModelStatus()
  } catch (err) {
    showToast(`Failed to unload extraction model: ${err.message || 'Unknown error'}`, 'error')
  }
}

/**
 * Populate the extraction model dropdown with available models.
 * Called when the models panel is shown.
 */
function populateExtractionModelList(models) {
  // Filter to models <= 8B where possible (heuristic: name contains 4B, 7B, 8B, 3B, 1B, 2B)
  const smallModels = models.filter(m => /[1-8][Bb]/.test(m.id))
  _extractionModelList = smallModels.length > 0 ? smallModels : models
  _renderExtractionModelSection()
}

// ── Agent Roles Tab ───────────────────────────────────────────────────────────

const ALL_TOOLS = [
  'read_file', 'write_file', 'edit_file', 'list_dir', 'bash', 'search_files',
  'web_search', 'web_fetch',
  'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type',
  'browser_get_text', 'browser_get_html', 'browser_evaluate', 'browser_wait_for',
  'browser_select_option', 'browser_close',
]

let _agentRoles = []
let _selectedRoleName = null
let _isNewRole = false

async function loadAgentRoles() {
  if (!window.app?.agentRolesList) return
  const res = await window.app.agentRolesList()
  _agentRoles = res.roles || []
  renderAgentRoleList()
}

function renderAgentRoleList() {
  const list = document.getElementById('agentRoleList')
  if (!list) return
  list.innerHTML = ''
  for (const role of _agentRoles) {
    const card = document.createElement('div')
    card.className = 'agent-role-card' + (role.builtin ? ' builtin' : '') + (role.name === _selectedRoleName ? ' active' : '')
    card.innerHTML = `<span class="agent-role-icon">${role.icon || '🤖'}</span><div class="agent-role-info"><div class="agent-role-name">${role.name}</div><div class="agent-role-tag">${role.builtin ? 'built-in' : 'custom'}</div></div>`
    card.onclick = () => agentRoleSelect(role.name)
    list.appendChild(card)
  }
}

function agentRoleSelect(name) {
  _selectedRoleName = name
  _isNewRole = false
  const role = _agentRoles.find(r => r.name === name)
  if (!role) return
  renderAgentRoleList()
  const editor = document.getElementById('agentRoleEditor')
  editor.style.display = 'flex'
  editor.style.flexDirection = 'column'
  document.getElementById('agentRoleEditorTitle').textContent = `${role.icon || '🤖'} ${role.name}`
  document.getElementById('agentRoleIcon').value = role.icon || ''
  document.getElementById('agentRoleName').value = role.name
  document.getElementById('agentRoleDesc').value = role.description || ''
  document.getElementById('agentRoleKeywords').value = role.keywords || ''
  document.getElementById('agentRolePrompt').value = role.prompt || ''
  document.getElementById('agentDeleteBtn').style.display = role.builtin ? 'none' : ''
  renderToolsGrid(role.tools || [])
}

function agentRoleNew() {
  _selectedRoleName = null
  _isNewRole = true
  renderAgentRoleList()
  const editor = document.getElementById('agentRoleEditor')
  editor.style.display = 'flex'
  editor.style.flexDirection = 'column'
  document.getElementById('agentRoleEditorTitle').textContent = 'New Role'
  document.getElementById('agentRoleIcon').value = '🤖'
  document.getElementById('agentRoleName').value = ''
  document.getElementById('agentRoleDesc').value = ''
  document.getElementById('agentRoleKeywords').value = ''
  document.getElementById('agentRolePrompt').value = ''
  document.getElementById('agentDeleteBtn').style.display = 'none'
  renderToolsGrid([])
}

function renderToolsGrid(selectedTools) {
  const grid = document.getElementById('agentRoleToolsGrid')
  if (!grid) return
  grid.innerHTML = ''
  for (const tool of ALL_TOOLS) {
    const chip = document.createElement('span')
    chip.className = 'agent-tool-chip' + (selectedTools.includes(tool) ? ' selected' : '')
    chip.textContent = tool
    chip.onclick = () => chip.classList.toggle('selected')
    grid.appendChild(chip)
  }
}

function getSelectedTools() {
  return [...document.querySelectorAll('#agentRoleToolsGrid .agent-tool-chip.selected')].map(c => c.textContent)
}

async function agentRoleSave() {
  const name = document.getElementById('agentRoleName').value.trim()
  if (!name) { alert('Role name is required'); return }
  const role = {
    name,
    icon: document.getElementById('agentRoleIcon').value.trim() || '🤖',
    description: document.getElementById('agentRoleDesc').value.trim(),
    keywords: document.getElementById('agentRoleKeywords').value.trim(),
    prompt: document.getElementById('agentRolePrompt').value.trim(),
    tools: getSelectedTools(),
    builtin: false,
  }
  const res = await window.app.agentRoleSave(role)
  if (res.error) { alert('Save failed: ' + res.error); return }
  _selectedRoleName = name
  await loadAgentRoles()
  agentRoleSelect(name)
}

async function agentRoleDelete() {
  if (!_selectedRoleName) return
  if (!confirm(`Delete role "${_selectedRoleName}"?`)) return
  await window.app.agentRoleDelete(_selectedRoleName)
  _selectedRoleName = null
  document.getElementById('agentRoleEditor').style.display = 'none'
  await loadAgentRoles()
}

async function agentRoleGenerate() {
  const name = document.getElementById('agentRoleName').value.trim()
  const description = document.getElementById('agentRoleDesc').value.trim()
  if (!name && !description) { alert('Enter a name and description first'); return }
  const btn = document.getElementById('agentGenerateBtn')
  const status = document.getElementById('agentGenerateStatus')
  btn.disabled = true
  btn.textContent = '⏳ Generating...'
  status.style.display = 'block'
  status.textContent = 'Asking the model to generate prompt and tools...'
  try {
    const res = await window.app.agentRoleGenerate({
      name: name || 'custom',
      description,
      existingPrompt: document.getElementById('agentRolePrompt').value.trim(),
    })
    if (res.error) { status.textContent = '❌ ' + res.error; return }
    if (res.prompt) document.getElementById('agentRolePrompt').value = res.prompt
    if (res.keywords) document.getElementById('agentRoleKeywords').value = res.keywords
    if (res.tools) renderToolsGrid(res.tools)
    status.textContent = '✅ Generated — review and save'
  } catch (err) {
    status.textContent = '❌ ' + err.message
  } finally {
    btn.disabled = false
    btn.textContent = '✨ Generate'
  }
}

// Load roles when the Agents tab is opened — hooked into switchMainTab above

// ── Memory Bank Tab ───────────────────────────────────────────────────────────

let _memoryLoaded = false

/**
 * Format a UTC timestamp string into a short human-readable form.
 */
function _memFmtTime(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    const now = new Date()
    const diffMs = now - d
    if (diffMs < 60000) return 'just now'
    if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago'
    if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago'
    return d.toLocaleDateString()
  } catch { return '' }
}

/**
 * Format bytes into a human-readable size string.
 */
function _memFmtBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

/**
 * Render a list of archive events into the feed element.
 */
function _memRenderFeed(events) {
  const feed = document.getElementById('memoryFeed')
  if (!feed) return
  if (!events || events.length === 0) {
    feed.innerHTML = '<div class="memory-empty">No archive events found</div>'
    return
  }
  feed.innerHTML = events.map(ev => {
    const type = ev.event_type || ev.type || 'unknown'
    const summary = ev.summary || (typeof ev.payload === 'string' ? ev.payload.slice(0, 120) : JSON.stringify(ev.payload || '').slice(0, 120))
    const agent = ev.agent_name ? `<span class="memory-event-agent">${ev.agent_name}</span>` : ''
    const time = _memFmtTime(ev.timestamp)
    return `<div class="memory-event">
      <div class="memory-event-header">
        <span class="memory-event-type ${type}">${type.replace(/_/g, ' ')}</span>
        ${agent}
        <span class="memory-event-time">${time}</span>
      </div>
      <div class="memory-event-summary" title="${(summary || '').replace(/"/g, '&quot;')}">${summary || '—'}</div>
    </div>`
  }).join('')
}

/**
 * Render KG triples into the results panel.
 */
function _memRenderTriples(triples) {
  const el = document.getElementById('memoryKgResults')
  if (!el) return
  if (!triples || triples.length === 0) {
    el.innerHTML = '<div class="memory-empty">No triples found for this entity</div>'
    return
  }
  el.innerHTML = triples.map(t => {
    const validUntil = t.valid_until ? `<div class="memory-triple-time">valid until ${_memFmtTime(t.valid_until)}</div>` : ''
    return `<div class="memory-triple">
      <span class="memory-triple-subject">${t.subject || '?'}</span>
      <span class="memory-triple-predicate">${t.predicate || '?'}</span>
      <span class="memory-triple-object">${t.object || '?'}</span>
      ${validUntil}
    </div>`
  }).join('')
}

/**
 * Load and render memory stats + recent archive events.
 */
async function memoryRefresh() {
  if (!window.app) return
  const btn = document.getElementById('memoryRefreshBtn')
  if (btn) btn.textContent = '…'

  try {
    // Stats
    if (window.app.memoryStats) {
      const stats = await window.app.memoryStats()
      if (stats) {
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val }
        set('memStatTriplesVal', (stats.kg_triples ?? '—').toLocaleString())
        set('memStatVectorsVal', (stats.vector_count ?? '—').toLocaleString())
        set('memStatArchiveVal', (stats.archive_events ?? '—').toLocaleString())
        set('memStatSizeVal', stats.archive_size_bytes != null ? _memFmtBytes(stats.archive_size_bytes) : '—')
      }
    }

    // Recent events
    if (window.app.memoryArchiveEvents) {
      const events = await window.app.memoryArchiveEvents(100)
      _memRenderFeed(events)
    }
  } catch (err) {
    const feed = document.getElementById('memoryFeed')
    if (feed) feed.innerHTML = `<div class="memory-empty">Memory backend unavailable — load a model to enable memory</div>`
  } finally {
    if (btn) btn.textContent = '↻ Refresh'
    _memoryLoaded = true
  }
}

/**
 * Search the archive by keyword.
 */
let _memSearchTimer = null
function memorySearch(query) {
  clearTimeout(_memSearchTimer)
  _memSearchTimer = setTimeout(async () => {
    if (!window.app || !window.app.memoryArchiveSearch) return
    try {
      if (!query || query.trim().length < 2) {
        // Empty search — reload recent events
        const events = await window.app.memoryArchiveEvents(100)
        _memRenderFeed(events)
        return
      }
      const results = await window.app.memoryArchiveSearch(query.trim(), 50)
      _memRenderFeed(results)
    } catch (_) {}
  }, 300)
}

/**
 * Query the knowledge graph for an entity.
 */
async function memoryKgQuery() {
  const input = document.getElementById('memoryKgInput')
  const entity = input?.value?.trim()
  if (!entity || !window.app || !window.app.memoryKgQuery) return
  const el = document.getElementById('memoryKgResults')
  if (el) el.innerHTML = '<div class="memory-empty">Querying…</div>'
  try {
    const triples = await window.app.memoryKgQuery(entity)
    _memRenderTriples(triples)
  } catch (_) {
    if (el) el.innerHTML = '<div class="memory-empty">Query failed — memory backend may be unavailable</div>'
  }
}

// Allow Enter key in KG input to trigger query
document.addEventListener('DOMContentLoaded', () => {
  const kgInput = document.getElementById('memoryKgInput')
  if (kgInput) {
    kgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') memoryKgQuery()
    })
  }
})

// Auto-load memory data when the tab is first opened
// Hook into switchMainTab — called when user clicks the Memory tab
const _origSwitchMainTab = typeof switchMainTab === 'function' ? switchMainTab : null
// We patch via the tab onclick directly — switchMainTab is defined in app.js
// so we wrap it after definition by overriding the global
if (typeof window !== 'undefined') {
  window._memoryTabAutoLoad = function() {
    if (!_memoryLoaded) memoryRefresh()
  }
}
