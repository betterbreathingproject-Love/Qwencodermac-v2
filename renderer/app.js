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
  checkCompactor()
  checkSearchEngine()
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
  if(name==='background') loadBackgroundTasks()
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
  const l = document.getElementById('modelList')
  if(!models.length) { l.innerHTML='<div class="model-empty">No models</div>'; return }
  l.innerHTML = models.map(m => {
    const n=m.id.replace(/^qwen3-vl-/,'').split('-').pop() || m.id, cls=m.id===loadedModelId?'model-card loaded':(selectedModel?.id===m.id?'model-card selected':'model-card')
    return `<div class="${cls}" id="card-${CSS.escape(m.id)}" onclick="selectModel('${m.id}','${m.path}')">
      <div class="model-card-name">${n}</div>
      <div class="model-card-meta"><span class="badge ${m.vision?'badge-vision':'badge-text'}">${m.vision?'👁 Vision':'💬 Text'}</span><span class="badge badge-type">${m.model_type}</span></div></div>`
  }).join('')
}
function selectModel(id, path) {
  selectedModel={id,path}
  document.querySelectorAll('.model-card').forEach(c => { c.className = c.id==='card-'+CSS.escape(loadedModelId)?'model-card loaded':(c.id==='card-'+CSS.escape(id)?'model-card selected':'model-card') })
  const b=document.getElementById('loadBtn'), t=document.getElementById('loadBtnText')
  b.disabled=id===loadedModelId; t.textContent=id===loadedModelId?'Already loaded':`Load ${id.split('/').pop()}`
}
async function loadSelected() {
  if(!selectedModel) return
  const b=document.getElementById('loadBtn'), t=document.getElementById('loadBtnText')
  b.disabled=true; t.innerHTML='<span class="spinner"></span>Loading...'
  try { const r=await window.app.loadModel(selectedModel.path); setLoadedModel(r.model_id||selectedModel.id); t.textContent='Already loaded' }
  catch { t.textContent='Failed'; b.disabled=false }
}
function setLoadedModel(id) {
  loadedModelId=id
  document.getElementById('loadedModelName').textContent=id||'None'
  document.getElementById('f-modelid').textContent=id||'—'
  renderModels(allModels)
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
  await loadSessions(p.activeSession)
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
    restoreChat()
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
  activeSessionId = id
  const sessions = await window.app.listSessions(activeProjectId)
  const sess = sessions.find(s => s.id === id)
  activeSessionType = (sess && sess.type) || 'vibe'
  conversationHistory = await window.app.getSessionMsgs(activeProjectId, id)
  restoreChat()
  updateSessionInfo()
}

async function newSession(sessionType) {
  if (!activeProjectId) { appendMsg('system', '⚠️ Select a project first.'); return }
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
    showPanel('specs', document.querySelector('[data-panel="specs"]'))
  }
}

async function startSessionWithType(type) {
  if (!activeProjectId) { appendMsg('system', '⚠️ Select a project first.'); return }
  await newSession(type)
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

  document.getElementById('agentOutput').innerHTML = `
    <div class="build-picker">
      <div class="build-picker-icon">✦</div>
      <div class="build-picker-title">Let's build</div>
      <div class="build-picker-subtitle">Plan, search, or build anything</div>
      <div class="build-picker-cards">
        <button class="build-card build-card-vibe" onclick="startSessionWithType('vibe')">
          <span class="build-card-icon">💬</span>
          <span class="build-card-label">Vibe</span>
          <span class="build-card-desc">Chat first, then build. Explore ideas and iterate as you discover needs.</span>
        </button>
        <button class="build-card build-card-spec" onclick="startSessionWithType('spec')">
          <span class="build-card-icon">📋</span>
          <span class="build-card-label">Spec</span>
          <span class="build-card-desc">Plan first, then build. Create requirements and design before coding starts.</span>
        </button>
      </div>
      <div class="build-picker-hint">
        <div class="build-picker-hint-label">Great for:</div>
        <ul class="build-picker-hint-list">
          <li>Rapid exploration and testing</li>
          <li>Building when requirements are unclear</li>
          <li>Implementing a task</li>
        </ul>
      </div>
    </div>`
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
const SYSPROMPTS = {
  code:'You are an expert coding assistant. Write clean, well-commented code. Use markdown code blocks with language tags.',
  explain:'You are a code explainer. Break down code clearly.',
  refactor:'You are a refactoring expert. Improve code quality and performance.',
  debug:'You are a debugging expert. Identify issues and provide fixes.',
}
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
  const mode = document.getElementById('agentMode').value

  // auto-create session if none
  if (!activeSessionId && activeProjectId) {
    newSession(activeSessionType || 'vibe').then(() => {
      if (mode === 'agent') sendAgentMode(prompt)
      else sendStreamMode(prompt, mode)
    })
    return
  }

  if (mode === 'agent') { sendAgentMode(prompt); return }
  sendStreamMode(prompt, mode)
}

