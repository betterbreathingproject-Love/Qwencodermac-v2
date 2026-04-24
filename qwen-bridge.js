/**
 * Qwen Code SDK bridge — runs in main process, streams events to renderer.
 *
 * Supports multiple EventSink implementations for multi-instance usage:
 * - WindowSink: wraps BrowserWindow.webContents.send (main foreground agent)
 * - CallbackSink: routes events through EventEmitter with taskId prefix (Agent Pool subagents)
 * - WorkerSink: sends events via worker_thread MessagePort (background tasks)
 */
const { query, isSDKAssistantMessage, isSDKPartialAssistantMessage,
        isSDKSystemMessage, isSDKResultMessage } = require('@qwen-code/sdk')
const path = require('path')
const { createPlaywrightServer } = require('./playwright-tool')
const { createVisionServer, registerImages, clearImages, getImageCount, getImageIds } = require('./vision-tool')

// ── EventSink implementations ─────────────────────────────────────────────────

/**
 * WindowSink — wraps BrowserWindow.webContents.send (existing behavior).
 * Used for the main foreground agent that sends events to the renderer.
 */
class WindowSink {
  constructor(win) {
    this.win = win
  }

  send(channel, data) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, data)
    }
  }
}

/**
 * CallbackSink — routes events through an EventEmitter with a taskId prefix.
 * Used by Agent Pool foreground subagents to multiplex events from multiple agents.
 */
class CallbackSink {
  constructor(emitter, taskId) {
    this.emitter = emitter
    this.taskId = taskId
  }

  send(channel, data) {
    this.emitter.emit('agent-event', { taskId: this.taskId, channel, data })
  }
}

/**
 * WorkerSink — sends events via worker_thread MessagePort.
 * Used for background tasks running in worker_threads.
 */
class WorkerSink {
  constructor(port) {
    this.port = port
  }

  send(channel, data) {
    this.port.postMessage({ channel, data })
  }
}

// ── QwenBridge ────────────────────────────────────────────────────────────────

class QwenBridge {
  /**
   * @param {object} sink - An EventSink with a send(channel, data) method
   */
  constructor(sink) {
    this.sink = sink
    this.activeQuery = null
    this.sessionId = null
    this._playwrightBrowser = null
  }

  send(channel, data) {
    this.sink.send(channel, data)
  }

  async run({ prompt, cwd, permissionMode, model, images }) {
    if (this.activeQuery) {
      try { await this.activeQuery.interrupt() } catch (e) { /* ignore */ }
    }

    // Register images for the vision tool (if any)
    let imageContext = ''
    if (images && images.length > 0) {
      const ids = registerImages(images)
      imageContext = `\n\nThe user has attached ${ids.length} image(s) to this message. Image IDs: ${ids.join(', ')}. You MUST use the vision_analyze tool to see and analyze these images. Call vision_analyze with the image_id and a prompt describing what you want to know. Do NOT say you cannot see images — use the tool.`
    } else {
      clearImages()
    }

    const finalPrompt = prompt + imageContext

    // create Playwright SDK MCP server for browser automation tools (per-instance)
    const playwrightServer = createPlaywrightServer()
    // create Vision SDK MCP server for image analysis
    const visionServer = createVisionServer()

    const opts = {
      cwd: cwd || process.cwd(),
      permissionMode: permissionMode || 'auto-edit',
      authType: 'openai',
      includePartialMessages: true,
      debug: false,
      env: {
        OPENAI_BASE_URL: 'http://127.0.0.1:8090/v1',
        OPENAI_API_KEY: 'mlx',
      },
      pathToQwenExecutable: path.join(
        __dirname, 'node_modules', '@qwen-code', 'sdk', 'dist', 'cli', 'cli.js'
      ),
      systemPrompt: {
        type: 'preset',
        preset: 'qwen_code',
        append: `\n\nYou have access to Playwright browser automation tools via MCP. When the user asks you to browse, research, scrape, or interact with websites, you MUST use these tools directly — do NOT write Playwright scripts. The tools are:
- browser_navigate: Go to a URL
- browser_screenshot: Take a screenshot of the page or an element
- browser_click: Click an element by CSS selector
- browser_type: Type text into an input field
- browser_get_text: Extract visible text from the page or an element
- browser_get_html: Get HTML content of the page or an element
- browser_evaluate: Run JavaScript in the page context
- browser_wait_for: Wait for an element or navigation
- browser_select_option: Select a dropdown option
- browser_close: Close the browser when done

Always prefer using these tools over writing code. Call browser_navigate first, then use the other tools to interact with the page.

You also have access to a Vision tool for analyzing images:
- vision_analyze: Analyze an attached image using the vision model. Takes an image_id (e.g. "img_0") and a prompt. Use image_id "all" to analyze all images together.

When the user attaches images, you MUST use vision_analyze to see them. You cannot see images directly in the conversation — always use the tool. This is your eyes. Do not claim you cannot see images.` +
        (permissionMode === 'auto-edit' ? `\n\nIMPORTANT: You are running in auto-edit mode. When you use the question/ask tool and receive an empty or default response, this does NOT mean the user cancelled. It means the system auto-approved your action. Proceed with your best judgment — do NOT repeat that the user cancelled. Never say "the user cancelled the question" — just continue working.` : ''),
      },
      mcpServers: {
        playwright: playwrightServer,
        vision: visionServer,
      },
      allowedTools: [
        'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type',
        'browser_get_text', 'browser_get_html', 'browser_evaluate', 'browser_wait_for',
        'browser_select_option', 'browser_close',
        'vision_analyze',
      ],
    }

    if (model) {
      opts.model = model
      opts.env.OPENAI_MODEL = model
    }

    this.send('qwen-event', { type: 'session-start', cwd: opts.cwd })

    try {
      const q = query({ prompt: finalPrompt, options: opts })
      this.activeQuery = q
      this.sessionId = q.getSessionId ? q.getSessionId() : null

      for await (const msg of q) {
        this._handleMessage(msg)
      }

      this.send('qwen-event', { type: 'session-end' })
    } catch (err) {
      this.send('qwen-event', { type: 'error', error: err.message || String(err) })
    }
    this.activeQuery = null
  }

