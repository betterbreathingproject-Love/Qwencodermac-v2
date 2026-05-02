'use strict'
/**
 * Terminal UI — two-tab panel:
 *   • Agent tab  — live stream of agent activity (tool calls, bash output, thinking)
 *   • Shell tab  — interactive PTY session backed by node-pty
 *
 * Loaded by renderer/index.html as a <script> tag.
 * All functions are global (vanilla JS, no framework).
 */

// ── State ─────────────────────────────────────────────────────────────────────
let _termSessionId  = null
let _termCollapsed  = false
let _termBuffer     = ''          // raw PTY output buffer
let _termActiveTab  = 'agent'     // 'agent' | 'shell'
const _TERM_MAX_BUFFER = 128 * 1024

// Agent log state
let _agentLogEntries = []         // array of rendered row HTML strings
let _agentRunning    = false
let _agentLastBashRow = null      // DOM element of the last bash row (for live update)
let _agentRenderPending = false
let _agentToolMap    = new Map()  // tool_use_id → { name, row } for result correlation

// ── DOM refs (resolved lazily) ────────────────────────────────────────────────
function _termPanel()       { return document.getElementById('terminalPanel') }
function _termBody()        { return document.getElementById('terminalBody') }
function _termScreen()      { return document.getElementById('terminalScreen') }
function _termEmpty()       { return document.getElementById('terminalEmpty') }
function _termHandle()      { return document.getElementById('terminalResizeHandle') }
function _agentPane()       { return document.getElementById('terminalAgentPane') }
function _agentLog()        { return document.getElementById('terminalAgentLog') }
function _agentEmpty()      { return document.getElementById('terminalAgentEmpty') }
function _shellPane()       { return document.getElementById('terminalShellPane') }
function _tabAgent()        { return document.getElementById('termTabAgent') }
function _tabShell()        { return document.getElementById('termTabShell') }

// ── Tab switching ─────────────────────────────────────────────────────────────

/** Switch between 'agent' and 'shell' tabs. */
function terminalSwitchTab(tab) {
  _termActiveTab = tab

  const agentPane = _agentPane()
  const shellPane = _shellPane()
  const tabAgent  = _tabAgent()
  const tabShell  = _tabShell()
  const closeBtn  = document.getElementById('termCloseBtn')

  if (tab === 'agent') {
    if (agentPane) agentPane.style.display = ''
    if (shellPane) shellPane.style.display = 'none'
    if (tabAgent)  { tabAgent.classList.add('active'); tabAgent.classList.remove('has-activity') }
    if (tabShell)  tabShell.classList.remove('active')
    if (closeBtn)  closeBtn.style.display = 'none'
  } else {
    if (agentPane) agentPane.style.display = 'none'
    if (shellPane) shellPane.style.display = ''
    if (tabAgent)  tabAgent.classList.remove('active')
    if (tabShell)  { tabShell.classList.add('active'); tabShell.classList.remove('has-activity') }
    if (closeBtn)  closeBtn.style.display = _termSessionId ? '' : 'none'
    // Focus the PTY screen if a session is active
    if (_termSessionId) _termFocusScreen()
  }
}

// ── Shell lifecycle ───────────────────────────────────────────────────────────

/** Create a new PTY session and show the shell tab. */
async function terminalNew() {
  // Close any existing session first
  if (_termSessionId) {
    try { await window.app.terminalClose(_termSessionId) } catch (_) {}
    _termSessionId = null
    _termBuffer = ''
  }

  const cwd = window._currentProjectDir || undefined
  let result
  try {
    result = await window.app.terminalCreate({ cwd })
  } catch (err) {
    console.warn('[terminal-ui] terminalCreate threw:', err)
    return
  }
  if (!result || result.error) {
    console.warn('[terminal-ui] create failed:', result?.error)
    return
  }

  _termSessionId = result.id
  _termBuffer = ''

  // Make sure shell pane is visible before showing the screen
  terminalSwitchTab('shell')
  _termShowScreen()
  if (_termCollapsed) terminalToggle()
  _termFocusScreen()

  const closeBtn = document.getElementById('termCloseBtn')
  if (closeBtn) closeBtn.style.display = ''
}