// ── agent mode (Qwen Code SDK with tools) ─────────────────────────────────────
async function sendAgentMode(prompt) {
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
  if(out.querySelector('.agent-welcome')) out.innerHTML = ''

  appendMsg('user', esc(prompt))
  saveToHistory('user', prompt)
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
    <details class="msg-thinking" id="${respId}-think" style="display:none" open>
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
  window._rawCount = 0
  window.app.offQwenEvents()
  updateStatusBar('initializing')
  updateAgentStatsBar({ state: 'initializing' })

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
        updateStatusBar('initializing')
        updateAgentStatsBar({ state: 'initializing' })
        break
      case 'text-delta':
        lastText = ev.text
        outputTokens += (ev.text || '').length - (lastText.length - (ev.text || '').length)
        if (!startTime) startTime = Date.now()
        tokenCount = lastText.length
        scheduleRender()
        updateStatusBar('generating', { tokens: tokenCount, tks: _calcTks(tokenCount, startTime) })
        updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: tokenCount, tks: _calcTks(tokenCount, startTime) })
        break
      case 'thinking-delta':
        lastThinking = ev.text
        const thinkEl = document.getElementById(respId+'-think')
        thinkEl.style.display = 'block'
        document.getElementById(respId+'-think-body').textContent = lastThinking + '▌'
        updateStatusBar('thinking')
        updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: tokenCount })
        break
      case 'tool-use':
        lastToolName = ev.name || ''
        document.getElementById(respId+'-tools').insertAdjacentHTML('beforeend', renderToolUse(ev.name, ev.input, 'running'))
        document.getElementById(respId+'-status').textContent = `🔧 Using tool: ${ev.name}`
        updateStatusBar('tool', { toolName: ev.name })
        updateAgentStatsBar({ state: 'tool', toolName: ev.name, inputTokens, outputTokens: tokenCount })
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
        updateStatusBar('processing')
        updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens: tokenCount })
        scrollOutput()
        break
      }
      case 'assistant': {
        let html = ''
        for (const block of (ev.blocks || [])) {
          if (block.type === 'text') html += renderMd(block.text)
          else if (block.type === 'thinking') { document.getElementById(respId+'-think').style.display = 'block'; document.getElementById(respId+'-think-body').textContent = block.text }
          else if (block.type === 'tool_use') document.getElementById(respId+'-tools').insertAdjacentHTML('beforeend', renderToolUse(block.name, block.input, 'done'))
          else if (block.type === 'tool_result') { const td = document.getElementById(respId+'-tools'); const lt = td.querySelector('.tool-block:last-child'); if (lt) lt.insertAdjacentHTML('beforeend', renderToolResult(block.content, block.is_error)) }
        }
        if (html) document.getElementById(respId+'-text').innerHTML = html
        if (ev.usage) {
          inputTokens = ev.usage.input_tokens || inputTokens
          outputTokens = ev.usage.output_tokens || outputTokens || tokenCount
        }
        updateStatusBar('processing')
        updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens })
        scrollOutput()
        break
      }
      case 'system':
        if (ev.subtype === 'debug') document.getElementById(respId+'-status').textContent = `🔍 ${ev.data}`
        else { document.getElementById(respId+'-status').textContent = ev.subtype === 'init' ? '🤖 Agent initialized' : `⚙️ ${ev.subtype}` }
        // Don't go to idle on system events — agent is still working
        updateStatusBar('processing')
        updateAgentStatsBar({ state: 'processing', inputTokens, outputTokens: tokenCount })
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
        if (!agentFinished) {
          agentFinished = true
          updateStatusBar('idle')
          updateAgentStatsBar({ state: 'done', inputTokens, outputTokens: outputTokens || tokenCount })
          finishGeneration()
        }
        break
      case 'session-end':
        document.getElementById(respId+'-status').textContent = '✅ Agent finished'
        const textEl = document.getElementById(respId+'-text')
        if (textEl) textEl.innerHTML = renderMd(lastText)
        const tb = document.getElementById(respId+'-think-body')
        if (tb && tb.textContent.endsWith('▌')) tb.textContent = tb.textContent.slice(0,-1)
        if (lastText) saveToHistory('assistant', lastText)
        if (currentProject) renderFileTree(currentProject, document.getElementById('fileTree'))
        showPreviewButton(respId)
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
        if (sev.choices?.[0]?.delta?.content) {
          const content = sev.choices[0].delta.content
          lastText += content
          scheduleRender()
          tokenCount += content.length
          const tks = _calcTks(tokenCount, startTime)
          updateStatusBar('generating', { tokens: tokenCount, tks })
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: tokenCount, tks })
        } else if (sev.type === 'content_block_delta' && sev.delta?.text) {
          const deltaText = sev.delta.text
          lastText += deltaText
          scheduleRender()
          tokenCount += deltaText.length
          const tks2 = _calcTks(tokenCount, startTime)
          updateStatusBar('generating', { tokens: tokenCount, tks: tks2 })
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens: tokenCount, tks: tks2 })
        } else if (sev.type === 'content_block_delta' && sev.delta?.thinking) {
          lastThinking += sev.delta.thinking
          document.getElementById(respId+'-think').style.display = 'block'
          document.getElementById(respId+'-think-body').textContent = lastThinking + '▌'
          updateStatusBar('thinking')
          updateAgentStatsBar({ state: 'thinking', inputTokens, outputTokens: tokenCount })
        } else if (sev.usage) {
          inputTokens = sev.usage.prompt_tokens || inputTokens
          outputTokens = sev.usage.completion_tokens || outputTokens || tokenCount
          const genTps = sev.x_stats?.generation_tps
          const promptTps = sev.x_stats?.prompt_tps
          updateAgentStatsBar({ state: 'generating', inputTokens, outputTokens, tks: genTps, promptTps, peakMemory: sev.x_stats?.peak_memory_gb })
          updateStatusBar('generating', { tokens: outputTokens, tks: genTps })
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
  })
}