  _handleMessage(msg) {
    // stream_event — forward raw event to renderer
    if (msg.type === 'stream_event' && msg.event) {
      this.send('qwen-event', { type: 'raw-stream', event: msg.event })
      return
    }

    // Order matters: check result first (terminal), then system, then
    // partial before full assistant to avoid double-firing on messages
    // that satisfy multiple SDK predicates.
    if (isSDKResultMessage(msg)) {
      this.send('qwen-event', {
        type: 'result',
        subtype: msg.subtype,
        is_error: msg.is_error,
        result: msg.subtype === 'success' ? msg.result : msg.error,
      })
      return
    }

    if (isSDKSystemMessage(msg)) {
      this.send('qwen-event', { type: 'system', subtype: msg.subtype, data: msg.data })
      return
    }

    if (isSDKPartialAssistantMessage(msg)) {
      const content = msg.message && msg.message.content ? msg.message.content : []
      for (const block of content) {
        if (block.type === 'text') {
          this.send('qwen-event', { type: 'text-delta', text: block.text })
        } else if (block.type === 'thinking') {
          this.send('qwen-event', { type: 'thinking-delta', text: block.thinking })
        } else if (block.type === 'tool_use') {
          this.send('qwen-event', { type: 'tool-use', id: block.id, name: block.name, input: block.input })
        } else if (block.type === 'tool_result') {
          this.send('qwen-event', { type: 'tool-result', tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error })
        }
      }
      return
    }

    if (isSDKAssistantMessage(msg)) {
      const content = msg.message && msg.message.content ? msg.message.content : []
      const blocks = content.map(function(b) {
        if (b.type === 'text') return { type: 'text', text: b.text }
        if (b.type === 'thinking') return { type: 'thinking', text: b.thinking }
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
        if (b.type === 'tool_result') return { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error }
        return b
      })
      this.send('qwen-event', {
        type: 'assistant',
        blocks: blocks,
        usage: msg.message ? msg.message.usage : null,
        stop_reason: msg.message ? msg.message.stop_reason : null,
      })
      return
    }
  }

  async interrupt() {
    if (this.activeQuery) {
      try { await this.activeQuery.interrupt() } catch (e) { /* ignore */ }
      this.activeQuery = null
      this.send('qwen-event', { type: 'session-end' })
    }
  }

  /**
   * Close this QwenBridge instance and clean up its own Playwright browser.
   * Each instance tracks its own browser — no global singleton.
   */
  async close() {
    if (this.activeQuery) {
      try { await this.activeQuery.close() } catch (e) { /* ignore */ }
    }
    if (this._playwrightBrowser) {
      await this._playwrightBrowser.close().catch(() => {})
      this._playwrightBrowser = null
    }
  }

  /**
   * Track a Playwright browser instance for this QwenBridge.
   * Called by the Playwright tool when a browser is launched.
   * @param {object} browser - Playwright Browser instance
   */
  setPlaywrightBrowser(browser) {
    this._playwrightBrowser = browser
  }
}

module.exports = { QwenBridge, WindowSink, CallbackSink, WorkerSink }
