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
const { WEB_TOOL_DEFS, executeWebTool } = require('./web-tools')
const { getApiKeys } = require('./projects')

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
  ...WEB_TOOL_DEFS,
]

// ── LSP tool definitions (same shape as TOOL_DEFS entries) ────────────────────

const LSP_TOOL_DEFS = {
  lsp_get_document_symbols: {
    type: 'function',
    function: {
      name: 'lsp_get_document_symbols',
      description: 'Get document symbols (functions, classes, variables) for a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to get symbols for' },
        },
        required: ['path'],
      },
    },
  },
  lsp_get_hover: {
    type: 'function',
    function: {
      name: 'lsp_get_hover',
      description: 'Get hover information (type, documentation) for a symbol at a position.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          line: { type: 'number', description: 'Line number (0-indexed)' },
          character: { type: 'number', description: 'Character offset (0-indexed)' },
        },
        required: ['path', 'line', 'character'],
      },
    },
  },
  lsp_get_definition: {
    type: 'function',
    function: {
      name: 'lsp_get_definition',
      description: 'Go to definition of a symbol at a position.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          line: { type: 'number', description: 'Line number (0-indexed)' },
          character: { type: 'number', description: 'Character offset (0-indexed)' },
        },
        required: ['path', 'line', 'character'],
      },
    },
  },
  lsp_get_references: {
    type: 'function',
    function: {
      name: 'lsp_get_references',
      description: 'Find all references to a symbol at a position.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          line: { type: 'number', description: 'Line number (0-indexed)' },
          character: { type: 'number', description: 'Character offset (0-indexed)' },
        },
        required: ['path', 'line', 'character'],
      },
    },
  },
  lsp_get_call_hierarchy: {
    type: 'function',
    function: {
      name: 'lsp_get_call_hierarchy',
      description: 'Get incoming and outgoing calls for a symbol at a position.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          line: { type: 'number', description: 'Line number (0-indexed)' },
          character: { type: 'number', description: 'Character offset (0-indexed)' },
        },
        required: ['path', 'line', 'character'],
      },
    },
  },
  lsp_get_type_definition: {
    type: 'function',
    function: {
      name: 'lsp_get_type_definition',
      description: 'Go to type definition of a symbol at a position.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          line: { type: 'number', description: 'Line number (0-indexed)' },
          character: { type: 'number', description: 'Character offset (0-indexed)' },
        },
        required: ['path', 'line', 'character'],
      },
    },
  },
  lsp_workspace_symbol: {
    type: 'function',
    function: {
      name: 'lsp_workspace_symbol',
      description: 'Search for symbols across the workspace by name.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name or pattern to search for' },
        },
        required: ['query'],
      },
    },
  },
  lsp_simulate_edit_atomic: {
    type: 'function',
    function: {
      name: 'lsp_simulate_edit_atomic',
      description: 'Simulate a file edit in memory and report diagnostic changes without writing to disk.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to simulate editing' },
          content: { type: 'string', description: 'New file content to simulate' },
        },
        required: ['path', 'content'],
      },
    },
  },
  lsp_get_diagnostics: {
    type: 'function',
    function: {
      name: 'lsp_get_diagnostics',
      description: 'Get current diagnostics (errors, warnings) for a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to get diagnostics for' },
        },
        required: ['path'],
      },
    },
  },
  lsp_get_change_impact: {
    type: 'function',
    function: {
      name: 'lsp_get_change_impact',
      description: 'Analyze the blast radius of changes to a symbol — which files and symbols are affected.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path containing the symbol' },
          line: { type: 'number', description: 'Line number (0-indexed)' },
          character: { type: 'number', description: 'Character offset (0-indexed)' },
        },
        required: ['path', 'line', 'character'],
      },
    },
  },
  lsp_apply_code_action: {
    type: 'function',
    function: {
      name: 'lsp_apply_code_action',
      description: 'Apply a code action (quick fix, refactoring) suggested by the language server.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          line: { type: 'number', description: 'Line number (0-indexed)' },
          character: { type: 'number', description: 'Character offset (0-indexed)' },
          actionTitle: { type: 'string', description: 'Title of the code action to apply' },
        },
        required: ['path', 'line', 'character', 'actionTitle'],
      },
    },
  },
}

// ── Role-to-LSP-tool mapping ──────────────────────────────────────────────────

const LSP_TOOL_SETS = {
  'explore': ['lsp_get_document_symbols', 'lsp_get_hover', 'lsp_get_definition', 'lsp_get_references', 'lsp_get_call_hierarchy'],
  'context-gather': ['lsp_get_document_symbols', 'lsp_get_definition', 'lsp_get_references', 'lsp_get_type_definition'],
  'code-search': ['lsp_get_document_symbols', 'lsp_get_references', 'lsp_workspace_symbol', 'lsp_get_call_hierarchy'],
  'implementation': ['lsp_simulate_edit_atomic', 'lsp_get_diagnostics', 'lsp_get_definition', 'lsp_get_references', 'lsp_get_change_impact', 'lsp_apply_code_action'],
  'general': ['lsp_simulate_edit_atomic', 'lsp_get_diagnostics', 'lsp_get_definition', 'lsp_get_references', 'lsp_get_change_impact', 'lsp_apply_code_action'],
}

/**
 * Build the tool definitions array, merging built-in TOOL_DEFS with
 * role-specific LSP tools when the LSP manager is ready.
 * @param {object|null} lspManager
 * @param {string} agentRole
 * @returns {object[]}
 */
function getToolDefs(lspManager, agentRole) {
  const tools = [...TOOL_DEFS]
  if (lspManager?.getStatus().status === 'ready') {
    const toolNames = LSP_TOOL_SETS[agentRole] || []
    for (const name of toolNames) {
      if (LSP_TOOL_DEFS[name]) {
        tools.push(LSP_TOOL_DEFS[name])
      }
    }
  }
  return tools
}

// ── Context window management ─────────────────────────────────────────────────

/**
 * Build a lightweight file tree string for the project directory.
 * Walks up to 3 levels deep, skips hidden/node_modules dirs, and caps output
 * so it stays under ~1500 tokens. Gives the agent spatial awareness of what
 * exists without burning the entire context window.
 */
