/**
 * Playwright browser automation — plain function interface.
 *
 * No SDK dependency. Each createPlaywrightInstance() returns an isolated
 * browser with execute(toolName, args) that the DirectBridge tool loop calls.
 *
 * Tools: browser_navigate, browser_screenshot, browser_click, browser_type,
 *        browser_get_text, browser_get_html, browser_evaluate, browser_wait_for,
 *        browser_select_option, browser_close
 */
'use strict'

function createPlaywrightInstance(options = {}) {
  let _browser = null
  let _context = null
  let _page = null
  let _recordingPath = null

  async function ensureBrowser() {
    if (_page && !_page.isClosed()) return _page
    const { chromium } = require('playwright')
    _browser = await chromium.launch({ headless: true })

    const { recordingOptions } = options
    const contextOptions = {
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    }

    if (recordingOptions) {
      const fs = require('node:fs')
      if (!fs.existsSync(recordingOptions.dir)) {
        fs.mkdirSync(recordingOptions.dir, { recursive: true })
      }
      contextOptions.recordVideo = {
        dir: recordingOptions.dir,
        size: recordingOptions.size || { width: 1280, height: 720 },
      }
    }

    try {
      _context = await _browser.newContext(contextOptions)
    } catch (err) {
      if (recordingOptions) {
        console.warn('[playwright-tool] Recording initialization failed, falling back to non-recording context:', err.message)
        delete contextOptions.recordVideo
        _context = await _browser.newContext(contextOptions)
        _recordingPath = null
      } else {
        throw err
      }
    }

    _page = await _context.newPage()
    _page.setDefaultTimeout(30000)
    return _page
  }

  async function closeBrowser() {
    if (_page && !_page.isClosed()) {
      try {
        const video = _page.video()
        if (video) _recordingPath = await video.path()
      } catch { /* no video */ }
    }
    if (_browser) {
      await _browser.close().catch(() => {})
      _browser = null; _context = null; _page = null
    }
  }

  function getRecordingPath() {
    return _recordingPath
  }

  // ── Tool implementations ──────────────────────────────────────────────────

  async function browser_navigate({ url }) {
    const page = await ensureBrowser()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const title = await page.title()
    const pageUrl = page.url()
    let snapshot = ''
    try {
      snapshot = await page.innerText('body')
      if (snapshot.length > 20000) snapshot = snapshot.slice(0, 20000) + '\n... [truncated]'
    } catch { snapshot = '[could not extract text]' }
    return `Navigated to: ${pageUrl}\nTitle: ${title}\n\n--- Page Text ---\n${snapshot}`
  }

  async function browser_screenshot({ selector, fullPage, prompt }) {
    const page = await ensureBrowser()
    // Coerce fullPage to boolean — the model sometimes sends "True"/"true" as a string
    const isFullPage = fullPage === true || fullPage === 'true' || fullPage === 'True'
    let buf
    if (selector) {
      const el = await page.$(selector)
      if (!el) return { error: `Element not found for selector "${selector}"` }
      buf = await el.screenshot({ type: 'png' })
    } else {
      buf = await page.screenshot({ type: 'png', fullPage: isFullPage })
    }

    // Convert to JPEG at 80% quality for vision analysis — keeps the payload
    // manageable (typically <500KB vs 2-3MB PNG) and avoids server timeouts.
    const sharp = (() => { try { return require('sharp') } catch { return null } })()
    let visionB64 = `data:image/png;base64,${buf.toString('base64')}`
    let visionMime = 'image/png'
    if (sharp) {
      try {
        const resized = await sharp(buf)
          .resize({ width: 1280, height: 960, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer()
        visionB64 = `data:image/jpeg;base64,${resized.toString('base64')}`
        visionMime = 'image/jpeg'
      } catch { /* fall back to original PNG */ }
    }

    // Full-res PNG for the renderer (displayed in chat)
    const displayB64 = `data:image/png;base64,${buf.toString('base64')}`

    // Send the resized screenshot through the vision endpoint for analysis
    const visionPrompt = prompt || 'Describe what you see on this web page screenshot in detail. Note any text, UI elements, layout, errors, or notable content.'
    const content = [
      { type: 'text', text: visionPrompt },
      { type: 'image_url', image_url: { url: visionB64 } },
    ]
    try {
      const http = require('http')
      const body = JSON.stringify({ messages: [{ role: 'user', content }], max_tokens: 1024, stream: false })
      const result = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port: 8090,
          path: '/v1/chat/completions', method: 'POST',
          timeout: 120000,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error(data.slice(0, 500) || 'Empty response')) } })
        })
        req.on('timeout', () => { req.destroy(); reject(new Error('Vision request timed out')) })
        req.on('error', reject)
        req.write(body)
        req.end()
      })
      const desc = result.choices?.[0]?.message?.content || result.error?.message || result.detail || `Could not analyze screenshot. Server response: ${JSON.stringify(result).slice(0, 200)}`
      return `[Screenshot captured, ${buf.length} bytes]\n\n![screenshot](${displayB64})\n\nVision analysis:\n${desc}`
    } catch (err) {
      return `[Screenshot captured, ${buf.length} bytes, but vision analysis failed: ${err.message}]\n\n![screenshot](${displayB64})`
    }
  }

  async function browser_click({ selector }) {
    const page = await ensureBrowser()
    await page.click(selector, { timeout: 10000 })
    return `Clicked "${selector}"`
  }

  async function browser_type({ selector, text, append, pressEnter }) {
    const page = await ensureBrowser()
    if (!append) await page.fill(selector, '')
    await page.type(selector, text)
    if (pressEnter) await page.press(selector, 'Enter')
    return `Typed into "${selector}"`
  }

  async function browser_get_text({ selector }) {
    const page = await ensureBrowser()
    let text
    if (selector) {
      const el = await page.$(selector)
      if (!el) return { error: `Element not found: "${selector}"` }
      text = await el.innerText()
    } else {
      text = await page.innerText('body')
    }
    if (text.length > 50000) text = text.slice(0, 50000) + '\n... [truncated]'
    return text
  }

  async function browser_get_html({ selector }) {
    const page = await ensureBrowser()
    let html
    if (selector) {
      const el = await page.$(selector)
      if (!el) return { error: `Element not found: "${selector}"` }
      html = await el.evaluate(e => e.outerHTML)
    } else {
      html = await page.content()
    }
    if (html.length > 100000) html = html.slice(0, 100000) + '\n<!-- truncated -->'
    return html
  }

  async function browser_evaluate({ script }) {
    const page = await ensureBrowser()
    const result = await page.evaluate(script)
    return JSON.stringify(result, null, 2) ?? 'undefined'
  }

  async function browser_wait_for({ selector, state, timeout, waitForNavigation }) {
    const page = await ensureBrowser()
    const ms = timeout || 30000
    if (waitForNavigation) {
      await page.waitForLoadState('domcontentloaded', { timeout: ms })
      return `Navigation complete: ${page.url()}`
    }
    if (!selector) return { error: 'Provide a selector or set waitForNavigation' }
    await page.waitForSelector(selector, { state: state || 'visible', timeout: ms })
    return `Element "${selector}" is ${state || 'visible'}`
  }

  async function browser_select_option({ selector, value }) {
    const page = await ensureBrowser()
    await page.selectOption(selector, value)
    return `Selected "${value}" in "${selector}"`
  }

  async function browser_close() {
    await closeBrowser()
    return 'Browser closed.'
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  const tools = {
    browser_navigate,
    browser_screenshot,
    browser_click,
    browser_type,
    browser_get_text,
    browser_get_html,
    browser_evaluate,
    browser_wait_for,
    browser_select_option,
    browser_close,
  }

  async function execute(toolName, args) {
    const fn = tools[toolName]
    if (!fn) return { error: `Unknown browser tool: ${toolName}` }
    try {
      const result = await fn(args || {})
      if (result && typeof result === 'object' && result.error) return result
      return { result: String(result) }
    } catch (err) {
      return { error: err.message || String(err) }
    }
  }

  return { execute, closeBrowser, getRecordingPath }
}