// ── stream mode (direct chat completions) ─────────────────────────────────────
async function sendStreamMode(prompt, mode) {
  isGenerating = true
  updateStatusBar('initializing')
  updateAgentStatsBar({ state: 'initializing' })
  const btn = document.getElementById('sendBtn')
  btn.disabled=false; btn.innerHTML='<span class="spinner"></span>Stop'; btn.className='btn-send btn-stop'
  btn.onclick = () => { window.app.chatStreamAbort(); window.app.offStream(); finishGeneration() }

  const out = document.getElementById('agentOutput')
  if(out.querySelector('.agent-welcome')) out.innerHTML = ''

  if (attachedImgs.length > 0) {
    const imgHtml = attachedImgs.map(img => `<img class="agent-img-in-chat" src="${img.b64}">`).join('')
    appendMsg('user', prompt + imgHtml)
  } else {
    appendMsg('user', prompt)
  }
  saveToHistory('user', prompt)
  document.getElementById('agentPrompt').value = ''

  const userContent = attachedImgs.length > 0
    ? [{ type: 'text', text: prompt }, ...attachedImgs.map(img => ({ type: 'image_url', image_url: { url: img.b64 } }))]
    : prompt
  attachedImgs = []; renderAttachedImages()

  const respId = 'resp-'+Date.now()
  out.insertAdjacentHTML('beforeend', `<div class="msg-block" id="${respId}">
    <details class="msg-thinking" id="${respId}-think" style="display:none" open>
      <summary>🧠 Thinking</summary>
      <div class="msg-thinking-body" id="${respId}-think-body"></div>
    </details>
    <div class="msg-text" id="${respId}-text"></div>
  </div>`)
  scrollOutput()

  let fullText='', thinkText='', respText='', inThinking=false, thinkDone=false, tokenCount=0, startTime=null
  let streamInputTokens = 0, streamOutputTokens = 0
  window.app.offStream()

  window.app.onStreamChunk(chunk => {
    const delta = chunk.choices?.[0]?.delta?.content
    if(!delta) return
    if(!startTime) startTime = Date.now()
    fullText += delta; tokenCount += delta.length
    const tks = _calcTks(tokenCount, startTime)
    updateStatusBar(inThinking ? 'thinking' : 'generating', { tokens: tokenCount, tks })
    updateAgentStatsBar({ state: inThinking ? 'thinking' : 'generating', inputTokens: streamInputTokens, outputTokens: tokenCount, tks })
    if(!thinkDone) {
      if(!inThinking && THINK_OPEN.test(fullText)) inThinking=true
      if(inThinking) {
        const ci = fullText.indexOf('</think>')
        if(ci!==-1) { thinkText=fullText.slice(fullText.indexOf('<think>')+7,ci); respText=fullText.slice(ci+8); inThinking=false; thinkDone=true }
        else thinkText=fullText.slice(fullText.indexOf('<think>')+7)
      } else respText=fullText
    } else respText=fullText.slice(fullText.indexOf('</think>')+8)
    const thinkEl = document.getElementById(respId+'-think')
    const thinkBody = document.getElementById(respId+'-think-body')
    if(thinkText||inThinking) { thinkEl.style.display='block'; thinkBody.textContent=thinkText+(inThinking?'▌':'') }
    document.getElementById(respId+'-text').innerHTML = renderMd(respText, true)+'<span class="cursor">▌</span>'
    scrollOutput()
  })

  window.app.onStreamStats(stats => {
    streamInputTokens = stats.prompt_tokens || streamInputTokens
    streamOutputTokens = stats.completion_tokens || streamOutputTokens || tokenCount
    const genTps = stats.generation_tps != null ? stats.generation_tps : null
    const promptTps = stats.prompt_tps != null ? stats.prompt_tps : null
    updateAgentStatsBar({ state: 'done', inputTokens: streamInputTokens, outputTokens: streamOutputTokens, tks: genTps, promptTps, peakMemory: stats.peak_memory_gb })
    updateStatusBar('generating', { tokens: streamOutputTokens, tks: genTps })
  })

  window.app.onStreamDone(() => {
    const textEl = document.getElementById(respId+'-text')
    if(textEl) textEl.innerHTML = renderMd(respText)
    const tb = document.getElementById(respId+'-think-body')
    if(tb && tb.textContent.endsWith('▌')) tb.textContent=tb.textContent.slice(0,-1)
    saveToHistory('assistant', respText)
    updateAgentStatsBar({ state: 'done', inputTokens: streamInputTokens, outputTokens: streamOutputTokens || tokenCount })
    finishGeneration()
    maybeAutoCompact()
  })

  window.app.onStreamError(err => { appendMsg('system', '❌ '+err); finishGeneration() })

  // build messages with project context and history
  let sysContent = SYSPROMPTS[mode] || SYSPROMPTS.code
  if (currentProject) {
    let ctx = await window.app.buildContext(currentProject)
    if (ctx && compactorInstalled && projectSettings?.autoCompact) {
      const compressed = await window.app.compactText(ctx, 'auto')
      if (compressed.stats?.compressed) ctx = compressed.compressed
    }
    if (ctx) sysContent += ctx
  }

  const maxHist = (projectSettings?.maxHistoryMessages || 40)
  const histMsgs = conversationHistory.slice(-maxHist).map(m => ({ role: m.role, content: m.content }))

  window.app.chatStream({
    messages: [{ role: 'system', content: sysContent }, ...histMsgs, { role: 'user', content: userContent }],
    max_tokens: 4096,
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

function scrollOutput() { const o=document.getElementById('agentOutput'); o.scrollTop=o.scrollHeight }

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

// ── markdown ──────────────────────────────────────────────────────────────────
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function stripThinking(t){return t.replace(/<\/?think>/gi,'').trim()}
function stripToolCallMarkup(t){return t.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi,'').replace(/<tool_call>[\s\S]*$/gi,'').trim()}

let _codeBlockId = 0
function renderMd(text, isStreaming){
  if(!text) return ''
  text = stripThinking(text)
  text = stripToolCallMarkup(text)
  let html = esc(text)

  // code blocks (fenced)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = 'cb-' + (++_codeBlockId)
    const trimmed = code.trim()
    const lc = trimmed.split('\n').length
    const lines = trimmed.split('\n').map((l,i) => `<span class="ln">${i+1}</span>${l}`).join('\n')
    const canPreview = ['html','htm','svg'].includes((lang||'').toLowerCase())
    return `<div class="code-block"><div class="code-header"><span class="code-lang">${lang||'code'}</span><span class="code-lines">${lc} lines</span><button class="code-copy" onclick="copyCodeBlock('${id}',this)">Copy</button><button class="code-copy" onclick="saveCodeToFile('${id}','${lang||'txt'}',this)">💾 Save</button>${canPreview?`<button class="code-preview" onclick="previewCode('${id}')">▶ Preview</button>`:''}</div><pre id="${id}"><code>${lines}</code></pre></div>`
  })

  // streaming partial code block
  if(isStreaming){
    html = html.replace(/```(\w*)\n?([\s\S]*)$/, (_, lang, code) => {
      const trimmed = code.trim()
      if(!trimmed) return `<div class="code-block streaming"><div class="code-header"><span class="code-lang">${lang||'code'}</span><span class="code-lines">writing...</span></div><pre><code></code></pre></div>`
      const lines = trimmed.split('\n').map((l,i) => `<span class="ln">${i+1}</span>${l}`).join('\n')
      return `<div class="code-block streaming"><div class="code-header"><span class="code-lang">${lang||'code'}</span><span class="code-lines">${trimmed.split('\n').length} lines...</span></div><pre><code>${lines}</code></pre></div>`
    })
  }

  // markdown tables
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim())
    if (rows.length < 2) return tableBlock
    // check if row 2 is a separator (|---|---|)
    const isSep = r => /^\|[\s\-:]+(\|[\s\-:]+)+\|?$/.test(r.trim())
    let headerRow = rows[0], bodyRows
    if (isSep(rows[1])) {
      bodyRows = rows.slice(2)
    } else {
      headerRow = null
      bodyRows = rows
    }
    const parseRow = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
    let t = '<div class="md-table-wrap"><table class="md-table">'
    if (headerRow) {
      const cells = parseRow(headerRow)
      t += '<thead><tr>' + cells.map(c => `<th>${c}</th>`).join('') + '</tr></thead>'
    }
    t += '<tbody>'
    for (const r of bodyRows) {
      if (isSep(r)) continue
      const cells = parseRow(r)
      t += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>'
    }
    t += '</tbody></table></div>'
    return t
  })

  // checklists: - [x] done, - [ ] todo
  html = html.replace(/^- \[x\] (.+)$/gm, '<div class="md-check"><span class="md-check-box checked">✓</span><span class="md-check-text checked">$1</span></div>')
  html = html.replace(/^- \[ \] (.+)$/gm, '<div class="md-check"><span class="md-check-box">☐</span><span class="md-check-text">$1</span></div>')

  // horizontal rule
  html = html.replace(/^---+$/gm, '<hr class="md-hr">')

  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>')
  html = html.replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>')
  html = html.replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>')
  html = html.replace(/^- (.+)$/gm, '<div class="md-li">• $1</div>')
  html = html.replace(/^\* (.+)$/gm, '<div class="md-li">• $1</div>')
  html = html.replace(/^(\d+)\. (.+)$/gm, '<div class="md-li"><span class="md-num">$1.</span> $2</div>')
  html = html.replace(/\n/g, '<br>')
  // collapse excessive line breaks (3+ consecutive <br> → 2)
  html = html.replace(/(<br\s*\/?>){3,}/gi, '<br><br>')
  return html
}

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
}

async function saveContextSettings() {
  if (!activeProjectId) return
  const settings = {
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

// ── tool use rendering ────────────────────────────────────────────────────────
function _toolDisplayName(name) {
  // Clean up tool names: mcp__vision__vision_analyze → vision_analyze, read_file → Read File
  let display = name
  if (display.startsWith('mcp__')) {
    const parts = display.split('__')
    display = parts[parts.length - 1]
  }
  return display.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function _renderToolParams(input) {
  if (!input || (typeof input === 'string' && !input.trim())) return ''
  const obj = typeof input === 'string' ? (() => { try { return JSON.parse(input) } catch { return null } })() : input
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    const str = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    return `<div class="tool-param"><span class="tool-param-val">${esc(str)}</span></div>`
  }
  const entries = Object.entries(obj)
  if (entries.length === 0) return ''
  return entries.map(([key, val]) => {
    let display
    if (typeof val === 'string') {
      display = val.length > 300 ? val.slice(0, 300) + '…' : val
    } else {
      const s = JSON.stringify(val, null, 2)
      display = s.length > 300 ? s.slice(0, 300) + '…' : s
    }
    return `<div class="tool-param">
      <span class="tool-param-key">${esc(key)}</span>
      <span class="tool-param-val">${esc(display)}</span>
    </div>`
  }).join('')
}

function renderToolUse(name, input, status='running') {
  const id = 'tool-' + Date.now() + '-' + Math.random().toString(36).slice(2,6)

  // Special rendering for todo_write — show as a nice checklist UI
  if (name === 'todo_write') {
    return _renderTodoBlock(id, input, status)
  }

  const icons = { read_file:'📖', write_file:'✏️', edit_file:'✏️', bash:'⚡', search:'🔍', list_dir:'📁',
    browser_navigate:'🌐', browser_screenshot:'📸', browser_click:'👆', browser_type:'⌨️',
    browser_get_text:'📄', browser_get_html:'🧾', browser_evaluate:'⚙️', browser_wait_for:'⏳',
    browser_select_option:'☑️', browser_close:'🚪', vision_analyze:'👁️', default:'🔧' }
  const icon = icons[name] || icons[name.split('__').pop()] || icons.default
  const displayName = _toolDisplayName(name)
  const statusLabel = status === 'running' ? 'Running…' : status === 'done' ? 'Done' : status === 'error' ? 'Error' : status
  const statusIcon = status === 'running' ? '<span class="tool-spinner"></span>' : status === 'done' ? '✓' : status === 'error' ? '✗' : ''
  const params = _renderToolParams(input)
  return `<div class="tool-block ${status}" id="${id}">
    <div class="tool-header" onclick="this.parentElement.toggleAttribute('open')">
      <span class="tool-icon">${icon}</span>
      <div class="tool-header-info">
        <span class="tool-name">${esc(displayName)}</span>
        <span class="tool-name-raw">${esc(name)}</span>
      </div>
      <span class="tool-status ${status}">${statusIcon} ${statusLabel}</span>
      <span class="tool-chevron">▸</span>
    </div>
    ${params ? `<div class="tool-params">${params}</div>` : ''}
    <div class="tool-body-raw">${esc(typeof input === 'string' ? input : JSON.stringify(input, null, 2))}</div>
  </div>`
}

function _renderTodoBlock(id, input, status) {
  const obj = typeof input === 'string' ? (() => { try { return JSON.parse(input) } catch { return null } })() : input
  const todos = obj?.todos || (Array.isArray(obj) ? obj : [])

  // Update the persistent todo panel instead of rendering inline
  updateTodoPanel(todos, status)

  // Return a minimal inline indicator instead of a full block
  const statusLabel = status === 'running' ? 'Updating…' : status === 'done' ? '✓ Done' : status === 'error' ? '✗ Error' : status
  const statusCls = status === 'done' ? 'todo-status-done' : status === 'error' ? 'todo-status-error' : 'todo-status-running'
  return `<div class="tool-block todo-block ${status}" id="${id}" style="display:none">
    <span class="todo-status ${statusCls}">${statusLabel}</span>
  </div>`
}

function updateTodoPanel(todos, status) {
  const panel = document.getElementById('todoPanel')
  const body = document.getElementById('todoPanelBody')
  const countEl = document.getElementById('todoPanelCount')
  if (!panel || !body) return

  panel.style.display = 'block'

  const done = todos.filter(t => t.status === 'completed' || t.status === 'done').length
  const total = todos.length
  countEl.textContent = `${done}/${total}`

  let itemsHtml = ''
  for (const todo of todos) {
    const isDone = todo.status === 'completed' || todo.status === 'done'
    const isActive = todo.status === 'in_progress' || todo.status === 'active'
    const checkCls = isDone ? 'todo-check done' : isActive ? 'todo-check active' : 'todo-check'
    const checkIcon = isDone ? '✓' : isActive ? '◉' : '○'
    const textCls = isDone ? 'todo-text done' : isActive ? 'todo-text active' : 'todo-text'
    const content = todo.content || todo.title || todo.text || JSON.stringify(todo)
    const todoId = todo.id != null ? `<span class="todo-id">${esc(String(todo.id))}</span>` : ''
    itemsHtml += `<div class="todo-item ${isDone ? 'completed' : ''} ${isActive ? 'in-progress' : ''}">
      <span class="${checkCls}">${checkIcon}</span>
      ${todoId}
      <span class="${textCls}">${esc(content)}</span>
    </div>`
  }

  body.innerHTML = itemsHtml || '<div style="color:var(--muted);font-size:11px;padding:4px 8px">No items</div>'
}

function toggleTodoPanel() {
  const panel = document.getElementById('todoPanel')
  if (panel) panel.classList.toggle('collapsed')
}

function renderToolResult(content, isError=false) {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  const escaped = esc(text)
  const limit = 8000
  const cls = isError ? 'tool-result error' : 'tool-result'
  const icon = isError ? '✗' : '✓'
  const label = isError ? 'Error' : 'Output'
  if (escaped.length > limit) {
    const id = 'tr-' + Date.now() + Math.random().toString(36).slice(2,6)
    return `<div class="${cls}" id="${id}">
      <div class="tool-result-header"><span class="tool-result-icon ${isError?'error':''}">${icon}</span> ${label}</div>
      <div class="tool-result-body">${escaped.slice(0, limit)}<span class="tool-result-more" onclick="this.parentElement.innerHTML=window._toolResultFull['${id}'];delete window._toolResultFull['${id}']">… show all (${text.length} chars)</span></div>
    </div>`
      + `<script>if(!window._toolResultFull)window._toolResultFull={};window._toolResultFull['${id}']=\`${escaped.replace(/`/g,'\\`').replace(/<\/script/gi,'<\\/script')}\`</script>`
  }
  return `<div class="${cls}">
    <div class="tool-result-header"><span class="tool-result-icon ${isError?'error':''}">${icon}</span> ${label}</div>
    <div class="tool-result-body">${escaped}</div>
  </div>`
}