/** Close the active PTY session. */
async function terminalCloseActive() {
  if (!_termSessionId) return
  await window.app.terminalClose(_termSessionId)
  _termSessionId = null
  _termBuffer = ''
  _termHideScreen()
  const closeBtn = document.getElementById('termCloseBtn')
  if (closeBtn) closeBtn.style.display = 'none'
}

/** Toggle collapsed/expanded state. */
function terminalToggle() {
  const panel = _termPanel()
  if (!panel) return
  _termCollapsed = !_termCollapsed
  panel.classList.toggle('collapsed', _termCollapsed)
  const btn = document.getElementById('termToggleBtn')
  if (btn) btn.textContent = _termCollapsed ? '▲' : '▼'
}

// ── Shell display helpers ─────────────────────────────────────────────────────

function _termShowScreen() {
  const screen = _termScreen()
  const empty  = _termEmpty()
  if (screen) screen.style.display = ''
  if (empty)  empty.style.display = 'none'
}

function _termHideScreen() {
  const screen = _termScreen()
  const empty  = _termEmpty()
  if (screen) { screen.style.display = 'none'; screen.innerHTML = '' }
  if (empty)  empty.style.display = ''
}

function _termFocusScreen() {
  const screen = _termScreen()
  if (screen) screen.focus()
}

/**
 * Render raw PTY output into the shell screen element.
 * Lightweight ANSI parser — handles colors and basic control sequences.
 */
function _termRender() {
  const screen = _termScreen()
  if (!screen) return
  screen.innerHTML = _ansiToHtml(_termBuffer)
  screen.scrollTop = screen.scrollHeight
}

/**
 * Minimal ANSI → HTML converter.
 * Handles SGR color codes (30-37, 90-97 foreground) and bold/dim.
 * Strips cursor movement, erase, and other control sequences.
 */
function _ansiToHtml(text) {
  let cleaned = text.replace(/\x1b\[[0-9;]*[A-HJKSTfhlm]/g, (match) => {
    if (match.endsWith('m')) return match
    return ''
  })
  cleaned = cleaned.replace(/\x1b\][^\x07]*\x07/g, '')
  cleaned = cleaned.replace(/\x1b\][^\x1b]*\x1b\\/g, '')
  cleaned = cleaned.replace(/\x1b[^[]/g, '')

  const FG_MAP = {
    '30': 'term-fg-black',   '31': 'term-fg-red',     '32': 'term-fg-green',
    '33': 'term-fg-yellow',  '34': 'term-fg-blue',    '35': 'term-fg-magenta',
    '36': 'term-fg-cyan',    '37': 'term-fg-white',
    '90': 'term-fg-black',   '91': 'term-fg-red',     '92': 'term-fg-green',
    '93': 'term-fg-yellow',  '94': 'term-fg-blue',    '95': 'term-fg-magenta',
    '96': 'term-fg-cyan',    '97': 'term-fg-white',
  }

  let result = ''
  let openSpans = 0
  const parts = cleaned.split(/\x1b\[/)

  for (let i = 0; i < parts.length; i++) {
    let part = parts[i]
    if (i === 0) { result += _escapeHtml(part); continue }

    const sgrMatch = part.match(/^([0-9;]*)m(.*)$/s)
    if (!sgrMatch) { result += _escapeHtml(part); continue }

    const codes = sgrMatch[1].split(';').filter(Boolean)
    const txt   = sgrMatch[2]

    if (codes.includes('0') || codes.length === 0) {
      while (openSpans > 0) { result += '</span>'; openSpans-- }
    }

    const classes = []
    for (const code of codes) {
      if (code === '0') continue
      if (code === '1') classes.push('term-bold')
      if (code === '2') classes.push('term-dim')
      if (FG_MAP[code]) classes.push(FG_MAP[code])
    }

    if (classes.length > 0) { result += `<span class="${classes.join(' ')}">`;  openSpans++ }
    result += _escapeHtml(txt)
  }

  while (openSpans > 0) { result += '</span>'; openSpans-- }
  return result
}

function _escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ── Keyboard input (shell tab) ────────────────────────────────────────────────

function _termHandleKeydown(e) {
  if (!_termSessionId) return
  e.preventDefault()
  e.stopPropagation()

  let data = ''
  if (e.key === 'Enter')           data = '\r'
  else if (e.key === 'Backspace')  data = '\x7f'
  else if (e.key === 'Tab')        data = '\t'
  else if (e.key === 'Escape')     data = '\x1b'
  else if (e.key === 'ArrowUp')    data = '\x1b[A'
  else if (e.key === 'ArrowDown')  data = '\x1b[B'
  else if (e.key === 'ArrowRight') data = '\x1b[C'
  else if (e.key === 'ArrowLeft')  data = '\x1b[D'
  else if (e.key === 'Home')       data = '\x1b[H'
  else if (e.key === 'End')        data = '\x1b[F'
  else if (e.key === 'Delete')     data = '\x1b[3~'
  else if (e.ctrlKey && e.key === 'c') data = '\x03'
  else if (e.ctrlKey && e.key === 'd') data = '\x04'
  else if (e.ctrlKey && e.key === 'z') data = '\x1a'
  else if (e.ctrlKey && e.key === 'l') data = '\x0c'
  else if (e.ctrlKey && e.key === 'a') data = '\x01'
  else if (e.ctrlKey && e.key === 'e') data = '\x05'
  else if (e.ctrlKey && e.key === 'k') data = '\x0b'
  else if (e.ctrlKey && e.key === 'u') data = '\x15'
  else if (e.ctrlKey && e.key === 'w') data = '\x17'
  else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) data = e.key

  if (data) window.app.terminalWrite(_termSessionId, data)
}

