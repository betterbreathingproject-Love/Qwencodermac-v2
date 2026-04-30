/**
 * xcode-tool.js — XcodeBuildMCP integration for QwenCoder Mac Studio.
 *
 * Spawns xcodebuildmcp as a stdio MCP server subprocess and exposes its tools
 * to the agent loop via the same interface as LSP tools.
 *
 * Install: npm install -g xcodebuildmcp@latest  OR  brew install xcodebuildmcp
 *
 * Gracefully degrades: if xcodebuildmcp is not installed, all tool calls
 * return a helpful error and the agent falls back to raw bash.
 */
'use strict'

const { spawn } = require('child_process')
const { EventEmitter } = require('node:events')

// ── Tool definitions exposed to the agent ────────────────────────────────────
// Curated subset of XcodeBuildMCP tools most useful for an AI coding agent.
// Full tool list: https://xcodebuildmcp.com/docs/tools

const XCODE_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'xcode_build_simulator',
      description: 'Build an Xcode project or workspace for a simulator. Returns structured build output with errors and warnings. Use this instead of running xcodebuild directly.',
      parameters: {
        type: 'object',
        properties: {
          project_path: { type: 'string', description: 'Path to .xcodeproj or .xcworkspace file' },
          scheme: { type: 'string', description: 'Xcode scheme to build' },
          configuration: { type: 'string', description: 'Build configuration: Debug or Release (default: Debug)' },
          destination: { type: 'string', description: 'Simulator destination, e.g. "platform=iOS Simulator,name=iPhone 16"' },
        },
        required: ['scheme'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_build_macos',
      description: 'Build an Xcode project or workspace for macOS. Returns structured build output with errors and warnings.',
      parameters: {
        type: 'object',
        properties: {
          project_path: { type: 'string', description: 'Path to .xcodeproj or .xcworkspace file' },
          scheme: { type: 'string', description: 'Xcode scheme to build' },
          configuration: { type: 'string', description: 'Build configuration: Debug or Release (default: Debug)' },
        },
        required: ['scheme'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_test',
      description: 'Run tests for an Xcode scheme. Returns pass/fail counts and detailed failure messages.',
      parameters: {
        type: 'object',
        properties: {
          project_path: { type: 'string', description: 'Path to .xcodeproj or .xcworkspace file' },
          scheme: { type: 'string', description: 'Xcode scheme to test' },
          destination: { type: 'string', description: 'Test destination, e.g. "platform=iOS Simulator,name=iPhone 16"' },
          test_filter: { type: 'string', description: 'Optional test filter, e.g. "MyTests/testFoo"' },
        },
        required: ['scheme'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_clean',
      description: 'Clean the build directory for an Xcode scheme.',
      parameters: {
        type: 'object',
        properties: {
          project_path: { type: 'string', description: 'Path to .xcodeproj or .xcworkspace file' },
          scheme: { type: 'string', description: 'Xcode scheme to clean' },
        },
        required: ['scheme'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_list_schemes',
      description: 'List all available schemes in an Xcode project or workspace.',
      parameters: {
        type: 'object',
        properties: {
          project_path: { type: 'string', description: 'Path to .xcodeproj or .xcworkspace file. If omitted, auto-discovers in cwd.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_list_simulators',
      description: 'List available iOS/macOS simulators with their UDID, state, and OS version.',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Filter by platform: iOS, macOS, watchOS, tvOS' },
          available_only: { type: 'boolean', description: 'Only show available (non-unavailable) simulators (default: true)' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_boot_simulator',
      description: 'Boot a simulator by UDID or name.',
      parameters: {
        type: 'object',
        properties: {
          udid: { type: 'string', description: 'Simulator UDID' },
          name: { type: 'string', description: 'Simulator name (used if udid not provided)' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_install_app_simulator',
      description: 'Install a built .app bundle on a simulator.',
      parameters: {
        type: 'object',
        properties: {
          app_path: { type: 'string', description: 'Path to the .app bundle' },
          udid: { type: 'string', description: 'Target simulator UDID' },
        },
        required: ['app_path', 'udid'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_launch_app_simulator',
      description: 'Launch an installed app on a simulator by bundle ID.',
      parameters: {
        type: 'object',
        properties: {
          bundle_id: { type: 'string', description: 'App bundle identifier, e.g. com.example.MyApp' },
          udid: { type: 'string', description: 'Target simulator UDID' },
        },
        required: ['bundle_id', 'udid'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_screenshot_simulator',
      description: 'Take a screenshot of a running simulator.',
      parameters: {
        type: 'object',
        properties: {
          udid: { type: 'string', description: 'Simulator UDID' },
          output_path: { type: 'string', description: 'Path to save the screenshot PNG' },
        },
        required: ['udid'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_get_build_settings',
      description: 'Get Xcode build settings for a scheme (PRODUCT_BUNDLE_IDENTIFIER, SWIFT_VERSION, DEPLOYMENT_TARGET, etc.).',
      parameters: {
        type: 'object',
        properties: {
          project_path: { type: 'string', description: 'Path to .xcodeproj or .xcworkspace file' },
          scheme: { type: 'string', description: 'Xcode scheme' },
          configuration: { type: 'string', description: 'Build configuration (default: Debug)' },
        },
        required: ['scheme'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xcode_resolve_packages',
      description: 'Resolve Swift Package Manager dependencies for an Xcode project.',
      parameters: {
        type: 'object',
        properties: {
          project_path: { type: 'string', description: 'Path to .xcodeproj or .xcworkspace file' },
        },
        additionalProperties: false,
      },
    },
  },
]

// Map our tool names to XcodeBuildMCP tool names
// (XcodeBuildMCP uses camelCase names like "buildForSimulator")
const TOOL_NAME_MAP = {
  xcode_build_simulator:      'buildForSimulator',
  xcode_build_macos:          'buildForMacOS',
  xcode_test:                 'runTests',
  xcode_clean:                'cleanBuildDirectory',
  xcode_list_schemes:         'listSchemes',
  xcode_list_simulators:      'listSimulators',
  xcode_boot_simulator:       'bootSimulator',
  xcode_install_app_simulator:'installAppOnSimulator',
  xcode_launch_app_simulator: 'launchAppOnSimulator',
  xcode_screenshot_simulator: 'takeSimulatorScreenshot',
  xcode_get_build_settings:   'getBuildSettings',
  xcode_resolve_packages:     'resolvePackageDependencies',
}

// Map our arg names to XcodeBuildMCP arg names
function _mapArgs(toolName, args) {
  const mapped = {}
  for (const [k, v] of Object.entries(args || {})) {
    // camelCase conversion for known fields
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    mapped[camel] = v
  }
  return mapped
}

// ── XcodeMCPClient ────────────────────────────────────────────────────────────

class XcodeMCPClient extends EventEmitter {
  constructor() {
    super()
    this._proc = null
    this._ready = false
    this._msgId = 0
    this._pending = new Map()  // id → { resolve, reject, timer }
    this._buf = ''
    this._status = 'stopped'   // 'stopped' | 'starting' | 'ready' | 'error'
    this._errorMsg = null
  }

  /**
   * Find the xcodebuildmcp binary.
   * Checks npm global bin, homebrew, and PATH.
   */
  static _findBinary() {
    const { execSync } = require('child_process')
    const candidates = [
      'xcodebuildmcp',
      '/opt/homebrew/bin/xcodebuildmcp',
      '/usr/local/bin/xcodebuildmcp',
    ]
    // Try npm global bin
    try {
      const npmBin = execSync('npm bin -g 2>/dev/null', { timeout: 3000 }).toString().trim()
      if (npmBin) candidates.unshift(`${npmBin}/xcodebuildmcp`)
    } catch { /* ignore */ }

    const fs = require('fs')
    for (const c of candidates) {
      try {
        if (c === 'xcodebuildmcp') {
          execSync('which xcodebuildmcp', { timeout: 2000 })
          return c
        }
        if (fs.existsSync(c)) return c
      } catch { /* not found */ }
    }
    return null
  }

  /**
   * Start the MCP server subprocess and perform the JSON-RPC handshake.
   */
  async start() {
    if (this._status === 'ready') return { ok: true }
    if (this._status === 'starting') {
      // Wait for existing start to complete
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (this._status !== 'starting') {
            clearInterval(check)
            resolve(this._status === 'ready' ? { ok: true } : { ok: false, error: this._errorMsg })
          }
        }, 100)
      })
    }

    this._status = 'starting'
    const bin = XcodeMCPClient._findBinary()
    if (!bin) {
      this._status = 'error'
      this._errorMsg = 'xcodebuildmcp not installed. Run: npm install -g xcodebuildmcp@latest'
      return { ok: false, error: this._errorMsg }
    }

    return new Promise((resolve) => {
      try {
        this._proc = spawn(bin, ['mcp'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':'),
          },
        })
      } catch (err) {
        this._status = 'error'
        this._errorMsg = `Failed to spawn xcodebuildmcp: ${err.message}`
        return resolve({ ok: false, error: this._errorMsg })
      }

      this._proc.stdout.on('data', (chunk) => this._onData(chunk))
      this._proc.stderr.on('data', (d) => {
        // stderr is informational — log but don't fail
        const line = d.toString().trim()
        if (line) console.log(`[xcode-mcp] ${line}`)
      })
      this._proc.on('exit', (code) => {
        this._status = 'stopped'
        this._proc = null
        // Reject all pending calls
        for (const [, { reject: rej, timer }] of this._pending) {
          clearTimeout(timer)
          rej(new Error(`xcodebuildmcp process exited (code ${code})`))
        }
        this._pending.clear()
      })
      this._proc.on('error', (err) => {
        this._status = 'error'
        this._errorMsg = err.message
        resolve({ ok: false, error: err.message })
      })

      // Send MCP initialize request
      const initId = ++this._msgId
      const initMsg = JSON.stringify({
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'QwenCoderMacStudio', version: '1.0.0' },
        },
      })

      // Wait for initialize response
      const initTimer = setTimeout(() => {
        this._status = 'error'
        this._errorMsg = 'xcodebuildmcp initialize timed out'
        resolve({ ok: false, error: this._errorMsg })
      }, 10000)

      this._pending.set(initId, {
        resolve: (result) => {
          clearTimeout(initTimer)
          // Send initialized notification
          this._send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
          this._status = 'ready'
          this._ready = true
          resolve({ ok: true })
        },
        reject: (err) => {
          clearTimeout(initTimer)
          this._status = 'error'
          this._errorMsg = err.message
          resolve({ ok: false, error: err.message })
        },
        timer: null,
      })

      this._proc.stdin.write(initMsg + '\n')
    })
  }

  _send(msg) {
    if (!this._proc || !this._proc.stdin.writable) return
    this._proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  _onData(chunk) {
    this._buf += chunk.toString()
    const lines = this._buf.split('\n')
    this._buf = lines.pop()  // keep incomplete line
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed)
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          const { resolve, reject, timer } = this._pending.get(msg.id)
          this._pending.delete(msg.id)
          if (timer) clearTimeout(timer)
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)))
          } else {
            resolve(msg.result)
          }
        }
      } catch { /* malformed line — ignore */ }
    }
  }

  /**
   * Call an MCP tool by its XcodeBuildMCP name.
   * @param {string} mcpToolName - e.g. 'buildForSimulator'
   * @param {object} args - Tool arguments (camelCase)
   * @param {number} timeoutMs
   * @returns {Promise<object>} Tool result
   */
  async callTool(mcpToolName, args, timeoutMs = 120000) {
    if (this._status !== 'ready') {
      const start = await this.start()
      if (!start.ok) throw new Error(start.error)
    }

    return new Promise((resolve, reject) => {
      const id = ++this._msgId
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`xcode tool '${mcpToolName}' timed out after ${timeoutMs / 1000}s`))
      }, timeoutMs)

      this._pending.set(id, { resolve, reject, timer })
      this._send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: mcpToolName, arguments: args || {} },
      })
    })
  }

  stop() {
    if (this._proc) {
      try { this._proc.kill('SIGTERM') } catch { /* ignore */ }
      this._proc = null
    }
    this._status = 'stopped'
    this._ready = false
  }

  getStatus() {
    return { status: this._status, error: this._errorMsg }
  }
}