// ── task graph panel ──────────────────────────────────────────────────────────
let currentTaskGraph = null
let selectedTaskNodeId = null

async function loadTaskGraph() {
  if (!currentProject) return
  // Try to find a Tasks.md in the project
  const tasksPath = currentProject + '/tasks.md'
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
  renderTaskGraph(graph)
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
    return `<div class="tg-node" style="padding-left:${8 + indent}px" onclick="showTaskDetail('${id}')">
      <span class="tg-node-dot ${node.status}"></span>
      <span class="tg-node-id">${esc(id)}</span>
      <span class="tg-node-title">${esc(node.title)}</span>
    </div>`
  }).join('')
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
  content.innerHTML = `<div><strong>ID:</strong> ${esc(node.id)}</div>
    <div><strong>Title:</strong> ${esc(node.title)}</div>
    <div><strong>Status:</strong> <span class="tg-node-dot ${node.status}" style="display:inline-block;width:8px;height:8px;border-radius:50%;vertical-align:middle"></span> ${node.status}</div>
    <div><strong>Agent Type:</strong> ${node.metadata?.agentType || 'general'}</div>
    <div><strong>Dependencies:</strong> ${(node.dependencies||[]).join(', ') || 'none'}</div>`
}

async function taskGraphRun() {
  if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
  const tasksPath = currentProject + '/tasks.md'
  const result = await window.app.taskGraphExecute(tasksPath)
  if (result.error) { appendMsg('system', '❌ ' + result.error); return }
  document.getElementById('tgPauseBtn').style.display = 'inline-block'
  document.getElementById('tgAbortBtn').style.display = 'inline-block'
  document.getElementById('tgRunBtn').style.display = 'none'
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
    if (currentTaskGraph && currentTaskGraph.nodes[evt.nodeId]) {
      currentTaskGraph.nodes[evt.nodeId].status = evt.status
      renderTaskGraph(currentTaskGraph)
    }
  })
}