function _termHandlePaste(e) {
  if (!_termSessionId) return
  e.preventDefault()
  const text = (e.clipboardData || window.clipboardData).getData('text')
  if (text) window.app.terminalWrite(_termSessionId, text)
}

// ── Resize drag ───────────────────────────────────────────────────────────────

function _initTerminalResize() {
  const handle = _termHandle()
  if (!handle) return

  let startY = 0
  let startHeight = 0

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const panel = _termPanel()
    if (!panel || _termCollapsed) return
    startY = e.clientY
    startHeight = panel.offsetHeight
    handle.classList.add('dragging')
    document.addEventListener('mousemove', onDrag)
    document.addEventListener('mouseup', onDragEnd)
  })

  function onDrag(e) {
    const panel = _termPanel()
    if (!panel) return
    const delta = startY - e.clientY
    const newHeight = Math.max(80, Math.min(window.innerHeight * 0.6, startHeight + delta))
    panel.style.height = newHeight + 'px'
  }

  function onDragEnd() {
    const handle = _termHandle()
    if (handle) handle.classList.remove('dragging')
    document.removeEventListener('mousemove', onDrag)
    document.removeEventListener('mouseup', onDragEnd)
  }
}

// ── Agent log helpers ─────────────────────────────────────────────────────────

/** Clear the agent activity log. */
function terminalClearAgent() {
  _agentLogEntries = []
  _agentLastBashRow = null
  _agentToolMap.clear()
  const log   = _agentLog()
  const empty = _agentEmpty()
  if (log)   { log.innerHTML = ''; log.style.display = 'none' }
  if (empty) empty.style.display = ''
}

/**
 * Append a row to the agent log.
 * @param {'tool'|'bash'|'result'|'system'|'error'|'text'|'thinking'} type
 * @param {string} icon
 * @param {string} label
 * @param {string} content  — already-escaped HTML
 * @returns {HTMLElement} the created row element
 */
