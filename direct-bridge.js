/**
 * DirectBridge — streams directly from the local MLX server (OpenAI-compatible)
 * without the @qwen-code/sdk subprocess overhead.
 *
 * Drop-in replacement for QwenBridge. Same EventSink interface, same qwen-event
 * channel shape, but tokens flow straight from server.py → IPC → renderer.
 *
 * Tool execution loop is handled here: model returns tool_calls → we execute
 * them locally → feed results back → repeat until finish_reason:"stop".
 */
'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const { execSync, spawn } = require('child_process')
const { createPlaywrightInstance, BROWSER_TOOL_DEFS } = require('./playwright-tool')
const { createVisionServer, registerImages, clearImages } = require('./vision-tool')

// Re-export the sink classes from qwen-bridge so main.js can use them
const { WindowSink, CallbackSink, WorkerSink } = require('./qwen-bridge')

const SERVER_PORT = 8090
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`

// ── Built-in tool definitions (what the model can call) ───────────────────────

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path. Returns the file content as a string.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. Creates parent directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write to' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace a specific string in a file with new content. Use for surgical edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to edit' },
          old_string: { type: 'string', description: 'Exact string to find and replace (must match exactly)' },
          new_string: { type: 'string', description: 'Replacement string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories at the given path. Returns names with / suffix for directories.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command and return its output. Use for running tests, installing packages, git operations, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a pattern in files using grep. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex)' },
          path: { type: 'string', description: 'Directory or file to search in (defaults to cwd)' },
          include: { type: 'string', description: 'File glob pattern to include (e.g. "*.js")' },
        },
        required: ['pattern'],
      },
    },
  },
  ...BROWSER_TOOL_DEFS,
]

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name, args, cwd, browserInstance) {
  // Route browser_* tools to the playwright instance
  if (name.startsWith('browser_') && browserInstance) {
    return browserInstance.execute(name, args)
  }

  try {
    switch (name) {
      case 'read_file': {
        const p = path.resolve(cwd, args.path)
        if (!fs.existsSync(p)) return { error: `File not found: ${args.path}` }
        const stat = fs.statSync(p)
        if (stat.size > 512 * 1024) return { error: `File too large (${(stat.size / 1024).toFixed(0)}KB). Read a smaller file or use search_files.` }
        return { result: fs.readFileSync(p, 'utf-8') }
      }
      case 'write_file': {
        const p = path.resolve(cwd, args.path)
        const dir = path.dirname(p)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(p, args.content, 'utf-8')
        return { result: `Wrote ${args.content.length} chars to ${args.path}` }
      }
      case 'edit_file': {
        const p = path.resolve(cwd, args.path)
        if (!fs.existsSync(p)) return { error: `File not found: ${args.path}` }
        const content = fs.readFileSync(p, 'utf-8')
        if (!content.includes(args.old_string)) return { error: `old_string not found in ${args.path}. Make sure it matches exactly.` }
        const count = content.split(args.old_string).length - 1
        if (count > 1) return { error: `old_string found ${count} times in ${args.path}. Make it more specific so it matches exactly once.` }
        fs.writeFileSync(p, content.replace(args.old_string, args.new_string), 'utf-8')
        return { result: `Edited ${args.path}` }
      }
      case 'list_dir': {
        const p = path.resolve(cwd, args.path || '.')
        if (!fs.existsSync(p)) return { error: `Directory not found: ${args.path}` }
        const entries = fs.readdirSync(p, { withFileTypes: true })
          .filter(e => !e.name.startsWith('.'))
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1
            if (!a.isDirectory() && b.isDirectory()) return 1
            return a.name.localeCompare(b.name)
          })
          .map(e => e.isDirectory() ? e.name + '/' : e.name)
        return { result: entries.join('\n') }
      }
      case 'bash': {
        const out = execSync(args.command, {
          cwd,
          encoding: 'utf-8',
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        return { result: out || '(no output)' }
      }
      case 'search_files': {
        const searchPath = args.path ? path.resolve(cwd, args.path) : cwd
        let cmd = `grep -rn "${args.pattern.replace(/"/g, '\\"')}" "${searchPath}"`
        if (args.include) cmd += ` --include="${args.include}"`
        cmd += ' 2>/dev/null | head -50'
        try {
          const out = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 10000, maxBuffer: 512 * 1024 })
          return { result: out || 'No matches found.' }
        } catch {
          return { result: 'No matches found.' }
        }
      }
      default:
        return { error: `Unknown tool: ${name}` }
    }
  } catch (err) {
    return { error: err.message || String(err) }
  }
}