// ── background tasks panel ────────────────────────────────────────────────────
async function loadBackgroundTasks() {
  const tasks = await window.app.bgTaskList()
  if (tasks.error) return
  renderBackgroundTasks(tasks)
}

function renderBackgroundTasks(tasks) {
  const container = document.getElementById('bgTaskList')
  if (!tasks || !tasks.length) {
    container.innerHTML = '<div class="model-empty">No background tasks running.</div>'
    return
  }
  container.innerHTML = tasks.map(t => {
    const elapsed = t.endTime ? ((t.endTime - t.startTime) / 1000).toFixed(1) + 's' : formatElapsed(t.startTime)
    return `<div class="bg-task-card">
      <div class="bg-task-header">
        <span class="bg-task-status ${t.status}">${t.status}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.taskNode?.title || t.id)}</span>
        <span class="bg-task-elapsed">${elapsed}</span>
      </div>
      <div style="display:flex;gap:4px;margin-top:4px">
        ${t.status === 'running' ? `<button class="btn-sm" onclick="cancelBgTask('${t.id}')" style="font-size:10px;padding:2px 6px">Cancel</button>` : ''}
        ${t.output ? `<button class="btn-sm" onclick="viewBgTaskOutput('${t.id}')" style="font-size:10px;padding:2px 6px">View Output</button>` : ''}
      </div>
    </div>`
  }).join('')
}