function _agentAppendRow(type, icon, label, content) {
  const log   = _agentLog()
  const empty = _agentEmpty()
  if (!log) return null

  // Show log, hide empty state
  if (log.style.display === 'none') {
    log.style.display = ''
    if (empty) empty.style.display = 'none'
  }

  const row = document.createElement('div')
  row.className = `term-agent-row row-${type}`
  row.innerHTML =
    `<span class="term-agent-icon">${icon}</span>` +
    `<span class="term-agent-content">` +
      (label ? `<span class="term-agent-label">${_escapeHtml(label)}</span>` : '') +
      content +
    `</span>`

  log.appendChild(row)

  // Auto-scroll if near bottom (within 60px)
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60
  if (atBottom) log.scrollTop = log.scrollHeight

  // Dot indicator on the tab when not active
  if (_termActiveTab !== 'agent') {
    const tab = _tabAgent()
    if (tab) tab.classList.add('has-activity')
  }

  return row
}

/** Add a session separator line. */
function _agentAddSeparator(label) {
  const log = _agentLog()
  const empty = _agentEmpty()
  if (!log) return
  if (log.style.display === 'none') {
    log.style.display = ''
    if (empty) empty.style.display = 'none'
  }
  const sep = document.createElement('div')
  sep.className = 'term-agent-separator'
  sep.textContent = label || 'New session'
  log.appendChild(sep)
  log.scrollTop = log.scrollHeight
}

/**
 * Handle a qwen-event and render it into the agent log.
 * Called from app.js (or directly from the IPC listener below).
 */