function buildFileTree(dir, maxDepth = 3) {
  const lines = []
  const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.next', 'dist', 'build', '.cache', '.vscode', '.maccoder', 'coverage', '.DS_Store'])

  function walk(current, prefix, depth) {
    if (depth > maxDepth) return
    let entries
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { return }
    entries = entries
      .filter(e => !SKIP.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))

    for (let i = 0; i < entries.length; i++) {
      if (lines.length > 200) return // hard cap
      const e = entries[i]
      const isLast = i === entries.length - 1
      const connector = isLast ? '└── ' : '├── '
      const childPrefix = prefix + (isLast ? '    ' : '│   ')
      if (e.isDirectory()) {
        lines.push(`${prefix}${connector}${e.name}/`)
        walk(path.join(current, e.name), childPrefix, depth + 1)
      } else {
        lines.push(`${prefix}${connector}${e.name}`)
      }
    }
  }

  const base = path.basename(dir)
  lines.push(`${base}/`)
  walk(dir, '', 1)
  return lines.join('\n')
}

/**
 * Detect entry-point files in a project directory.
 * Checks package.json main field, then looks for common entry-point filenames.
 * Returns an array of absolute file paths (up to 10).
 */
function detectEntryPoints(cwd) {
  const entries = []
  const seen = new Set()

  function addIfExists(filePath) {
    const abs = path.resolve(cwd, filePath)
    if (!seen.has(abs)) {
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          seen.add(abs)
          entries.push(abs)
        }
      } catch { /* skip */ }
    }
  }

  // 1. Check package.json main field
  try {
    const pkgPath = path.join(cwd, 'package.json')
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg.main && typeof pkg.main === 'string') {
        addIfExists(pkg.main)
      }
    }
  } catch { /* skip */ }

  // 2. Check common entry-point filenames
  const candidates = [
    'index.js', 'index.ts', 'main.js', 'main.ts', 'app.js', 'app.ts',
    'src/index.js', 'src/index.ts', 'src/main.js', 'src/main.ts', 'src/app.js', 'src/app.ts',
  ]
  for (const c of candidates) {
    if (entries.length >= 10) break
    addIfExists(c)
  }

  return entries.slice(0, 10)
}

/**
 * Format an array of LSP document symbols into a compact outline string.
 * Each symbol is rendered as "kind: name" on its own line.
 */
function formatSymbolOutline(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return ''
  const lines = []
  for (const sym of symbols) {
    const kind = sym.kind || 'symbol'
    const name = sym.name || '?'
    lines.push(`- ${kind}: ${name}`)
    // Include direct children if present
    if (Array.isArray(sym.children)) {
      for (const child of sym.children) {
        const ck = child.kind || 'symbol'
        const cn = child.name || '?'
        lines.push(`  - ${ck}: ${cn}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * Build a compact project context string from the file tree and task graph.
 * This replaces the full conversation transcript for resumed sessions,
 * giving the agent awareness of what exists without the token cost.
 *
 * When an lspManager is provided and ready, symbol outlines for entry-point
 * files are included for richer semantic context.
 */
async function buildProjectContext(cwd, taskGraphPath, lspManager) {
  const parts = []

  // 1. File tree
  const tree = buildFileTree(cwd)
  if (tree) {
    parts.push(`## Project File Tree\n\`\`\`\n${tree}\n\`\`\``)
  }

  // 2. Task graph status (if available)
  if (taskGraphPath) {
    try {
      const content = fs.readFileSync(taskGraphPath, 'utf8')
      if (content) {
        // The tasks.md is already compact markdown — include it directly
        // but cap it to avoid blowing up context
        const trimmed = content.length > 3000 ? content.slice(0, 3000) + '\n\n... [truncated]' : content
        parts.push(`## Task Progress\n${trimmed}`)
      }
    } catch { /* task file may not exist */ }
  }

  // 3. Symbol outlines for entry-point files (when LSP is ready)
  if (lspManager?.getStatus().status === 'ready') {
    const entryFiles = detectEntryPoints(cwd)
    const symbolParts = []
    for (const file of entryFiles.slice(0, 10)) {
      try {
        const symbols = await lspManager.call('lsp_get_document_symbols', { path: file })
        if (Array.isArray(symbols) && symbols.length > 0) {
          const outline = formatSymbolOutline(symbols)
          if (outline) {
            symbolParts.push(`### ${path.relative(cwd, file)}\n${outline}`)
          }
        }
      } catch { /* skip file */ }
    }
    if (symbolParts.length > 0) {
      parts.push(`## Symbol Outlines\n${symbolParts.join('\n')}`)
    }
  }

  // Cap total to 4000 chars
  let combined = parts.length > 0 ? parts.join('\n\n') : ''
  if (combined.length > 4000) {
    combined = combined.slice(0, 4000) + '\n... [truncated]'
  }
  return combined
}

/**
 * Estimate token count from a string. Rough heuristic: ~3.5 chars per token
 * for English/code content. Not exact, but good enough for trimming decisions.
 */
function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / 3.5)
}

/**
 * Estimate total tokens in a messages array.
 */
function estimateMessagesTokens(messages) {
  let total = 0
  for (const msg of messages) {
    total += estimateTokens(msg.content || '')
    // Tool calls in assistant messages
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(tc.function?.arguments || '')
        total += estimateTokens(tc.function?.name || '')
      }
    }
    total += 4 // per-message overhead
  }
  return total
}

/**
 * Trim messages to fit within a target token budget.
 * Strategy:
 *  - Always keep the system message (index 0) and the first user message (index 1)
 *  - Always keep the last 4 messages (most recent context)
 *  - Trim tool results in the middle by truncating their content
 *  - If still over budget, drop middle messages entirely
 *
 * @param {Array} messages - The conversation messages array
 * @param {number} maxInputTokens - Target max input tokens
 * @returns {Array} Trimmed messages array
 */