// ── Singleton client ──────────────────────────────────────────────────────────
// One shared client per process — tools/call is stateless so sharing is safe.
let _client = null

function getClient() {
  if (!_client) _client = new XcodeMCPClient()
  return _client
}

/**
 * Execute an xcode_* tool call from the agent loop.
 *
 * @param {string} toolName - Our tool name, e.g. 'xcode_build_simulator'
 * @param {object} args - Tool arguments from the model
 * @param {string} cwd - Working directory (used for project auto-discovery)
 * @returns {Promise<{result?: string, error?: string}>}
 */
async function executeXcodeTool(toolName, args, cwd) {
  const mcpName = TOOL_NAME_MAP[toolName]
  if (!mcpName) return { error: `Unknown xcode tool: ${toolName}` }

  const client = getClient()

  // Auto-discover project path if not provided
  const mappedArgs = _mapArgs(toolName, args)
  if (!mappedArgs.projectPath && cwd) {
    const fs = require('fs')
    const path = require('path')
    // Look for .xcworkspace first (CocoaPods/SPM), then .xcodeproj
    const entries = fs.readdirSync(cwd).filter(e => e.endsWith('.xcworkspace') || e.endsWith('.xcodeproj'))
    const workspace = entries.find(e => e.endsWith('.xcworkspace'))
    const project = entries.find(e => e.endsWith('.xcodeproj'))
    const found = workspace || project
    if (found) mappedArgs.projectPath = path.join(cwd, found)
  }

  try {
    const result = await client.callTool(mcpName, mappedArgs, 180000)

    // XcodeBuildMCP returns { content: [{ type: 'text', text: '...' }] }
    if (result && Array.isArray(result.content)) {
      const text = result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n')
      return { result: text || '(no output)' }
    }
    return { result: JSON.stringify(result) }
  } catch (err) {
    // If not installed, give a clear actionable message
    if (err.message.includes('not installed') || err.message.includes('ENOENT')) {
      return { error: `XcodeBuildMCP not installed. Install with: npm install -g xcodebuildmcp@latest\nThen restart the app.\n\nFalling back: use bash with xcodebuild directly.` }
    }
    return { error: err.message }
  }
}

/**
 * Check if xcodebuildmcp is installed.
 */
function isXcodeMCPAvailable() {
  return !!XcodeMCPClient._findBinary()
}

/**
 * Gracefully stop the MCP server subprocess on app exit.
 */
function shutdown() {
  if (_client) {
    _client.stop()
    _client = null
  }
}

module.exports = {
  XCODE_TOOL_DEFS,
  executeXcodeTool,
  isXcodeMCPAvailable,
  getClient,
  shutdown,
}