function terminalHandleAgentEvent(ev) {
  if (!ev || !ev.type) return

  switch (ev.type) {
    case 'session-start': {
      _agentRunning = true
      _agentLastBashRow = null
      const cwd = ev.cwd ? ev.cwd.replace(/^.*\/([^/]+)$/, '$1') : ''
      _agentAddSeparator(cwd ? `▶ Session — ${cwd}` : '▶ New session')
      // Auto-switch to agent tab and uncollapse
      if (_termCollapsed) terminalToggle()
      terminalSwitchTab('agent')
      break
    }

    case 'session-end': {
      _agentRunning = false
      _agentLastBashRow = null
      break
    }

    case 'tool-use': {
      const name = ev.name || '?'
      const args = ev.input || ev.args || {}
      // For bash/run_command, show the command prominently
      if (name === 'bash' || name === 'run_command' || name === 'execute_command') {
        const cmd = args.command || args.cmd || ''
        const row = _agentAppendRow(
          'bash', '⚡', 'bash',
          `<span class="term-fg-cyan">${_escapeHtml(cmd.slice(0, 300))}</span>` +
          (cmd.length > 300 ? '<span class="term-dim">…</span>' : '')
        )
        _agentLastBashRow = row
        if (ev.id) _agentToolMap.set(ev.id, { name, row })
      } else if (name === 'write_file' || name === 'create_file' || name === 'edit_file' || name === 'edit_files' || name === 'str_replace') {
        const filePath = args.path || args.file_path || args.target_file || ''
        const row = _agentAppendRow(
          'tool', '✏️', name,
          `<span class="term-fg-yellow">${_escapeHtml(filePath || JSON.stringify(args).slice(0, 120))}</span>`
        )
        if (ev.id) _agentToolMap.set(ev.id, { name, row })
      } else if (name === 'read_file' || name === 'read_files' || name === 'view_file') {
        const filePath = args.path || (Array.isArray(args.paths) ? args.paths.join(', ') : '') || ''
        const row = _agentAppendRow(
          'tool', '📄', name,
          `<span class="term-fg-blue">${_escapeHtml(filePath.slice(0, 200))}</span>`
        )
        if (ev.id) _agentToolMap.set(ev.id, { name, row })
      } else if (name === 'search_files' || name === 'grep_search' || name === 'file_search') {
        const q = args.pattern || args.query || args.search_term || ''
        const row = _agentAppendRow(
          'tool', '🔍', name,
          `<span class="term-fg-magenta">${_escapeHtml(q.slice(0, 120))}</span>`
        )
        if (ev.id) _agentToolMap.set(ev.id, { name, row })
      } else if (name === 'list_dir') {
        const p = args.path || '.'
        const row = _agentAppendRow(
          'tool', '📁', name,
          `<span class="term-fg-blue">${_escapeHtml(p)}</span>`
        )
        if (ev.id) _agentToolMap.set(ev.id, { name, row })
      } else {
        // Generic tool
        const argsStr = JSON.stringify(args)
        const row = _agentAppendRow(
          'tool', '🔧', name,
          `<span class="term-dim">${_escapeHtml(argsStr.slice(0, 160))}</span>`
        )
        if (ev.id) _agentToolMap.set(ev.id, { name, row })
      }
      break
    }

    case 'tool-result': {
      // Look up the tool name from the ID map
      const toolEntry = ev.tool_use_id ? _agentToolMap.get(ev.tool_use_id) : null
      const toolName  = toolEntry?.name || ''
      const isBash = toolName === 'bash' || toolName === 'run_command' || toolName === 'execute_command'
      const bashRow = toolEntry?.row || _agentLastBashRow

      if (isBash && bashRow) {
        const output = typeof ev.content === 'string' ? ev.content
          : JSON.stringify(ev.content || '')
        const trimmed = output.trim().slice(0, 2000)
        if (trimmed) {
          const outputEl = document.createElement('span')
          outputEl.className = 'term-bash-output'
          outputEl.textContent = trimmed + (output.length > 2000 ? '\n…(truncated)' : '')
          const content = bashRow.querySelector('.term-agent-content')
          if (content) content.appendChild(outputEl)
          const log = _agentLog()
          if (log) {
            const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80
            if (atBottom) log.scrollTop = log.scrollHeight
          }
        }
        if (ev.tool_use_id) _agentToolMap.delete(ev.tool_use_id)
        if (bashRow === _agentLastBashRow) _agentLastBashRow = null
      } else if (ev.is_error) {
        const msg = typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content || '')
        _agentAppendRow(
          'error', '✖', toolName || 'error',
          `<span class="term-fg-red">${_escapeHtml(msg.slice(0, 300))}</span>`
        )
        if (ev.tool_use_id) _agentToolMap.delete(ev.tool_use_id)
      } else {
        if (ev.tool_use_id) _agentToolMap.delete(ev.tool_use_id)
      }
      break
    }

    case 'system': {
      const msg = ev.data || ev.message || ''
      if (!msg) break
      // Skip very noisy debug messages
      if (ev.subtype === 'debug' && msg.length < 4) break
      _agentAppendRow(
        'system', '·', '',
        `<span class="term-dim">${_escapeHtml(String(msg).slice(0, 300))}</span>`
      )
      break
    }

    case 'error': {
      const msg = ev.error || ev.message || 'Unknown error'
      _agentAppendRow(
        'error', '✖', 'error',
        `<span class="term-fg-red">${_escapeHtml(String(msg).slice(0, 400))}</span>`
      )
      break
    }

    case 'thinking-delta': {
      // Only show thinking when it changes significantly — debounce via last row update
      if (!_agentRenderPending) {
        _agentRenderPending = true
        requestAnimationFrame(() => {
          _agentRenderPending = false
          // Thinking is shown as a single updating row; find or create it
          const log = _agentLog()
          if (!log) return
          let thinkRow = log.querySelector('.term-thinking-live')
          if (!thinkRow) {
            thinkRow = document.createElement('div')
            thinkRow.className = 'term-agent-row row-thinking term-thinking-live'
            thinkRow.innerHTML =
              `<span class="term-agent-icon">💭</span>` +
              `<span class="term-agent-content">` +
                `<span class="term-agent-label">thinking</span>` +
                `<span class="term-thinking-text term-dim"></span>` +
              `</span>`
            log.appendChild(thinkRow)
          }
          const textEl = thinkRow.querySelector('.term-thinking-text')
          if (textEl) {
            const t = ev.text || ''
            textEl.textContent = t.slice(-300)
          }
          const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60
          if (atBottom) log.scrollTop = log.scrollHeight
        })
      }
      break
    }

    case 'text-delta': {
      // Only show the first few chars of text output as a "writing" indicator
      // (full text is in the chat panel — no need to duplicate it here)
      const log = _agentLog()
      if (!log) break
      // Remove any live thinking row when text starts
      const thinkRow = log.querySelector('.term-thinking-live')
      if (thinkRow) thinkRow.remove()
      break
    }

    case 'lsp-activity': {
      const action = ev.action || ''
      const file   = ev.path ? ev.path.replace(/^.*\/([^/]+)$/, '$1') : ''
      const count  = ev.count != null ? ` (${ev.count})` : ''
      _agentAppendRow(
        'system', '🔬', 'lsp',
        `<span class="term-dim">${_escapeHtml(action)}${file ? ' · ' + _escapeHtml(file) : ''}${count}</span>`
      )
      break
    }

    case 'bash-waiting': {
      const cmd = ev.command || ''
      const elapsed = ev.elapsedSecs != null ? ` (${ev.elapsedSecs}s)` : ev.elapsed ? ` (${Math.round(ev.elapsed / 1000)}s)` : ''
      _agentAppendRow(
        'bash', '⏳', 'waiting',
        `<span class="term-fg-yellow">${_escapeHtml(cmd.slice(0, 200))}${elapsed}</span>`
      )
      break
    }

    default:
      break
  }
}

