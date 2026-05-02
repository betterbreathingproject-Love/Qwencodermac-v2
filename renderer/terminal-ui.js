/**
 * Terminal UI — connects the terminal panel in the preview area to the
 * node-pty backend via IPC. Handles keyboard input, ANSI rendering,
 * resize dragging, and auto-focus when the agent routes a command here.
 *
 * Loaded by renderer/index.html as a <script> tag.
 * All functions are global (vanilla JS, no framework).
 */

// ── State ─────────────────────────────────────────────────────────────────────
let _termSessionId = null
let _termCollapsed = false
let _termBuffer = ''       // raw output buffer for the active session
const _TERM_MAX_BUFFER = 128 * 1024  // 128KB display buffer

// ── DOM refs (resolved lazily) ────────────────────────────────────────────────
function _termPanel()  { return document.getElementById('terminalPanel') }
function _termBody()   { return document.getElementById('terminalBody') }
function _termScreen() { return document.getElementById('terminalScreen') }
function _termEmpty()  { return document.getElementById('terminalEmpty') }
function _termHandle() { return document.getElementById('terminalResizeHandle') }

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/** Create a new terminal session and show it. */
async function terminalNew() {
  const cwd = window._currentProjectDir || undefined
  const result = await window.app.terminalCreate({ cwd })
  if (result.error) {
    console.warn('[terminal-ui] create failed:', result.error)
    return
  }
  _termSessionId = result.id
  _termBuffer = ''
  _termShowScreen()
  _termFocusScreen()

  // Uncollapse if collapsed
  if (_termCollapsed) terminalToggle()
}

