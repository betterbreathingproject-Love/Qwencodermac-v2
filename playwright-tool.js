/**
 * Playwright browser automation tool for the Qwen Code agent.
 * Registers as an SDK MCP server so the agent can navigate, click, type,
 * screenshot, scrape, and evaluate JS in a real Chromium browser.
 */
const { tool, createSdkMcpServer } = require('@qwen-code/sdk')
const { z } = require('zod')

let _browser = null
let _context = null
let _page = null

async function ensureBrowser() {
  if (_page && !_page.isClosed()) return _page
  const { chromium } = require('playwright')
  _browser = await chromium.launch({ headless: true })
  _context = await _browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })
  _page = await _context.newPage()
  _page.setDefaultTimeout(30000)
  return _page
}

async function closeBrowser() {
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; _context = null; _page = null }
}

// ── tool definitions ──────────────────────────────────────────────────────────

const navigateTool = tool(
  'browser_navigate',
  'Navigate the browser to a URL. Returns the page title, URL, and a snapshot of visible text on the page.',
  { url: z.string().describe('The URL to navigate to') },
  async ({ url }) => {
    const page = await ensureBrowser()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const title = await page.title()
    const pageUrl = page.url()
    // grab a text snapshot so the model immediately has page context
    let snapshot = ''
    try {
      snapshot = await page.innerText('body')
      if (snapshot.length > 20000) snapshot = snapshot.slice(0, 20000) + '\n... [truncated]'
    } catch { snapshot = '[could not extract text]' }
    return { content: [{ type: 'text', text: `Navigated to: ${pageUrl}\nTitle: ${title}\n\n--- Page Text ---\n${snapshot}` }] }
  }
)

const screenshotTool = tool(
  'browser_screenshot',
  'Take a screenshot of the current page. Returns a base64-encoded PNG image. Use selector to screenshot a specific element.',
  {
    selector: z.string().optional().describe('Optional CSS selector to screenshot a specific element'),
    fullPage: z.boolean().optional().describe('Capture the full scrollable page (default: false)'),
  },
  async ({ selector, fullPage }) => {
    const page = await ensureBrowser()
    let buf
    if (selector) {
      const el = await page.$(selector)
      if (!el) return { content: [{ type: 'text', text: `Error: element not found for selector "${selector}"` }], isError: true }
      buf = await el.screenshot({ type: 'png' })
    } else {
      buf = await page.screenshot({ type: 'png', fullPage: fullPage || false })
    }
    return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }] }
  }
)