// ── IPC event listeners ───────────────────────────────────────────────────────

function _initTerminalEvents() {
  // ── PTY output ──
  window.app.onTerminalOutput((msg) => {
    if (msg.id !== _termSessionId) return
    _termBuffer += msg.data
    if (_termBuffer.length > _TERM_MAX_BUFFER) {
      _termBuffer = _termBuffer.slice(-_TERM_MAX_BUFFER)
    }
    _termRender()
    // Dot on shell tab when not active
    if (_termActiveTab !== 'shell') {
      const tab = _tabShell()
      if (tab) tab.classList.add('has-activity')
    }
  })

  // ── PTY exited ──
  window.app.onTerminalExit((msg) => {
    if (msg.id !== _termSessionId) return
    _termBuffer += `\r\n[Process exited with code ${msg.exitCode}]\r\n`
    _termRender()
    _termSessionId = null
    const closeBtn = document.getElementById('termCloseBtn')
    if (closeBtn) closeBtn.style.display = 'none'
  })

  // ── Agent routed interactive command here ──
  window.app.onTerminalFocus(async (msg) => {
    if (!_termSessionId || _termSessionId !== msg.id) {
      _termSessionId = msg.id
      _termBuffer = ''
      _termShowScreen()
    }
    if (_termCollapsed) terminalToggle()
    // Switch to shell tab so user can interact
    terminalSwitchTab('shell')
    _termFocusScreen()

    // Switch to Preview tab if not already there
    const previewTab = document.querySelector('.ed-tab[data-tab="agent"]')
    if (previewTab && !previewTab.classList.contains('active')) {
      if (typeof switchMainTab === 'function') switchMainTab('agent', previewTab)
    }

    // Flash the terminal header
    const panel = _termPanel()
    if (panel) {
      panel.classList.add('focused')
      setTimeout(() => panel.classList.remove('focused'), 3000)
    }
  })

  // ── Agent events → agent log ──
  // app.js calls terminalHandleAgentEvent() directly from its onQwenEvent handlers.
}

// ── Init on DOM ready ─────────────────────────────────────────────────────────

function _initTerminal() {
  const screen = _termScreen()
  if (screen) {
    screen.addEventListener('keydown', _termHandleKeydown)
    screen.addEventListener('paste', _termHandlePaste)
  }
  _initTerminalResize()
  _initTerminalEvents()
  // Start on agent tab, show correct buttons
  terminalSwitchTab('agent')
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initTerminal)
} else {
  _initTerminal()
}