/** Close the active terminal session. */
async function terminalCloseActive() {
  if (!_termSessionId) return
  await window.app.terminalClose(_termSessionId)
  _termSessionId = null
  _termBuffer = ''
  _termHideScreen()
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

// ── Display helpers ───────────────────────────────────────────────────────────

function _termShowScreen() {
  const screen = _termScreen()
  const empty = _termEmpty()
  if (screen) screen.style.display = ''
  if (empty) empty.style.display = 'none'
}

function _termHideScreen() {
  const screen = _termScreen()
  const empty = _termEmpty()
  if (screen) { screen.style.display = 'none'; screen.innerHTML = '' }
  if (empty) empty.style.display = ''
}

function _termFocusScreen() {
  const screen = _termScreen()
  if (screen) screen.focus()
}

/**
 * Render raw terminal output into the screen element.
 * Uses a lightweight ANSI parser — enough for prompts, colors, and basic
 * cursor movement. Not a full VT100 emulator, but handles the common cases.
 */
function _termRender() {
  const screen = _termScreen()
  if (!screen) return

  // Strip most ANSI escape sequences for display, keep color codes
  const html = _ansiToHtml(_termBuffer)
  screen.innerHTML = html

  // Auto-scroll to bottom
  screen.scrollTop = screen.scrollHeight
}

/**
 * Minimal ANSI → HTML converter.
 * Handles SGR color codes (30-37, 90-97 foreground) and bold/dim.
 * Strips cursor movement, erase, and other control sequences.
 */
function _ansiToHtml(text) {
  // Strip non-SGR escape sequences (cursor movement, erase, etc.)
  let cleaned = text.replace(/\x1b\[[0-9;]*[A-HJKSTfhlm]/g, (match) => {
    // Keep SGR (ends with 'm'), strip everything else
    if (match.endsWith('m')) return match
    return ''
  })
  // Also strip OSC sequences (title changes etc.)
  cleaned = cleaned.replace(/\x1b\][^\x07]*\x07/g, '')
  cleaned = cleaned.replace(/\x1b\][^\x1b]*\x1b\\/g, '')
  // Strip remaining bare ESC sequences
  cleaned = cleaned.replace(/\x1b[^[]/g, '')

  const FG_MAP = {
    '30': 'term-fg-black', '31': 'term-fg-red', '32': 'term-fg-green',
    '33': 'term-fg-yellow', '34': 'term-fg-blue', '35': 'term-fg-magenta',
    '36': 'term-fg-cyan', '37': 'term-fg-white',
    '90': 'term-fg-black', '91': 'term-fg-red', '92': 'term-fg-green',
    '93': 'term-fg-yellow', '94': 'term-fg-blue', '95': 'term-fg-magenta',
    '96': 'term-fg-cyan', '97': 'term-fg-white',
  }

  let result = ''
  let openSpans = 0
  const parts = cleaned.split(/\x1b\[/)

  for (let i = 0; i < parts.length; i++) {
    let part = parts[i]
    if (i === 0) {
      // Text before any escape sequence
      result += _escapeHtml(part)
      continue
    }

    // Parse SGR parameters
    const sgrMatch = part.match(/^([0-9;]*)m(.*)$/s)
    if (!sgrMatch) {
      result += _escapeHtml(part)
      continue
    }

    const codes = sgrMatch[1].split(';').filter(Boolean)
    const text = sgrMatch[2]

    // Close previous spans on reset
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

    if (classes.length > 0) {
      result += `<span class="${classes.join(' ')}">`
      openSpans++
    }

    result += _escapeHtml(text)
  }

  // Close any remaining open spans
  while (openSpans > 0) { result += '</span>'; openSpans-- }

  return result
}

function _escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// ── Keyboard input ────────────────────────────────────────────────────────────

function _termHandleKeydown(e) {
  if (!_termSessionId) return
  e.preventDefault()
  e.stopPropagation()

  let data = ''

  if (e.key === 'Enter') data = '\r'
  else if (e.key === 'Backspace') data = '\x7f'
  else if (e.key === 'Tab') data = '\t'
  else if (e.key === 'Escape') data = '\x1b'
  else if (e.key === 'ArrowUp') data = '\x1b[A'
  else if (e.key === 'ArrowDown') data = '\x1b[B'
  else if (e.key === 'ArrowRight') data = '\x1b[C'
  else if (e.key === 'ArrowLeft') data = '\x1b[D'
  else if (e.key === 'Home') data = '\x1b[H'
  else if (e.key === 'End') data = '\x1b[F'
  else if (e.key === 'Delete') data = '\x1b[3~'
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

  if (data) {
    window.app.terminalWrite(_termSessionId, data)
  }
}

// Also handle paste
function _termHandlePaste(e) {
  if (!_termSessionId) return
  e.preventDefault()
  const text = (e.clipboardData || window.clipboardData).getData('text')
  if (text) {
    window.app.terminalWrite(_termSessionId, text)
  }
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
    // Dragging up = larger terminal (startY - e.clientY is positive)
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

// ── IPC event listeners ───────────────────────────────────────────────────────

function _initTerminalEvents() {
  // Output from PTY
  window.app.onTerminalOutput((msg) => {
    if (msg.id !== _termSessionId) return
    _termBuffer += msg.data
    // Trim buffer if too large
    if (_termBuffer.length > _TERM_MAX_BUFFER) {
      _termBuffer = _termBuffer.slice(-_TERM_MAX_BUFFER)
    }
    _termRender()
  })

  // Terminal exited
  window.app.onTerminalExit((msg) => {
    if (msg.id !== _termSessionId) return
    _termBuffer += `\r\n[Process exited with code ${msg.exitCode}]\r\n`
    _termRender()
    _termSessionId = null
  })

  // Agent requested terminal focus (interactive command routed here)
  window.app.onTerminalFocus(async (msg) => {
    // If no session, the backend already created one — just adopt it
    if (!_termSessionId || _termSessionId !== msg.id) {
      _termSessionId = msg.id
      _termBuffer = ''
      _termShowScreen()
    }
    // Uncollapse and focus
    if (_termCollapsed) terminalToggle()
    _termFocusScreen()

    // Switch to Preview tab if not already there
    const previewTab = document.querySelector('.ed-tab[data-tab="agent"]')
    if (previewTab && !previewTab.classList.contains('active')) {
      switchMainTab('agent', previewTab)
    }

    // Flash the terminal header to draw attention
    const panel = _termPanel()
    if (panel) {
      panel.classList.add('focused')
      setTimeout(() => panel.classList.remove('focused'), 3000)
    }
  })
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
}

// Called from app.js or inline after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initTerminal)
} else {
  _initTerminal()
}