// ── SSE stream parser ─────────────────────────────────────────────────────────

function streamSSE(url, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    }, (res) => {
      resolve({ res, req })
    })
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

// ── DirectBridge ──────────────────────────────────────────────────────────────

class DirectBridge {
  constructor(sink) {
    this.sink = sink
    this._aborted = false
    this._activeReq = null
    // MCP servers for playwright/vision
    this._browserInstance = null
    this._visionServer = null
  }

  send(channel, data) {
    this.sink.send(channel, data)
  }

  async run({ prompt, cwd, permissionMode, model, images, conversationHistory }) {
    this._aborted = false

    // Set up browser instance and vision
    this._browserInstance = createPlaywrightInstance()
    this._visionServer = createVisionServer()

    // Register images
    let imageContext = ''
    if (images && images.length > 0) {
      const ids = registerImages(images)
      imageContext = `\n\nThe user has attached ${ids.length} image(s). Image IDs: ${ids.join(', ')}. Use the vision_analyze tool to see them.`
    } else {
      clearImages()
    }

    const workDir = cwd || process.cwd()
    const systemPrompt = this._buildSystemPrompt(workDir, permissionMode)

    // Build messages array
    const messages = [{ role: 'system', content: systemPrompt }]

    // Add conversation history
    if (conversationHistory && conversationHistory.length > 0) {
      for (const m of conversationHistory) {
        messages.push({ role: m.role, content: m.content })
      }
    }

    messages.push({ role: 'user', content: prompt + imageContext })

    this.send('qwen-event', { type: 'session-start', cwd: workDir })

    try {
      await this._agentLoop(messages, workDir, model)
      this.send('qwen-event', { type: 'session-end' })
    } catch (err) {
      if (!this._aborted) {
        this.send('qwen-event', { type: 'error', error: err.message || String(err) })
      }
    }
  }