const clickTool = tool(
  'browser_click',
  'Click an element on the page by CSS selector. Returns confirmation or error.',
  { selector: z.string().describe('CSS selector of the element to click') },
  async ({ selector }) => {
    const page = await ensureBrowser()
    try {
      await page.click(selector, { timeout: 10000 })
      return { content: [{ type: 'text', text: `Clicked "${selector}"` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Click failed: ${e.message}` }], isError: true }
    }
  }
)

const typeTool = tool(
  'browser_type',
  'Type text into an input element. Clears the field first unless append is true.',
  {
    selector: z.string().describe('CSS selector of the input element'),
    text: z.string().describe('Text to type'),
    append: z.boolean().optional().describe('If true, append to existing value instead of clearing first'),
    pressEnter: z.boolean().optional().describe('Press Enter after typing'),
  },
  async ({ selector, text, append, pressEnter }) => {
    const page = await ensureBrowser()
    if (!append) await page.fill(selector, '')
    await page.type(selector, text)
    if (pressEnter) await page.press(selector, 'Enter')
    return { content: [{ type: 'text', text: `Typed into "${selector}"` }] }
  }
)

const getTextTool = tool(
  'browser_get_text',
  'Extract visible text content from the page or a specific element. Useful for scraping and reading page content.',
  {
    selector: z.string().optional().describe('CSS selector to extract text from. If omitted, returns full page text.'),
  },
  async ({ selector }) => {
    const page = await ensureBrowser()
    let text
    if (selector) {
      const el = await page.$(selector)
      if (!el) return { content: [{ type: 'text', text: `Element not found: "${selector}"` }], isError: true }
      text = await el.innerText()
    } else {
      text = await page.innerText('body')
    }
    // Truncate very long text to avoid blowing up context
    if (text.length > 50000) text = text.slice(0, 50000) + '\n... [truncated]'
    return { content: [{ type: 'text', text }] }
  }
)

const getHtmlTool = tool(
  'browser_get_html',
  'Get the HTML content of the page or a specific element. Returns outer HTML.',
  {
    selector: z.string().optional().describe('CSS selector. If omitted, returns full page HTML.'),
  },
  async ({ selector }) => {
    const page = await ensureBrowser()
    let html
    if (selector) {
      const el = await page.$(selector)
      if (!el) return { content: [{ type: 'text', text: `Element not found: "${selector}"` }], isError: true }
      html = await el.evaluate(e => e.outerHTML)
    } else {
      html = await page.content()
    }
    if (html.length > 100000) html = html.slice(0, 100000) + '\n<!-- truncated -->'
    return { content: [{ type: 'text', text: html }] }
  }
)

const evaluateTool = tool(
  'browser_evaluate',
  'Execute JavaScript code in the browser page context. Returns the serialized result. Use for complex interactions or data extraction.',
  {
    script: z.string().describe('JavaScript code to evaluate in the page context. Must be a single expression or IIFE.'),
  },
  async ({ script }) => {
    const page = await ensureBrowser()
    try {
      const result = await page.evaluate(script)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) ?? 'undefined' }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Eval error: ${e.message}` }], isError: true }
    }
  }
)

const waitForTool = tool(
  'browser_wait_for',
  'Wait for an element to appear on the page, or wait for navigation/network idle.',
  {
    selector: z.string().optional().describe('CSS selector to wait for'),
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().describe('Element state to wait for (default: visible)'),
    timeout: z.number().optional().describe('Max wait time in ms (default: 30000)'),
    waitForNavigation: z.boolean().optional().describe('Wait for navigation to complete instead of an element'),
  },
  async ({ selector, state, timeout, waitForNavigation }) => {
    const page = await ensureBrowser()
    const ms = timeout || 30000
    try {
      if (waitForNavigation) {
        await page.waitForLoadState('domcontentloaded', { timeout: ms })
        return { content: [{ type: 'text', text: `Navigation complete: ${page.url()}` }] }
      }
      if (!selector) return { content: [{ type: 'text', text: 'Provide a selector or set waitForNavigation' }], isError: true }
      await page.waitForSelector(selector, { state: state || 'visible', timeout: ms })
      return { content: [{ type: 'text', text: `Element "${selector}" is ${state || 'visible'}` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Wait failed: ${e.message}` }], isError: true }
    }
  }
)

const selectOptionTool = tool(
  'browser_select_option',
  'Select an option from a <select> dropdown element.',
  {
    selector: z.string().describe('CSS selector of the <select> element'),
    value: z.string().describe('The value attribute of the option to select'),
  },
  async ({ selector, value }) => {
    const page = await ensureBrowser()
    try {
      await page.selectOption(selector, value)
      return { content: [{ type: 'text', text: `Selected "${value}" in "${selector}"` }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Select failed: ${e.message}` }], isError: true }
    }
  }
)

const closeBrowserTool = tool(
  'browser_close',
  'Close the browser instance and free resources. Call when done with browser tasks.',
  {},
  async () => {
    await closeBrowser()
    return { content: [{ type: 'text', text: 'Browser closed.' }] }
  }
)

// ── create the MCP server ─────────────────────────────────────────────────────

function createPlaywrightServer() {
  return createSdkMcpServer({
    name: 'playwright',
    version: '1.0.0',
    tools: [
      navigateTool,
      screenshotTool,
      clickTool,
      typeTool,
      getTextTool,
      getHtmlTool,
      evaluateTool,
      waitForTool,
      selectOptionTool,
      closeBrowserTool,
    ],
  })
}

module.exports = { createPlaywrightServer, closeBrowser }