function formatElapsed(startTime) {
  const s = Math.floor((Date.now() - startTime) / 1000)
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
}

async function cancelBgTask(taskId) {
  await window.app.bgTaskCancel(taskId)
  await loadBackgroundTasks()
}

async function viewBgTaskOutput(taskId) {
  const output = await window.app.bgTaskOutput(taskId)
  const viewer = document.getElementById('bgTaskOutputViewer')
  viewer.style.display = 'block'
  viewer.textContent = output || '(no output)'
}

// Listen for background task events
if (window.app.onBgTaskEvent) {
  window.app.onBgTaskEvent(() => { loadBackgroundTasks() })
}

// ── spec workflow panel ───────────────────────────────────────────────────────
let currentSpecDir = null

function updateSpecPhaseIndicator(currentPhase) {
  const phases = ['requirements', 'design', 'tasks', 'implementation']
  const badges = document.querySelectorAll('.spec-phase-badge')
  const currentIdx = phases.indexOf(currentPhase)
  badges.forEach(badge => {
    const phase = badge.dataset.phase
    const idx = phases.indexOf(phase)
    badge.className = 'spec-phase-badge'
    if (idx < currentIdx) badge.classList.add('completed')
    else if (idx === currentIdx) badge.classList.add('current')
    else badge.classList.add('future')
  })
}

