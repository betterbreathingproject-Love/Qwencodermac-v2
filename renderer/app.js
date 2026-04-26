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
let permMode = 'auto-edit' // 'auto-edit' or 'default'
let currentTodos = [] // persisted todo list for active session

// ── init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  window.app.onServerStatus(s => { setServerStatus(s.running); if(s.running) refreshStatus() })
  await refreshStatus()

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
  refreshWelcomeProjectBar()
  initLspStatus()
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

// ── server ────────────────────────────────────────────────────────────────────
async function refreshStatus() {
  const s = await window.app.serverStatus()
  setServerStatus(s.running)
  if(s.running) { if(s.models) renderModels(s.models); if(s.loaded) setLoadedModel(s.loaded) }
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
  activeSessionId = id
  const sessions = await window.app.listSessions(activeProjectId)
  const sess = sessions.find(s => s.id === id)
  activeSessionType = (sess && sess.type) || 'vibe'
  conversationHistory = await window.app.getSessionMsgs(activeProjectId, id)
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
    <div class="msg-system" id="${respId}-status">🤖 Agent starting in ${currentProject}...</div>
    <div id="${respId}-tools"></div>
    <details class="msg-thinking" id="${respId}-think" style="display:none">
      <summary>🧠 Thinking</summary>
      <div class="msg-thinking-body" id="${respId}-think-body"></div>
    </details>
    <div class="msg-text" id="${respId}-text"></div>
  </div>`)
  scrollOutput()

  let lastText = '', lastThinking = '', tokenCount = 0, startTime = null
  let agentFinished = false
  let lastToolName = ''
  let inputTokens = 0, outputTokens = 0
  let serverTps = null // real tk/s from server, used when available
  let allTextSegments = [] // accumulates text across all turns (text→tool→text→...)
  window._rawCount = 0
  window._rawToolCalls = null
  window.app.offQwenEvents()
  updateStatusBar('initializing', { progress: -1, activity: 'Starting agent...' })
  updateAgentStatsBar({ state: 'initializing', progress: -1, activity: 'Starting agent...' })

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

  window.app.onQwenEvent(ev => {
    if (agentFinished && ev.type !== 'session-end') return
    switch(ev.type) {
      case 'session-start':
        document.getElementById(respId+'-status').textContent = '🤖 Agent running in ' + (ev.cwd||'.')
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
        updateStatusBar('generating', { tokens: tokenCount, tks: serverTps || _calcTks(tokenCount, startTime) })
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: outputTokens || tokenCount, tks: serverTps || _calcTks(tokenCount, startTime), toolCount: _agentToolCount, activity: 'Writing response...' })
        break
      case 'thinking-delta':
        lastThinking = ev.text
        stopPromptProgress()
        const thinkEl = document.getElementById(respId+'-think')
        thinkEl.style.display = ''
        document.getElementById(respId+'-think-body').textContent = lastThinking + '▌'
        updateStatusBar('thinking', { activity: 'Reasoning...' })
        updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: tokenCount, activity: 'Reasoning...' })
        break
      case 'tool-use':
        lastToolName = ev.name || ''
        _agentToolCount++
        stopPromptProgress()
        // Start a new text segment for the next turn after this tool call
        allTextSegments.push('')
        document.getElementById(respId+'-tools').insertAdjacentHTML('beforeend', renderToolUse(ev.name, ev.input, 'running'))
        document.getElementById(respId+'-status').textContent = `🔧 Using tool: ${ev.name}`
        updateStatusBar('tool', { toolName: ev.name, activity: `Running ${ev.name}...` })
        updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: `Running ${ev.name}...` })
        scrollOutput()
        break
      case 'tool-result': {
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
        document.getElementById(respId+'-status').textContent = '🤖 Agent processing...'
        // Show "waiting for model" state — the server is now processing the tool
        // result and deciding what to do next
        updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: 'Thinking about next step...' })
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
      case 'system':
        if (ev.subtype === 'debug') document.getElementById(respId+'-status').textContent = `🔍 ${ev.data}`
        else { document.getElementById(respId+'-status').textContent = ev.subtype === 'init' ? '🤖 Agent initialized' : `⚙️ ${ev.subtype}` }
        updateStatusBar('processing', { activity: ev.subtype === 'debug' ? ev.data : ev.subtype })
        updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens: outputTokens || tokenCount, toolCount: _agentToolCount, activity: ev.subtype === 'debug' ? ev.data : ev.subtype })
        scrollOutput()
        break
      case 'usage':
        if (ev.usage) {
          inputTokens = ev.usage.input_tokens || ev.usage.prompt_tokens || inputTokens
          outputTokens = ev.usage.output_tokens || ev.usage.completion_tokens || outputTokens
        }
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens })
        break
      case 'result':
        document.getElementById(respId+'-status').textContent = ev.is_error ? `❌ ${ev.subtype}: ${ev.result||'error'}` : '✅ Done'
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
  const btn = document.getElementById('previewToggle')
  pane.style.display = previewOpen ? 'flex' : 'none'
  btn.textContent = previewOpen ? 'Preview ◂' : 'Preview ▸'
  if (previewOpen) refreshPreview()
}

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
    return `<div class="tg-node status-${node.status}" data-node-id="${id}" style="padding-left:${8 + indent}px" onclick="showTaskDetail('${id}')">
      <span class="tg-node-dot ${node.status}"></span>
      <span class="tg-node-id">${esc(id)}</span>
      <span class="tg-node-title">${esc(node.title)}</span>
      ${agentTag}
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

// ── spec workflow panel (AI-powered) ──────────────────────────────────────────
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
  currentSpecName = name
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
  if (dot) { dot.className = 'inline-spec-step-dot active' }

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

    const result = await window.app.chat({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    })

    if (result.error) {
      appendMsg('system', `❌ Spec generation failed: ${result.error}`)
    } else {
      let content = result.choices?.[0]?.message?.content || ''
      // Strip <think> tags
      content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      // Strip plain-text thinking preamble — everything before the first markdown heading
      if (!/^#/m.test(content.split('\n')[0]) && /^#/m.test(content)) {
        content = content.slice(content.search(/^#/m)).trim()
      }
      await window.app.specSaveArtifact(currentSpecDir, phase, content)
      await window.app.specAdvance(currentSpecDir)
      appendMsg('system', `✅ ${phase.charAt(0).toUpperCase() + phase.slice(1)} generated for "${currentSpecName}"`)
      viewInlineSpecArtifact(phase)

      // If tasks were generated, write Tasks.md and load into task graph
      if (phase === 'tasks' && currentProject) {
        const tasksPath = currentProject + '/.kiro/specs/' + currentSpecName + '/tasks.md'
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
    appendMsg('system', `❌ Error: ${e.message}`)
  }

  if (btn) { btn.classList.remove('generating') }
  specGenerating = false
  await refreshInlineSpecStepper()
}

async function startInlineSpecImplementation() {
  if (!currentSpecDir || !currentProject) return
  if (isGenerating) return
  const artifacts = await window.app.specArtifacts(currentSpecDir)
  if (!artifacts.tasks) { appendMsg('system', '⚠️ Generate tasks first.'); return }

  // Load task graph into the sidebar panel first
  const tasksPath = currentProject + '/.kiro/specs/' + currentSpecName + '/tasks.md'
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

  // Use the orchestrator — trigger it via sendAgentMode's built-in orchestrator path
  // by setting _pendingTasksExecute so the agent result handler picks it up
  window._pendingTasksExecute = tasksPath

  // Send a minimal prompt that will immediately finish and trigger the orchestrator
  sendAgentMode(`The spec "${currentSpecName}" tasks are ready at ${tasksPath}. The orchestrator will execute them automatically.`, { skipUserMsg: true, historyLabel: `📐 Implement spec "${currentSpecName}" (${taskCount} tasks)` })
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
  currentSpecName = name
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

Generate a structured task list using this exact format:
- [ ] 1 Task title
  - [ ] 1.1 Subtask title
  - [ ] 1.2 Subtask title
- [ ] 2 Next task title

Include tasks for:
- Setup and scaffolding
- Core implementation (broken into logical pieces)
- Tests (unit and integration)
- Documentation updates

Order tasks by dependency — things that must be done first come first. Each task should be small enough to complete in 1-2 hours.

IMPORTANT: Output ONLY the markdown task list. Do NOT include any thinking process, reasoning steps, or preamble. Start directly with the task list.`,
}

async function generateSpecPhase(phase) {
  if (!currentSpecDir || !loadedModelId || specGenerating) return
  specGenerating = true

  const btn = document.getElementById('genBtn-' + phase)
  const status = document.getElementById('stepStatus-' + phase)
  const dot = document.getElementById('stepDot-' + phase)
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating...'; btn.classList.add('generating') }
  if (status) { status.textContent = 'Generating...'; status.className = 'spec-step-status generating' }
  if (dot) { dot.className = 'spec-step-dot active' }

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

    // Call the AI via the chat endpoint (non-streaming for simplicity)
    const result = await window.app.chat({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    })

    if (result.error) {
      appendMsg('system', `❌ Spec generation failed: ${result.error}`)
    } else {
      let content = result.choices?.[0]?.message?.content || ''
      // Strip thinking tags if present
      content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      // Strip plain-text thinking preamble before first markdown heading
      if (!/^#/m.test(content.split('\n')[0]) && /^#/m.test(content)) {
        content = content.slice(content.search(/^#/m)).trim()
      }
      await window.app.specSaveArtifact(currentSpecDir, phase, content)
      // Advance phase
      await window.app.specAdvance(currentSpecDir)
      appendMsg('system', `✅ ${phase.charAt(0).toUpperCase() + phase.slice(1)} generated for "${currentSpecName}"`)
      viewSpecArtifact(phase)
    }
  } catch (e) {
    appendMsg('system', `❌ Error: ${e.message}`)
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
  const tasksPath = currentProject + '/.kiro/specs/' + currentSpecName + '/tasks.md'
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

  // Use the orchestrator via sendAgentMode's built-in orchestrator path
  window._pendingTasksExecute = tasksPath
  sendAgentMode(`The spec "${currentSpecName}" tasks are ready at ${tasksPath}. The orchestrator will execute them automatically.`, { skipUserMsg: true, historyLabel: `📐 Implement spec "${currentSpecName}" (${taskCount} tasks)` })
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
    currentSpecName = args
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
function updateAgentStatsBar(opts = {}) {
  const bar = document.getElementById('agentStats')
  if (!bar) return

  const { state, inputTokens, outputTokens, tks, promptTps, peakMemory, toolName, progress, activity, toolCount, agentType } = opts

  // Always show the stats bar when agent is active
  if (state === 'idle' && !inputTokens && !outputTokens) {
    bar.style.display = 'none'
    return
  }
  bar.style.display = 'flex'

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

  // Tool count if available
  if (toolCount != null && toolCount > 0) {
    html += `<div class="stat-chip"><span class="stat-label">Tools</span><span class="stat-val">🔧 ${toolCount}</span></div>`
  }

  // Peak memory if available
  if (peakMemory != null) {
    html += `<div class="stat-chip"><span class="stat-label">Peak VRAM</span><span class="stat-val">${peakMemory} GB</span></div>`
  }

  // Activity log (right-aligned)
  if (activity) {
    html += `<div class="agent-activity-log"><span class="activity-step active">${activity}</span></div>`
  }

  bar.innerHTML = html
}

// ── persistent bottom status bar — REMOVED ───────────────────────────────────
// All status info is now in the unified chip bar (updateAgentStatsBar).
// This is a no-op stub so existing calls don't break.
function updateStatusBar() {}

// (status bar init removed — all status in chip bar now)

// ── LSP status indicator ──────────────────────────────────────────────────────

function setLspStatus({ status, servers = [] }) {
  const chip = document.getElementById('lspChip')
  const dot  = document.getElementById('lspDot')
  const txt  = document.getElementById('lspText')
  if (!chip) return

  if (status === 'stopped') {
    chip.style.display = 'none'
    return
  }

  chip.style.display = 'inline-flex'

  const colors = { ready: 'var(--green)', starting: '#f5a623', degraded: '#f5a623', error: 'var(--red)' }
  dot.style.background = colors[status] || 'var(--muted)'
  txt.textContent = 'LSP'

  const serverNames = servers.map(s => s.name).join(', ')
  chip.title = status === 'ready'
    ? `LSP ready — ${serverNames || 'no language servers'}`
    : status === 'degraded'
    ? `LSP degraded — no language servers found on PATH`
    : status === 'starting'
    ? 'LSP starting...'
    : `LSP error`
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