  /**
   * The core agentic loop: call model → if tool_calls, execute & loop → else done.
   */
  async _agentLoop(messages, cwd, model, maxTurns = 25) {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (this._aborted) return

      const { text, toolCalls, usage, finishReason } = await this._streamCompletion(messages, cwd, model)

      // Send usage stats
      if (usage) {
        this.send('qwen-event', {
          type: 'raw-stream',
          event: {
            usage: {
              prompt_tokens: usage.prompt_tokens || 0,
              completion_tokens: usage.completion_tokens || 0,
            },
            x_stats: {
              prompt_tps: usage.prompt_tps || 0,
              generation_tps: usage.generation_tps || 0,
              peak_memory_gb: usage.peak_memory_gb || 0,
            },
          },
        })
      }

      // No tool calls — we're done
      if (!toolCalls || toolCalls.length === 0 || finishReason === 'stop') {
        // Send final assistant message
        this.send('qwen-event', {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: text,
        })
        return
      }

      // Add assistant message with tool_calls to history
      const assistantMsg = { role: 'assistant', content: text || null }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }))
      }
      messages.push(assistantMsg)

      // Execute each tool call
      for (const tc of toolCalls) {
        if (this._aborted) return

        const fnName = tc.function.name
        let fnArgs = {}
        try { fnArgs = JSON.parse(tc.function.arguments) } catch {}

        // Emit tool-use event
        this.send('qwen-event', { type: 'tool-use', id: tc.id, name: fnName, input: fnArgs })

        // Execute
        const result = await executeTool(fnName, fnArgs, cwd, this._browserInstance)
        const isError = !!result.error
        const content = result.error || result.result

        // Emit tool-result event
        this.send('qwen-event', {
          type: 'tool-result',
          tool_use_id: tc.id,
          content: content,
          is_error: isError,
        })

        // Add tool result to messages
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: content,
        })
      }
    }

    // Max turns reached
    this.send('qwen-event', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '(max tool turns reached)',
    })
  }

  /**
   * Stream a single completion from the server, emitting text-delta events
   * as tokens arrive. Returns the accumulated text + any tool_calls.
   */
  async _streamCompletion(messages, cwd, model) {
    return new Promise(async (resolve, reject) => {
      if (this._aborted) return resolve({ text: '', toolCalls: [], usage: null, finishReason: 'stop' })

      const body = {
        model: model || 'default',
        messages,
        tools: TOOL_DEFS,
        stream: true,
        max_tokens: 4096,
      }

      let accumulated = ''
      let toolCalls = []
      let usage = null
      let finishReason = null
      let buf = ''

      try {
        const { res, req } = await streamSSE(`${SERVER_URL}/v1/chat/completions`, body)
        this._activeReq = req

        res.on('data', (chunk) => {
          if (this._aborted) { req.destroy(); return }

          buf += chunk.toString()
          const lines = buf.split('\n')
          buf = lines.pop() // keep incomplete line

          for (const line of lines) {
            if (line.startsWith('data: [DONE]')) continue
            if (!line.startsWith('data: ')) continue

            let parsed
            try { parsed = JSON.parse(line.slice(6)) } catch { continue }

            // Handle usage/stats chunks
            if (parsed.usage && parsed.usage.prompt_tokens) {
              usage = { ...parsed.usage }
              if (parsed.x_stats) {
                usage.prompt_tps = parsed.x_stats.prompt_tps
                usage.generation_tps = parsed.x_stats.generation_tps
                usage.peak_memory_gb = parsed.x_stats.peak_memory_gb
              }
              // Forward raw stats to renderer
              this.send('qwen-event', {
                type: 'raw-stream',
                event: {
                  usage: parsed.usage,
                  x_stats: parsed.x_stats || {},
                },
              })
              continue
            }

            const choice = parsed.choices?.[0]
            if (!choice) continue

            // Content delta — stream it immediately
            const delta = choice.delta
            if (delta?.content) {
              accumulated += delta.content
              this.send('qwen-event', { type: 'text-delta', text: accumulated })
            }

            // Tool calls in delta (streaming tool calls)
            if (delta?.tool_calls) {
              toolCalls = delta.tool_calls
              finishReason = 'tool_calls'
            }

            if (choice.finish_reason) {
              finishReason = choice.finish_reason
            }
          }
        })

        res.on('end', () => {
          this._activeReq = null
          resolve({ text: accumulated, toolCalls, usage, finishReason })
        })

        res.on('error', (err) => {
          this._activeReq = null
          reject(err)
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  _buildSystemPrompt(cwd, permissionMode) {
    const autoEdit = permissionMode === 'auto-edit'
    return `You are a powerful coding assistant. You help users write, edit, debug, and understand code.

Working directory: ${cwd}

You have access to these tools:

**File tools:**
- read_file: Read file contents
- write_file: Create or overwrite files
- edit_file: Make surgical edits to existing files (find and replace)
- list_dir: List directory contents
- bash: Execute shell commands
- search_files: Search for patterns in files using grep

**Browser automation tools (Playwright):**
- browser_navigate: Go to a URL, returns page title and visible text
- browser_screenshot: Take a screenshot of the page or an element
- browser_click: Click an element by CSS selector
- browser_type: Type text into an input field
- browser_get_text: Extract visible text from the page or an element
- browser_get_html: Get HTML content of the page or an element
- browser_evaluate: Run JavaScript in the page context
- browser_wait_for: Wait for an element or navigation
- browser_select_option: Select a dropdown option
- browser_close: Close the browser when done

When the user asks you to make changes to code:
1. First read the relevant files to understand the current state
2. Make changes using write_file or edit_file
3. If needed, run tests or verify with bash

When the user asks you to browse, research, or interact with websites, use the browser tools directly. Call browser_navigate first, then use other browser tools to interact with the page.

Be direct and efficient. Make the changes the user asks for.
${autoEdit ? '\nYou are in auto-edit mode. Proceed with changes without asking for confirmation.' : ''}`
  }

  async interrupt() {
    this._aborted = true
    if (this._activeReq) {
      try { this._activeReq.destroy() } catch {}
      this._activeReq = null
    }
    this.send('qwen-event', { type: 'session-end' })
  }

  async close() {
    this._aborted = true
    if (this._activeReq) {
      try { this._activeReq.destroy() } catch {}
    }
    if (this._browserInstance) {
      await this._browserInstance.closeBrowser().catch(() => {})
    }
    this._browserInstance = null
    clearImages()
    this._visionServer = null
  }
}

module.exports = { DirectBridge, WindowSink, CallbackSink, WorkerSink }