function trimMessages(messages, maxInputTokens) {
  if (messages.length <= 4) return messages
  let current = estimateMessagesTokens(messages)
  if (current <= maxInputTokens) return messages

  // Phase 1: Truncate large tool result messages in the middle
  // Keep first 2 and last 4 messages intact
  const safeStart = 2
  const safeEnd = messages.length - 4
  for (let i = safeStart; i < safeEnd && current > maxInputTokens; i++) {
    const msg = messages[i]
    if (msg.role === 'tool' && msg.content && msg.content.length > 2000) {
      const oldLen = msg.content.length
      msg.content = msg.content.slice(0, 1500) + '\n\n... [trimmed to save context space]'
      current -= Math.ceil((oldLen - msg.content.length) / 3.5)
    }
  }
  if (current <= maxInputTokens) return messages

  // Phase 2: Drop middle message pairs (assistant + tool results) from oldest
  const trimmed = [...messages]
  let i = safeStart
  while (i < trimmed.length - 4 && estimateMessagesTokens(trimmed) > maxInputTokens) {
    // Remove one message at a time from the middle
    trimmed.splice(i, 1)
  }

  return trimmed
}

// ── JSON repair for malformed tool arguments from local LLMs ──────────────────

/**
 * Attempt to repair malformed JSON from local model tool calls.
 * Common issues:
 *  - Unescaped newlines inside string values
 *  - Unescaped control characters
 *  - Trailing commas before closing braces/brackets
 *  - Truncated strings (missing closing quote / braces)
 *  - Unescaped backslashes
 *
 * Returns the parsed object on success, or null on failure.
 */
function repairJSON(raw) {
  if (!raw || typeof raw !== 'string') return null

  let s = raw.trim()

  // 1. Fix unescaped control characters inside JSON string values.
  //    Walk through the string tracking whether we're inside a JSON string.
  //    If we encounter a raw newline/tab/etc inside a string, escape it.
  try {
    let out = ''
    let inString = false
    let i = 0
    while (i < s.length) {
      const ch = s[i]
      if (inString) {
        if (ch === '\\') {
          // Escaped character — pass through both chars
          out += ch + (s[i + 1] || '')
          i += 2
          continue
        }
        if (ch === '"') {
          // Possible end of string — but check if this is an unescaped quote
          // inside a value (common in code content). Heuristic: if the next
          // non-whitespace char is NOT a colon, comma, }, ], or end-of-string,
          // it's likely an embedded quote that should be escaped.
          const rest = s.slice(i + 1)
          const nextSignificant = rest.match(/^\s*(.)/)
          const nextCh = nextSignificant ? nextSignificant[1] : ''
          if (nextCh && !':,}]'.includes(nextCh) && nextCh !== '') {
            // Likely an unescaped quote inside a string value — escape it
            out += '\\"'
            i++
            continue
          }
          inString = false
          out += ch
          i++
          continue
        }
        if (ch === '\n') { out += '\\n'; i++; continue }
        if (ch === '\r') { out += '\\r'; i++; continue }
        if (ch === '\t') { out += '\\t'; i++; continue }
        out += ch
        i++
      } else {
        if (ch === '"') { inString = true }
        out += ch
        i++
      }
    }
    s = out
  } catch { /* if the walker fails, continue with original */ }

  // 2. Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1')

  // 3. Try parsing now
  try { return JSON.parse(s) } catch { /* continue to more aggressive fixes */ }

  // 4. If truncated (missing closing braces/quotes), try to close them
  //    Count open braces/brackets and add missing closers
  let braces = 0, brackets = 0, inStr = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && inStr) { i++; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') braces++
    else if (ch === '}') braces--
    else if (ch === '[') brackets++
    else if (ch === ']') brackets--
  }
  // If we're still inside a string, close it
  if (inStr) s += '"'
  // Remove any trailing incomplete key-value pair (e.g. `, "key": "trunc`)
  // by trimming back to the last complete value
  s = s.replace(/,\s*"[^"]*":\s*"[^"]*$/, '')
  s = s.replace(/,\s*"[^"]*":\s*$/, '')
  // Close open braces/brackets
  for (let i = 0; i < brackets; i++) s += ']'
  for (let i = 0; i < braces; i++) s += '}'

  // 5. Final trailing comma cleanup and parse
  s = s.replace(/,\s*([}\]])/g, '$1')
  try { return JSON.parse(s) } catch { return null }
}

/**
 * Extract write_file arguments from malformed JSON by finding the path and
 * treating everything between the content value quotes as raw content.
 * This handles the common case where code content breaks JSON escaping.
 *
 * @param {string} raw - The raw (malformed) JSON arguments string
 * @returns {{ path: string, content: string } | null}
 */
function extractWriteFileArgs(raw) {
  if (!raw) return null

  // Try to extract "path" value — this is usually short and well-formed
  const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/)
  if (!pathMatch) return null
  const filePath = pathMatch[1]

  // Try to extract "content" value — find the start of the content string
  // and take everything until the closing pattern
  const contentStart = raw.indexOf('"content"')
  if (contentStart === -1) return null

  // Find the opening quote of the content value
  const afterKey = raw.indexOf(':', contentStart + 9)
  if (afterKey === -1) return null

  // Skip whitespace and find the opening quote
  let i = afterKey + 1
  while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n' || raw[i] === '\r')) i++
  if (raw[i] !== '"') return null
  i++ // skip opening quote

  // Now extract everything until we find the closing pattern: "}
  // We look for the last occurrence of "} or "\n} to find the end
  let content = ''
  const remaining = raw.slice(i)

  // Try to find the end: look for "} at the end (with optional whitespace)
  const endPatterns = [/"\s*\}\s*$/, /"\s*,\s*\}\s*$/, /"\s*$/]
  let endIdx = -1
  for (const pat of endPatterns) {
    const m = remaining.match(pat)
    if (m) { endIdx = m.index; break }
  }

  if (endIdx > 0) {
    content = remaining.slice(0, endIdx)
  } else {
    // No clean end found — take everything and strip trailing junk
    content = remaining.replace(/"\s*\}?\s*$/, '')
  }

  // Unescape the content (it may have some valid JSON escapes mixed with raw chars)
  content = content
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')

  if (!content) return null
  return { path: filePath, content }
}

/**
 * Extract edit_file arguments from malformed JSON.
 */