// ── Tool definitions for the OpenAI function-calling format ───────────────────

const BROWSER_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Navigate the browser to a URL. Returns the page title and visible text content.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The URL to navigate to' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current page or a specific element and analyze it with the vision model. Returns a text description of what is visible.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Optional CSS selector to screenshot a specific element' },
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default: false)' },
          prompt: { type: 'string', description: 'Optional question to ask about the screenshot (e.g. "Is there an error on this page?")' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element on the page by CSS selector.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS selector of the element to click' } },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input element. Clears the field first unless append is true.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the input element' },
          text: { type: 'string', description: 'Text to type' },
          append: { type: 'boolean', description: 'If true, append instead of clearing first' },
          pressEnter: { type: 'boolean', description: 'Press Enter after typing' },
        },
        required: ['selector', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_text',
      description: 'Extract visible text content from the page or a specific element.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS selector (omit for full page text)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_html',
      description: 'Get the HTML content of the page or a specific element.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string', description: 'CSS selector (omit for full page HTML)' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: 'Execute JavaScript in the browser page context and return the result.',
      parameters: {
        type: 'object',
        properties: { script: { type: 'string', description: 'JavaScript code to evaluate' } },
        required: ['script'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait_for',
      description: 'Wait for an element to appear or for navigation to complete.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for' },
          state: { type: 'string', description: 'Element state: visible, hidden, attached, detached' },
          timeout: { type: 'number', description: 'Max wait time in ms (default: 30000)' },
          waitForNavigation: { type: 'boolean', description: 'Wait for navigation instead of an element' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_select_option',
      description: 'Select an option from a <select> dropdown element.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the <select> element' },
          value: { type: 'string', description: 'The value attribute of the option to select' },
        },
        required: ['selector', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: 'Close the browser instance and free resources.',
      parameters: { type: 'object', properties: {} },
    },
  },
]

module.exports = { createPlaywrightInstance, BROWSER_TOOL_DEFS }
