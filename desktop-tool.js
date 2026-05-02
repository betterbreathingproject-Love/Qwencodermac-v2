/**
 * Desktop automation tools — mouse, keyboard, and screen capture.
 *
 * Wraps robotjs (mouse/keyboard) and screenshot-desktop (screen capture)
 * directly, following the same pattern as playwright-tool.js.
 *
 * Degrades gracefully if either native module is unavailable (e.g. not yet
 * installed or failed to build for the current Electron ABI).
 *
 * Tools: desktop_get_screen_size, desktop_screenshot, desktop_mouse_move,
 *        desktop_mouse_click, desktop_keyboard_type, desktop_keyboard_press
 */
'use strict'

// ── Optional native deps ──────────────────────────────────────────────────────

let robot = null
try {
  robot = require('robotjs')
} catch (_) {
  // robotjs not available — mouse/keyboard tools will return an error
}

let screenshotDesktop = null
try {
  screenshotDesktop = require('screenshot-desktop')
} catch (_) {
  // screenshot-desktop not available — screenshot tool will return an error
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _notAvailable(dep) {
  return {
    error: `${dep} is not installed. Run: npm install ${dep} --save`,
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function desktop_get_screen_size() {
  if (!robot) return _notAvailable('robotjs')
  const size = robot.getScreenSize()
  return { result: JSON.stringify(size) }
}

async function desktop_screenshot() {
  if (!screenshotDesktop) return _notAvailable('screenshot-desktop')
  try {
    // Returns a Buffer of PNG data
    const buf = await screenshotDesktop({ format: 'png' })

    // Optionally downscale with sharp to keep payload under 1 MB
    const sharp = (() => { try { return require('sharp') } catch { return null } })()
    let b64
    if (sharp) {
      try {
        const resized = await sharp(buf)
          .resize({ width: 1280, height: 800, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toBuffer()
        b64 = `data:image/jpeg;base64,${resized.toString('base64')}`
      } catch {
        b64 = `data:image/png;base64,${buf.toString('base64')}`
      }
    } else {
      b64 = `data:image/png;base64,${buf.toString('base64')}`
    }

    return { result: `[Desktop screenshot captured]\n\n![screenshot](${b64})` }
  } catch (err) {
    return { error: `Screenshot failed: ${err.message}` }
  }
}

async function desktop_mouse_move({ x, y }) {
  if (!robot) return _notAvailable('robotjs')
  if (typeof x !== 'number' || typeof y !== 'number') {
    return { error: 'x and y must be numbers' }
  }
  robot.moveMouse(Math.round(x), Math.round(y))
  return { result: `Mouse moved to (${Math.round(x)}, ${Math.round(y)})` }
}

async function desktop_mouse_click({ button = 'left', double = false }) {
  if (!robot) return _notAvailable('robotjs')
  const btn = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left'
  robot.mouseClick(btn, double === true || double === 'true')
  return { result: `Mouse ${double ? 'double-' : ''}clicked (${btn})` }
}

async function desktop_keyboard_type({ text }) {
  if (!robot) return _notAvailable('robotjs')
  if (typeof text !== 'string') return { error: 'text must be a string' }
  robot.typeString(text)
  return { result: `Typed: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}` }
}

async function desktop_keyboard_press({ key, modifiers = [] }) {
  if (!robot) return _notAvailable('robotjs')
  if (typeof key !== 'string' || !key) return { error: 'key must be a non-empty string' }

  // robotjs uses lowercase key names; normalise common aliases
  const normalised = key.toLowerCase()
    .replace(/^enter$/, 'return')
    .replace(/^ctrl$/, 'control')
    .replace(/^cmd$/, 'command')
    .replace(/^win$/, 'command')

  const mods = Array.isArray(modifiers)
    ? modifiers.map(m => String(m).toLowerCase().replace(/^ctrl$/, 'control').replace(/^cmd$/, 'command'))
    : []

  if (mods.length > 0) {
    robot.keyTap(normalised, mods)
  } else {
    robot.keyTap(normalised)
  }

  const modStr = mods.length > 0 ? `${mods.join('+')}+` : ''
  return { result: `Key pressed: ${modStr}${normalised}` }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

const _tools = {
  desktop_get_screen_size,
  desktop_screenshot,
  desktop_mouse_move,
  desktop_mouse_click,
  desktop_keyboard_type,
  desktop_keyboard_press,
}

async function executeDesktopTool(name, args) {
  const fn = _tools[name]
  if (!fn) return { error: `Unknown desktop tool: ${name}` }
  try {
    return await fn(args || {})
  } catch (err) {
    return { error: err.message || String(err) }
  }
}

// ── Tool definitions (OpenAI function-calling format) ─────────────────────────

const DESKTOP_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'desktop_get_screen_size',
      description: 'Get the screen dimensions (width and height in pixels).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_screenshot',
      description: 'Capture a screenshot of the entire desktop. Returns the image inline so the vision model can analyse it.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_mouse_move',
      description: 'Move the mouse cursor to the specified screen coordinates.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate (pixels from left)' },
          y: { type: 'number', description: 'Y coordinate (pixels from top)' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_mouse_click',
      description: 'Click the mouse at the current cursor position.',
      parameters: {
        type: 'object',
        properties: {
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
            description: 'Mouse button to click (default: left)',
          },
          double: {
            type: 'boolean',
            description: 'Perform a double-click (default: false)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_keyboard_type',
      description: 'Type a string of text at the current cursor position.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_keyboard_press',
      description: 'Press a keyboard key, optionally with modifier keys held.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: "Key to press (e.g. 'return', 'tab', 'escape', 'a', 'f5'). Use lowercase.",
          },
          modifiers: {
            type: 'array',
            items: { type: 'string' },
            description: "Modifier keys to hold: 'command', 'control', 'shift', 'alt'",
          },
        },
        required: ['key'],
      },
    },
  },
]

module.exports = { DESKTOP_TOOL_DEFS, executeDesktopTool }