function extractEditFileArgs(raw) {
  if (!raw) return null
  const pathMatch = raw.match(/"path"\s*:\s*"([^"]+)"/)
  if (!pathMatch) return null

  // For edit_file, try repairJSON first since old_string/new_string are usually shorter
  const repaired = repairJSON(raw)
  if (repaired && repaired.path && repaired.old_string != null && repaired.new_string != null) {
    return repaired
  }
  return null
}

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name, args, cwd, browserInstance, lspManager) {
  // Route web_* tools to the web tools module
  if (name === 'web_search' || name === 'web_fetch') {
    const apiKeys = getApiKeys()
    return executeWebTool(name, args, { brave: apiKeys.brave })
  }

  // Route browser_* tools to the playwright instance
  if (name.startsWith('browser_') && browserInstance) {
    return browserInstance.execute(name, args)
  }

  // Route lsp_* tools to the LSP manager
  if (name.startsWith('lsp_') && lspManager) {
    const lspStatus = lspManager.getStatus().status
    if (lspStatus !== 'ready' && lspStatus !== 'degraded') {
      return { error: 'LSP not available. Use built-in tools instead.' }
    }
    try {
      const result = await Promise.race([
        lspManager.call(name, args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('LSP tool timed out (30s)')), 30000))
      ])
      return { result: JSON.stringify(result) }
    } catch (err) {
      return { error: `LSP tool error: ${err.message}. Try using built-in alternatives.` }
    }
  }

  // ── path validation: prevent traversal outside the working directory ──
  function validatePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return { error: 'path is required and must be a string' }
    if (filePath.includes('\0')) return { error: 'path contains null bytes' }
    const resolved = path.resolve(cwd, filePath)
    // Ensure the resolved path is within the cwd (or is the cwd itself)
    if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
      return { error: `Path "${filePath}" resolves outside the working directory` }
    }
    return { resolved }
  }

  try {
    switch (name) {
      case 'read_file': {
        const v = validatePath(args.path)
        if (v.error) return v
        const p = v.resolved
        if (!fs.existsSync(p)) return { error: `File not found: ${args.path}` }
        const stat = fs.statSync(p)
        if (stat.size > 512 * 1024) return { error: `File too large (${(stat.size / 1024).toFixed(0)}KB). Read a smaller file or use search_files.` }
        return { result: fs.readFileSync(p, 'utf-8') }
      }
      case 'write_file': {
        if (typeof args.content !== 'string') return { error: 'content must be a string' }
        const v = validatePath(args.path)
        if (v.error) return v
        const p = v.resolved
        const dir = path.dirname(p)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(p, args.content, 'utf-8')
        return { result: `Wrote ${args.content.length} chars to ${args.path}` }
      }
      case 'edit_file': {
        if (typeof args.old_string !== 'string') return { error: 'old_string must be a string' }
        if (typeof args.new_string !== 'string') return { error: 'new_string must be a string' }
        const v = validatePath(args.path)
        if (v.error) return v
        const p = v.resolved
        if (!fs.existsSync(p)) return { error: `File not found: ${args.path}` }
        const content = fs.readFileSync(p, 'utf-8')
        if (!content.includes(args.old_string)) return { error: `old_string not found in ${args.path}. Make sure it matches exactly.` }
        const count = content.split(args.old_string).length - 1
        if (count > 1) return { error: `old_string found ${count} times in ${args.path}. Make it more specific so it matches exactly once.` }
        fs.writeFileSync(p, content.replace(args.old_string, args.new_string), 'utf-8')
        return { result: `Edited ${args.path}` }
      }
      case 'list_dir': {
        const v = validatePath(args.path || '.')
        if (v.error) return v
        const p = v.resolved
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
        if (typeof args.command !== 'string' || !args.command.trim()) return { error: 'command must be a non-empty string' }
        // Block obviously dangerous commands
        const dangerous = /\b(rm\s+-rf\s+\/|mkfs|dd\s+if=|:(){ :|fork\s*bomb)\b/i
        if (dangerous.test(args.command)) return { error: 'Command blocked for safety' }
        try {
          const out = execSync(args.command, {
            cwd,
            encoding: 'utf-8',
            timeout: 120000,
            maxBuffer: 2 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          return { result: out || '(no output)' }
        } catch (execErr) {
          // execSync throws on non-zero exit — capture stdout+stderr
          const stdout = execErr.stdout || ''
          const stderr = execErr.stderr || ''
          const combined = (stdout + '\n' + stderr).trim()
          const exitCode = execErr.status ?? 1
          return { error: `Command failed (exit ${exitCode}):\n${combined || execErr.message}` }
        }
      }
      case 'search_files': {
        if (typeof args.pattern !== 'string' || !args.pattern.trim()) return { error: 'pattern must be a non-empty string' }
        const searchV = validatePath(args.path || '.')
        if (searchV.error) return searchV
        const searchPath = searchV.resolved
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
  constructor(sink, opts = {}) {
    this.sink = sink
    this._aborted = false
    this._activeReq = null
    this._browserInstance = null
    this._lspManager = opts.lspManager || null
    this._agentRole = opts.agentRole || 'general'
  }

  setLspManager(lspManager) {
    this._lspManager = lspManager
  }

  send(channel, data) {
    this.sink.send(channel, data)
  }

  async run({ prompt, cwd, permissionMode, model, images, conversationHistory, systemPromptOverride, samplingParams, taskGraphPath }) {
    this._aborted = false
    this._samplingParams = samplingParams || {}

    // Set up browser instance
    this._browserInstance = createPlaywrightInstance()

    // If images are attached, call the vision endpoint directly (same as Vision tab)
    // instead of relying on tool calls which the local model doesn't handle reliably.
    let imageContext = ''
    if (images && images.length > 0) {
      this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Analyzing ${images.length} image(s)...` })
      try {
        const descriptions = []
        for (let i = 0; i < images.length; i++) {
          const img = images[i]
          const content = [
            { type: 'text', text: prompt || 'Describe what you see in this image in detail.' },
            { type: 'image_url', image_url: { url: img.b64 } },
          ]
          const body = JSON.stringify({ messages: [{ role: 'user', content }], max_tokens: 1024 })
          const result = await new Promise((resolve, reject) => {
            const req = http.request({
              hostname: '127.0.0.1', port: SERVER_PORT,
              path: '/v1/chat/completions', method: 'POST',
              timeout: 120000,
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (res) => {
              let data = ''
              res.on('data', chunk => data += chunk)
              res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error(data || 'Empty response')) } })
            })
            req.on('timeout', () => { req.destroy(); reject(new Error('Vision request timed out')) })
            req.on('error', reject)
            req.write(body)
            req.end()
          })
          const desc = result.choices?.[0]?.message?.content || 'Could not analyze image.'
          descriptions.push(`[Image ${i + 1}: ${img.name}]\n${desc}`)
        }
        imageContext = `\n\nThe user attached image(s). Here is what the vision model sees:\n\n${descriptions.join('\n\n')}`
      } catch (err) {
        imageContext = `\n\n(The user attached images but vision analysis failed: ${err.message})`
      }
    }

    const workDir = cwd || process.cwd()
    const systemPrompt = systemPromptOverride || this._buildSystemPrompt(workDir, permissionMode)

    // Build the final prompt — use lightweight project context when conversation
    // history is large (>8 messages), falling back to full transcript for short chats.
    // This prevents oversized prompts that choke local models on session resume.
    let finalPrompt = ''

    if (conversationHistory && conversationHistory.length > 0) {
      const estimatedHistoryTokens = conversationHistory.reduce((sum, m) => sum + estimateTokens(m.content), 0)

      if (estimatedHistoryTokens > 6000) {
        // Large history — use file tree + task graph instead of full transcript.
        // Keep only the last 2 exchanges for immediate conversational context.
        const projectCtx = await buildProjectContext(workDir, taskGraphPath, this._lspManager)
        const recentHistory = conversationHistory.slice(-4)
        const recentTranscript = recentHistory.map(m => {
          const role = m.role === 'user' ? 'User' : 'Assistant'
          // Trim long assistant messages to just the first 500 chars
          const content = m.role === 'assistant' && m.content.length > 500
            ? m.content.slice(0, 500) + '...'
            : m.content
          return `[${role}]: ${content}`
        }).join('\n\n')

        finalPrompt = `${projectCtx}\n\n## Recent Conversation\n${recentTranscript}\n\n---\n\n`
      } else {
        // Short history — include full transcript (original behavior)
        const transcript = conversationHistory.map(m => {
          const role = m.role === 'user' ? 'User' : 'Assistant'
          return `[${role}]: ${m.content}`
        }).join('\n\n')
        finalPrompt = `Here is the conversation so far:\n\n${transcript}\n\n---\n\n`
      }
    }

    finalPrompt += prompt + imageContext

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: finalPrompt },
    ]

    this.send('qwen-event', { type: 'session-start', cwd: workDir })

    try {
      // Wait for the server to be ready before starting the agent loop
      await this._waitForServer()
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
    let consecutiveErrors = 0
    let lastTextResponses = []  // Track recent text-only responses for repetition detection
    let consecutivePlanningNudges = 0  // Track how many times we've nudged for planning-only responses
    for (let turn = 0; turn < maxTurns; turn++) {
      if (this._aborted) return

      // Retry on transient connection errors (ECONNRESET, ECONNREFUSED)
      let completion = null

      // Trim context if it's getting too large — keep input under ~24K tokens
      // to leave room for the model's output (Qwen 3 supports 32K+ native context,
      // Qwen 3.6 supports 1M, but local inference slows dramatically with huge prompts)
      const MAX_INPUT_TOKENS = 24000
      if (estimateMessagesTokens(messages) > MAX_INPUT_TOKENS) {
        const before = messages.length
        const trimmed = trimMessages(messages, MAX_INPUT_TOKENS)
        messages.length = 0
        messages.push(...trimmed)
        if (messages.length < before) {
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Trimmed context: ${before} → ${messages.length} messages (~${estimateMessagesTokens(messages)} tokens)` })
        }
      }

      for (let attempt = 0; attempt < 6; attempt++) {
        if (this._aborted) return
        try {
          completion = await this._streamCompletion(messages, cwd, model)
          break
        } catch (err) {
          if (this._aborted) return
          const code = err.code || ''
          const isTransient = code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE'
          if (isTransient && attempt < 5) {
            // Server may need time to restart and reload model after a crash
            const delay = attempt === 0 ? 5 : Math.min((attempt + 1) * 3, 15)
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Server not ready (${code}), retrying in ${delay}s... (${attempt + 1}/5)` })
            // Sleep in 1s increments so we can check _aborted
            for (let w = 0; w < delay && !this._aborted; w++) {
              await new Promise(r => setTimeout(r, 1000))
            }
            if (this._aborted) return
            continue
          }
          throw err
        }
      }

      const { text, toolCalls, usage, finishReason } = completion

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

      // Guard: empty completion — server returned nothing (0 tokens, no text, no tools).
      // This can happen when the prompt is too large for the model or the server
      // returned an error as a non-SSE response. Retry once with trimmed context,
      // then fail gracefully instead of silently finishing.
      if (!text && (!toolCalls || toolCalls.length === 0) && !usage) {
        if (turn === 0 && messages.length >= 2) {
          // First turn empty — likely oversized prompt from conversation history.
          // Trim the user message if it contains a conversation transcript.
          const userMsg = messages[messages.length - 1]
          if (userMsg && userMsg.role === 'user' && userMsg.content && userMsg.content.length > 4000) {
            const sepIdx = userMsg.content.lastIndexOf('---\n\n')
            if (sepIdx > 0) {
              // Keep only the part after the separator (the actual prompt)
              const actualPrompt = userMsg.content.slice(sepIdx + 5)
              userMsg.content = actualPrompt
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: 'Empty response — trimmed conversation history and retrying...' })
              continue
            }
          }
        }
        this.send('qwen-event', {
          type: 'result',
          subtype: 'error',
          is_error: true,
          result: 'Server returned an empty response. The prompt may be too large — try starting a new session or shortening your message.',
        })
        return
      }

      // No tool calls — check if we hit the token limit
      if (!toolCalls || toolCalls.length === 0) {
        // If the model hit the token limit, it may have been trying to output
        // code as text instead of using write_file. Nudge it to use tools.
        if (finishReason === 'length' && text && text.length > 200) {
          // Check if this is a repetition of previous length-truncated output
          lastTextResponses.push(text.slice(0, 500))
          if (lastTextResponses.length > 3) lastTextResponses.shift()
          const prevSimilar = lastTextResponses.length >= 2 &&
            lastTextResponses[lastTextResponses.length - 2].slice(0, 200) === lastTextResponses[lastTextResponses.length - 1].slice(0, 200)

          if (prevSimilar) {
            // Model is stuck generating the same long text repeatedly
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: 'Repetition detected in length-truncated output. Resetting context.' })
            // Aggressive context reset — keep only essentials
            const systemMsg = messages.find(m => m.role === 'system')
            const userMsg = messages.find(m => m.role === 'user')
            messages.length = 0
            if (systemMsg) messages.push(systemMsg)
            if (userMsg) messages.push(userMsg)
            messages.push({
              role: 'system',
              content: 'You are STUCK generating the same text repeatedly. STOP outputting text. You MUST use a tool call in your next response. Call write_file, edit_file, read_file, or bash. Do NOT output any text — only a tool call.',
            })
            lastTextResponses = []
            continue
          }

          messages.push({ role: 'assistant', content: text })
          messages.push({
            role: 'system',
            content: 'STOP. You were outputting code as text which is not allowed. You MUST use tools instead:\n- Use write_file to create or overwrite files (keep under 150 lines per call)\n- Use edit_file to make surgical edits\n- For large files, use bash with heredoc: bash({command: "cat > file << \'EOF\'\\n...\\nEOF"})\nNever output code blocks in your text response. Break your work into small steps using one tool call at a time.',
          })
          continue
        }

        // If the model described what it plans to do but didn't actually do it,
        // nudge it to take action. Look for planning language without tool calls.
        const planningPatterns = /\b(let me|i('ll| will)|let's|i need to|i should|first.*then|i'm going to)\b/i
        if (text && text.length > 50 && planningPatterns.test(text) && turn < maxTurns - 1) {
          consecutivePlanningNudges++

          // Repetition detection: check if the model is producing similar text
          // across consecutive turns (stuck in a loop)
          lastTextResponses.push(text.slice(0, 500))
          if (lastTextResponses.length > 3) lastTextResponses.shift()

          const isRepeating = lastTextResponses.length >= 2 && (() => {
            const prev = lastTextResponses[lastTextResponses.length - 2]
            const curr = lastTextResponses[lastTextResponses.length - 1]
            // Check for high similarity: same first 200 chars or >60% overlap
            if (prev.slice(0, 200) === curr.slice(0, 200)) return true
            const words = new Set(prev.toLowerCase().split(/\s+/))
            const currWords = curr.toLowerCase().split(/\s+/)
            const overlap = currWords.filter(w => words.has(w)).length
            return currWords.length > 0 && (overlap / currWords.length) > 0.6
          })()

          if (isRepeating || consecutivePlanningNudges >= 3) {
            // Model is stuck in a repetition loop — take aggressive corrective action
            this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Repetition detected (${consecutivePlanningNudges} planning-only turns). Breaking loop.` })

            // Strip all previous planning messages and nudges to reset context
            const cleanedMessages = messages.filter(m =>
              !(m.role === 'system' && m.content && m.content.includes('Use your tools NOW')) &&
              !(m.role === 'system' && m.content && m.content.includes('You are STUCK'))
            )
            // Keep only system prompt + user prompt + last tool result (if any)
            const systemMsg = cleanedMessages.find(m => m.role === 'system')
            const userMsg = cleanedMessages.find(m => m.role === 'user')
            const lastToolResult = [...cleanedMessages].reverse().find(m => m.role === 'tool')
            const lastAssistantWithTools = [...cleanedMessages].reverse().find(m => m.role === 'assistant' && m.tool_calls)

            messages.length = 0
            if (systemMsg) messages.push(systemMsg)
            if (userMsg) messages.push(userMsg)
            if (lastAssistantWithTools && lastToolResult) {
              messages.push(lastAssistantWithTools)
              messages.push(lastToolResult)
            }
            messages.push({
              role: 'system',
              content: 'You are STUCK in a repetition loop. STOP planning and describing. You MUST call a tool RIGHT NOW in your very next response. Pick the single most important action and do it. If you need to read a file, call read_file. If you need to write code, call write_file. Do NOT output any text — only a tool call.',
            })
            consecutivePlanningNudges = 0
            lastTextResponses = []
            continue
          }

          messages.push({ role: 'assistant', content: text })
          messages.push({
            role: 'system',
            content: 'You described what you plan to do but did not take action. Use your tools NOW. Call read_file, edit_file, write_file, or bash to actually do the work. Do not just describe — act.',
          })
          continue
        }

        // Normal completion — send final assistant message
        this.send('qwen-event', {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: text,
        })
        return
      }

      // Check for truncated tool calls — model hit token limit mid-tool-call
      // The arguments JSON will be incomplete and unparseable.
      if (finishReason === 'length' && toolCalls && toolCalls.length > 0) {
        // Check if any tool call has truncated (unparseable) arguments
        let hasTruncated = false
        for (const tc of toolCalls) {
          try { JSON.parse(tc.function.arguments) } catch {
            // Try repair before declaring truncated
            const repaired = repairJSON(tc.function.arguments)
            if (repaired) {
              tc.function.arguments = JSON.stringify(repaired)
            } else if (tc.function.name === 'write_file') {
              // For write_file, try direct extraction — content may be truncated but usable
              const extracted = extractWriteFileArgs(tc.function.arguments)
              if (extracted) {
                tc.function.arguments = JSON.stringify(extracted)
                this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Recovered truncated write_file (${extracted.content.length} chars)` })
              } else {
                hasTruncated = true; break
              }
            } else {
              hasTruncated = true; break
            }
          }
        }
        if (hasTruncated) {
          // Don't try to execute truncated tool calls — tell the model to break it up
          messages.push({ role: 'assistant', content: text || 'I was writing a file but hit the output limit.' })
          messages.push({
            role: 'system',
            content: 'Your write_file tool call was TRUNCATED — the file was NOT written. You MUST write large files in chunks:\n1. write_file with the first ~150 lines\n2. bash({command: "cat >> filepath << \'CHUNK_END\'\\n...next 150 lines...\\nCHUNK_END"}) to append more\n3. Repeat until done\nAlternatively, write the entire file using bash with heredoc:\nbash({command: "cat > filepath << \'FILEEOF\'\\n...all content...\\nFILEEOF"})\nDo this NOW. Start with the first chunk.',
          })
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: 'Tool call truncated — asking model to write in chunks' })
          continue
        }
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
        try { fnArgs = JSON.parse(tc.function.arguments) } catch (parseErr) {
          const raw = tc.function.arguments || ''

          // Strategy 1: For write_file, extract path and content directly from raw string
          // This bypasses JSON entirely and handles unescaped code content
          if (fnName === 'write_file') {
            const extracted = extractWriteFileArgs(raw)
            if (extracted) {
              fnArgs = extracted
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Extracted write_file args directly (bypassed JSON)` })
            } else {
              // Try repairJSON as fallback
              const repaired = repairJSON(raw)
              if (repaired && typeof repaired === 'object' && repaired.path) {
                fnArgs = repaired
                this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Repaired malformed JSON in write_file` })
              } else {
                const guidance = 'Your file content broke JSON serialization. Use the bash tool with heredoc instead:\nbash({command: "cat > filepath << \'FILEEOF\'\\n...content...\\nFILEEOF"})\nOr write smaller files (under 100 lines) to avoid this issue.'
                this.send('qwen-event', { type: 'tool-result', tool_use_id: tc.id, content: guidance, is_error: true })
                messages.push({ role: 'tool', tool_call_id: tc.id, content: guidance })
                continue
              }
            }
          } else if (fnName === 'edit_file') {
            // Strategy 2: For edit_file, try extractEditFileArgs
            const extracted = extractEditFileArgs(raw)
            if (extracted) {
              fnArgs = extracted
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Extracted edit_file args from malformed JSON` })
            } else {
              const guidance = 'Your edit_file content broke JSON serialization. Use the bash tool with sed or heredoc instead.'
              this.send('qwen-event', { type: 'tool-result', tool_use_id: tc.id, content: guidance, is_error: true })
              messages.push({ role: 'tool', tool_call_id: tc.id, content: guidance })
              continue
            }
          } else {
            // Strategy 3: For other tools, try repairJSON then split-objects
            const repaired = repairJSON(raw)
            if (repaired && typeof repaired === 'object') {
              fnArgs = repaired
              this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Repaired malformed JSON in ${fnName} tool call` })
            } else {
              const splitObjects = raw.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)
              if (splitObjects && splitObjects.length > 1) {
                let parsed = false
                for (const obj of splitObjects) {
                  const fixed = repairJSON(obj)
                  if (fixed && typeof fixed === 'object' && Object.keys(fixed).length > 0) {
                    fnArgs = fixed; parsed = true; break
                  }
                  try { fnArgs = JSON.parse(obj); if (Object.keys(fnArgs).length > 0) { parsed = true; break } } catch { /* try next */ }
                }
                if (!parsed) {
                  const errContent = `Invalid JSON in tool arguments: ${parseErr.message}. Raw: ${raw.slice(0, 200)}`
                  this.send('qwen-event', { type: 'tool-result', tool_use_id: tc.id, content: errContent, is_error: true })
                  messages.push({ role: 'tool', tool_call_id: tc.id, content: errContent })
                  continue
                }
              } else {
                const errContent = `Invalid JSON in tool arguments: ${parseErr.message}. Raw: ${raw.slice(0, 200)}`
                this.send('qwen-event', { type: 'tool-result', tool_use_id: tc.id, content: errContent, is_error: true })
                messages.push({ role: 'tool', tool_call_id: tc.id, content: errContent })
                continue
              }
            }
          }
        }

        // Emit tool-use event
        this.send('qwen-event', { type: 'tool-use', id: tc.id, name: fnName, input: fnArgs })

        // Speculative edit hook: simulate write_file before executing it
        let speculativeMsg = ''
        if (fnName === 'write_file' && this._lspManager?.getStatus().status === 'ready') {
          try {
            const simResult = await Promise.race([
              this._lspManager.call('lsp_simulate_edit_atomic', { path: fnArgs.path, content: fnArgs.content }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('speculative edit timed out')), 10000))
            ])
            if (simResult?.newDiagnostics?.length > 0) {
              const diagLines = simResult.newDiagnostics.map(d => `  ${d.severity || 'error'}: ${d.message} (line ${d.line || '?'})`).join('\n')
              speculativeMsg = `⚠️ Speculative edit preview found new diagnostics:\n${diagLines}\n\n`
            } else {
              speculativeMsg = '✅ Speculative edit validation passed — no new errors detected.\n\n'
            }
          } catch {
            // On failure/timeout, skip speculative check and proceed normally
          }
        }

        // Execute
        const result = await executeTool(fnName, fnArgs, cwd, this._browserInstance, this._lspManager)
        const isError = !!result.error
        let content = result.error || result.result

        // Prepend speculative edit message if available
        if (speculativeMsg && content) {
          content = speculativeMsg + content
        }

        // Post-edit diagnostic hook: check for errors after write_file/edit_file
        if ((fnName === 'write_file' || fnName === 'edit_file') && !isError && this._lspManager?.getStatus().status === 'ready') {
          try {
            const diags = await Promise.race([
              this._lspManager.call('lsp_get_diagnostics', { path: fnArgs.path }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('diagnostic timeout')), 10000))
            ])
            if (diags?.errors?.length > 0) {
              const errorDiags = diags.errors.filter(d => d.severity === 'error')
              if (errorDiags.length > 0) {
                const diagLines = errorDiags.map(d => `  ${d.severity || 'error'}: ${d.message} (line ${d.line || '?'})`).join('\n')
                content = `⚠️ Edit introduced errors:\n${diagLines}\n\n${content}`
              }
            }
          } catch {
            // On failure/timeout, skip diagnostics silently
          }
        }

        // Truncate large tool outputs to avoid blowing up the context window.
        // For local models, keep outputs lean to preserve generation quality.
        if (content && content.length > 8000) {
          content = content.slice(0, 8000) + '\n\n... [truncated — output was ' + (content.length / 1024).toFixed(0) + 'KB. Use more specific queries to get smaller results.]'
        }

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

        if (isError) consecutiveErrors++
        else consecutiveErrors = 0
      }

      // Reset planning/repetition counters when tools are used (model is making progress)
      consecutivePlanningNudges = 0
      lastTextResponses = []

      // If too many consecutive errors, nudge the model
      if (consecutiveErrors >= 3) {
        messages.push({
          role: 'system',
          content: 'WARNING: Multiple consecutive tool errors. Double-check your tool arguments. For file tools, the "path" parameter must be a non-empty string. Use list_dir first if you are unsure of file paths.',
        })
        consecutiveErrors = 0
      }

      // Detect if the agent wrote a tasks.md file — signal the renderer
      // so the orchestrator can pick it up after the session ends.
      const writeCall = toolCalls.find(tc => tc.function.name === 'write_file')
      if (writeCall) {
        try {
          const writeArgs = JSON.parse(writeCall.function.arguments)
          const writtenPath = writeArgs.path || ''
          if (writtenPath.endsWith('tasks.md') || writtenPath.endsWith('todo.md')) {
            const resolvedPath = path.resolve(cwd, writtenPath)
            this.send('qwen-event', { type: 'tasks-file-written', path: resolvedPath })
          }
        } catch (_) { /* ignore parse errors */ }
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
   * Wait for the MLX server to be reachable before starting work.
   * Shows status updates so the user knows what's happening.
   */
  async _waitForServer(maxWait = 60000) {
    const start = Date.now()
    let attempt = 0
    while (Date.now() - start < maxWait) {
      if (this._aborted) return
      try {
        await new Promise((resolve, reject) => {
          const req = http.get(`${SERVER_URL}/admin/status`, { timeout: 3000 }, (res) => {
            let d = ''; res.on('data', c => d += c)
            res.on('end', () => resolve(d))
          })
          req.on('error', reject)
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
        })
        return // server is up
      } catch {
        attempt++
        if (attempt === 1) {
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: 'Waiting for server to be ready...' })
        } else {
          const elapsed = Math.round((Date.now() - start) / 1000)
          this.send('qwen-event', { type: 'system', subtype: 'debug', data: `Waiting for server... (${elapsed}s)` })
        }
        // Sleep 2s, checking abort each second
        for (let w = 0; w < 2 && !this._aborted; w++) {
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    }
    throw new Error('Server not available. It may still be loading a model — try again in a moment.')
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
        tools: getToolDefs(this._lspManager, this._agentRole),
        stream: true,
        max_tokens: 16384,
      }
      // Merge sampling parameters (temperature, top_p, repetition_penalty)
      if (this._samplingParams) {
        if (this._samplingParams.temperature != null) body.temperature = this._samplingParams.temperature
        if (this._samplingParams.top_p != null) body.top_p = this._samplingParams.top_p
        if (this._samplingParams.repetition_penalty != null) body.repetition_penalty = this._samplingParams.repetition_penalty
      }

      let accumulated = ''
      let toolCalls = []
      let usage = null
      let finishReason = null
      let buf = ''

      try {
        const { res, req } = await streamSSE(`${SERVER_URL}/v1/chat/completions`, body)
        this._activeReq = req

        // Check for HTTP errors — server may return JSON error instead of SSE stream
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = ''
          res.on('data', c => errBody += c)
          res.on('end', () => {
            this._activeReq = null
            let errMsg = `Server returned HTTP ${res.statusCode}`
            try { const parsed = JSON.parse(errBody); errMsg = parsed.error?.message || parsed.detail || errMsg } catch {}
            reject(new Error(errMsg))
          })
          return
        }

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
            // OpenAI streams tool_calls incrementally: each chunk has an index,
            // and name/arguments are built up across multiple deltas.
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                if (!toolCalls[idx]) {
                  toolCalls[idx] = {
                    id: tc.id || `call_${idx}`,
                    type: 'function',
                    function: { name: '', arguments: '' },
                  }
                }
                if (tc.id) toolCalls[idx].id = tc.id
                if (tc.function?.name) {
                  // Name is sent once (not streamed incrementally like arguments),
                  // so set it rather than append to avoid duplication
                  if (!toolCalls[idx].function.name) {
                    toolCalls[idx].function.name = tc.function.name
                  }
                }
                if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments
              }
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