async function specAdvancePhase() {
  if (!currentSpecDir) { appendMsg('system', '⚠️ No spec active.'); return }
  const newPhase = await window.app.specAdvance(currentSpecDir)
  if (newPhase.error) { appendMsg('system', '❌ ' + newPhase.error); return }
  updateSpecPhaseIndicator(newPhase)
}

async function createNewSpec() {
  const nameInput = document.getElementById('newSpecName')
  const name = (nameInput?.value || '').trim()
  if (!name) { appendMsg('system', '⚠️ Enter a feature name.'); return }
  if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
  const result = await window.app.specInit(name)
  if (result.error) { appendMsg('system', '❌ ' + result.error); return }
  currentSpecDir = result.specDir
  nameInput.value = ''
  updateSpecPhaseIndicator(result.currentPhase || 'requirements')
  document.getElementById('specEmpty').style.display = 'none'
  appendMsg('system', `📐 Spec "${name}" created.`)
}

async function loadSpecPanel() {
  if (!currentProject) return
  if (currentSpecDir) {
    const phase = await window.app.specPhase(currentSpecDir)
    if (!phase.error) updateSpecPhaseIndicator(phase)
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
  const label = status.backend === 'ast-grep' ? `🔍 ast-grep ${status.version || ''}` :
                status.backend === 'ripgrep' ? `🔍 ripgrep ${status.version || ''}` :
                '🔍 built-in (basic)'
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
  ['bg',     handleBgCommand],
  ['help',   handleHelpCommand],
])

// Command descriptions for help and autocomplete
const SLASH_COMMAND_INFO = [
  { command: 'spec',   description: 'Manage spec workflows — /spec <name> or /spec' },
  { command: 'search', description: 'AST code search — /search <pattern>' },
  { command: 'tasks',  description: 'Task graph control — /tasks [run|pause|resume]' },
  { command: 'bg',     description: 'Background tasks — /bg [list|cancel <id>]' },
  { command: 'help',   description: 'Show all available commands' },
]

// 10.2 — /spec command handler
async function handleSpecCommand(args) {
  if (args) {
    // 10.2.1 — /spec <name>: init spec, switch to specs panel, show confirmation
    if (!currentProject) { appendMsg('system', '⚠️ Open a project first.'); return }
    const result = await window.app.specInit(args)
    if (result.error) { appendMsg('system', '❌ ' + result.error); return }
    currentSpecDir = result.specDir
    updateSpecPhaseIndicator(result.currentPhase || 'requirements')
    showPanel('specs', document.querySelector('[data-panel="specs"]'))
    appendMsg('system', `📐 Spec "${esc(args)}" initialized. Phase: ${result.currentPhase || 'requirements'}`)
  } else {
    // 10.2.2 — /spec (no args): show current phase
    if (!currentSpecDir) { appendMsg('system', 'ℹ️ No spec active. Use /spec <name> to start one.'); return }
    const phase = await window.app.specPhase(currentSpecDir)
    if (phase.error) { appendMsg('system', '❌ ' + phase.error); return }
    appendMsg('system', `📐 Current spec phase: ${phase}`)
  }
}

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