**Web search & fetch tools:**
- web_search: Search the web using Brave Search. Returns titles, URLs, and descriptions. Use this to find documentation, solutions, tutorials, or any information online.
- web_fetch: Fetch a web page and extract its readable text. Use after web_search to read full page content, or to scrape any URL directly.

**Planning — Task Graph:**
When the user asks you to plan, outline tasks, or build something complex, write a task graph file using write_file. The file should be at .maccoder/tasks.md (or .maccoder/todo.md). The orchestrator will then execute each task automatically using a subagent.

Task graph format:
- [ ] 1 Task description          (not started)
- [-] 2 Another task              (in progress)
- [x] 3 Completed task            (done)
- [!] 4 Failed task               (failed)

Tasks are executed sequentially (each depends on the previous sibling). After writing the task file, STOP and let the orchestrator take over.

Example:
\`\`\`markdown
# Implementation Plan

- [ ] 1 Set up project structure and dependencies
- [ ] 2 Create the main application entry point
- [ ] 3 Implement core feature logic
- [ ] 4 Add error handling and validation
- [ ] 5 Write tests and verify
\`\`\`

When the user asks you to make changes to code:
1. First read the relevant files to understand the current state
2. Make changes using write_file or edit_file (one focused change at a time)
3. If needed, run tests or verify with bash

When the user asks you to browse, research, or interact with websites, use the browser tools directly. Call browser_navigate first, then use other browser tools to interact with the page.

Be direct and efficient. Make the changes the user asks for. Do NOT just describe what you plan to do — actually do it using tools. If you need to read a file, call read_file. If you need to fix code, call edit_file. Always take action, never just narrate.

CRITICAL FILE SIZE LIMIT: Each write_file call must be under 200 lines. For larger files:
1. Write the first ~150 lines with write_file
2. Use bash with heredoc to append the next chunk: bash({command: "cat >> file.js << 'CHUNK_END'\\n...code...\\nCHUNK_END"})
3. Repeat until the file is complete
NEVER try to write an entire large file in a single write_file call — it WILL be truncated or the JSON will break and the file will NOT be written.

IMPORTANT: When writing code files, avoid putting backticks, complex template literals, or deeply nested quotes in write_file content. If the file contains such characters, prefer using bash with heredoc syntax instead.

CRITICAL: When implementing code changes, you MUST use the write_file or edit_file tools to actually create or modify files. NEVER just output code in your text response — that does nothing. The user cannot copy-paste from chat. Always use the file tools to make real changes on disk.
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
  }
}

module.exports = { DirectBridge, WindowSink, CallbackSink, WorkerSink, executeTool, getToolDefs, LSP_TOOL_SETS, LSP_TOOL_DEFS, buildProjectContext, detectEntryPoints, formatSymbolOutline }