// 10.5 — /bg command handler
async function handleBgCommand(args) {
  const parts = args.split(/\s+/)
  const sub = (parts[0] || '').toLowerCase()
  if (sub === 'cancel' && parts[1]) {
    // 10.5.2 — /bg cancel <id>
    await window.app.bgTaskCancel(parts[1])
    appendMsg('system', `🛑 Background task ${esc(parts[1])} cancelled.`)
  } else {
    // 10.5.1 — /bg or /bg list
    const tasks = await window.app.bgTaskList()
    if (tasks.error) { appendMsg('system', '❌ ' + tasks.error); return }
    if (!tasks || !tasks.length) { appendMsg('system', 'ℹ️ No background tasks.'); return }
    const lines = tasks.map(t => {
      const elapsed = t.endTime ? ((t.endTime - t.startTime) / 1000).toFixed(1) + 's' : formatElapsed(t.startTime)
      return `  ${t.status === 'running' ? '🔵' : t.status === 'completed' ? '🟢' : t.status === 'failed' ? '🔴' : '⚪'} ${esc(t.id)} — ${esc(t.taskNode?.title || 'task')} (${t.status}, ${elapsed})`
    })
    appendMsg('system', `⚡ Background tasks:\n${lines.join('\n')}`)
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

  const { state, inputTokens, outputTokens, tks, promptTps, peakMemory, toolName } = opts

  // Always show the stats bar when agent is active
  if (state === 'idle' && !inputTokens && !outputTokens) {
    bar.style.display = 'none'
    return
  }
  bar.style.display = 'flex'

  // State indicator chip
  const stateMap = {
    initializing: { icon: '⚡', text: 'Initializing', cls: '' },
    thinking:     { icon: '🧠', text: 'Thinking', cls: 'thinking' },
    generating:   { icon: '✍️', text: 'Generating', cls: 'generating' },
    processing:   { icon: '⚙️', text: 'Processing', cls: 'processing' },
    tool:         { icon: '🔧', text: toolName || 'Tool', cls: 'tool' },
    done:         { icon: '✅', text: 'Done', cls: 'done' },
  }
  const s = stateMap[state] || stateMap.done

  let html = `<div class="stat-chip state-chip ${s.cls}"><span class="stat-label">Status</span><span class="stat-val">${s.icon} ${s.text}</span></div>`

  // Input tokens
  html += `<div class="stat-chip"><span class="stat-label">Input</span><span class="stat-val">${inputTokens || 0} tok${promptTps != null ? ' · ' + promptTps + ' tk/s' : ''}</span></div>`

  // Output tokens
  const tksDisplay = tks != null && tks !== '—' ? ' · ' + tks + ' tk/s' : ''
  html += `<div class="stat-chip accent"><span class="stat-label">Output</span><span class="stat-val">${outputTokens || 0} tok${tksDisplay}</span></div>`

  // Peak memory if available
  if (peakMemory != null) {
    html += `<div class="stat-chip"><span class="stat-label">Peak VRAM</span><span class="stat-val">${peakMemory} GB</span></div>`
  }

  bar.innerHTML = html
}

// ── persistent bottom status bar ──────────────────────────────────────────────
function updateStatusBar(state, opts = {}) {
  const bar = document.getElementById('persistentStatusBar')
  if (!bar) return
  const modelEl = bar.querySelector('.psb-model')
  const stateEl = bar.querySelector('.psb-state')
  const statsEl = bar.querySelector('.psb-stats')

  // model name
  if (modelEl) modelEl.textContent = loadedModelId ? loadedModelId.split('/').pop() : 'No model'

  // state indicator
  const stateMap = {
    idle:         { icon: '⏸', text: 'Idle', cls: 'idle' },
    initializing: { icon: '⚡', text: 'Initializing...', cls: 'init' },
    thinking:     { icon: '🧠', text: 'Thinking...', cls: 'thinking' },
    generating:   { icon: '✍️', text: 'Generating...', cls: 'generating' },
    processing:   { icon: '⚙️', text: 'Processing...', cls: 'processing' },
    tool:         { icon: '🔧', text: `Tool: ${opts.toolName || ''}`, cls: 'tool' },
  }
  const s = stateMap[state] || stateMap.idle
  if (stateEl) {
    stateEl.className = 'psb-state ' + s.cls
    stateEl.innerHTML = `<span class="psb-state-dot ${s.cls}"></span>${s.icon} ${s.text}`
  }

  // live stats
  if (statsEl) {
    if (opts.tokens && opts.tks) {
      statsEl.textContent = `${opts.tokens} tok · ${opts.tks} tk/s`
      statsEl.style.display = ''
    } else if (state === 'idle') {
      statsEl.textContent = ''
      statsEl.style.display = 'none'
    }
  }
}

// Update model name in status bar when model changes
const _origSetLoadedModel = typeof setLoadedModel === 'function' ? setLoadedModel : null
if (_origSetLoadedModel) {
  // Monkey-patch to also update status bar
  const _realSetLoaded = setLoadedModel
  setLoadedModel = function(id) {
    _realSetLoaded(id)
    updateStatusBar('idle')
  }
}

// Init status bar on load
document.addEventListener('DOMContentLoaded', () => {
  updateStatusBar('idle')
})
