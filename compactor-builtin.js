/**
 * Built-in compactor — pure JS implementation that works without Python/pip.
 * Provides message compression and text summarization using token-aware truncation.
 * Falls back to this when claw-compactor Python package is not installed.
 */

/**
 * Rough token count estimate (~3.5 chars per token for English text/code).
 * Aligned with direct-bridge.js estimateTokens for consistent thresholds.
 */
function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / 3.5)
}

/**
 * Compress a list of chat messages by summarizing older ones.
 * Keeps recent messages intact, compresses older ones.
 * System messages (role === 'system') are protected from compression and
 * preserved in their original position — they carry the system prompt,
 * role preamble, tool rules, steering docs, and file tree which the agent
 * needs throughout the entire session.
 */
function compressMessages(messages, options = {}) {
  const keepRecent = options.keepRecent || 10
  const maxTokensPerMsg = options.maxTokensPerMsg || 500

  if (messages.length <= keepRecent) {
    return { messages, stats: { compressed: false, reason: 'below threshold' } }
  }

  // ── Protect system messages from compression ────────────────────────────
  // Extract all system messages with their original indices so we can
  // re-insert them untouched after compressing the conversation messages.
  const protectedSystemMsgs = [] // { index, msg }
  const conversationMsgs = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'system') {
      protectedSystemMsgs.push({ index: i, msg: messages[i] })
    } else {
      conversationMsgs.push(messages[i])
    }
  }

  // If only system messages remain after extraction, nothing to compress
  if (conversationMsgs.length <= keepRecent) {
    return { messages, stats: { compressed: false, reason: 'below threshold (after excluding system messages)' } }
  }

  const recent = conversationMsgs.slice(-keepRecent)
  const older = conversationMsgs.slice(0, -keepRecent)

  // Compress older conversation messages: keep role, truncate long content
  const compressed = older.map(msg => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    const tokens = estimateTokens(content)
    if (tokens <= maxTokensPerMsg) return msg

    // Truncate to maxTokensPerMsg worth of chars
    const maxChars = maxTokensPerMsg * 4
    const truncated = content.slice(0, maxChars)
    // Find last sentence boundary
    const lastPeriod = truncated.lastIndexOf('.')
    const lastNewline = truncated.lastIndexOf('\n')
    const cutPoint = Math.max(lastPeriod, lastNewline)
    const finalContent = cutPoint > maxChars * 0.5
      ? truncated.slice(0, cutPoint + 1)
      : truncated + '...'

    return { ...msg, content: finalContent }
  })

  // Build a summary of the compressed portion
  const userMsgs = compressed.filter(m => m.role === 'user')
  const topics = userMsgs.slice(-5).map(m => {
    const c = typeof m.content === 'string' ? m.content : ''
    return c.slice(0, 100).replace(/\n/g, ' ').trim()
  }).filter(Boolean)

  const summary = {
    role: 'system',
    content: `[Conversation summary: ${older.length} earlier messages compressed. Recent topics: ${topics.join('; ') || 'general discussion'}]`
  }

  const originalTokens = messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0)

  // ── Reassemble: protected system messages first, then summary + recent ──
  // System messages go at the front (preserving their relative order),
  // followed by the conversation summary and recent conversation messages.
  const result = [
    ...protectedSystemMsgs.map(p => p.msg),
    summary,
    ...recent,
  ]
  const compressedTokens = result.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0)

  return {
    messages: result,
    stats: {
      compressed: true,
      original_messages: messages.length,
      compressed_messages: result.length,
      original_tokens: originalTokens,
      compressed_tokens: compressedTokens,
      reduction_pct: originalTokens > 0 ? ((1 - compressedTokens / originalTokens) * 100) : 0,
      protected_system_messages: protectedSystemMsgs.length,
    }
  }
}

/**
 * Compress code content: remove single-line comments, collapse consecutive
 * blank lines, and remove trailing whitespace.
 */
function compressCode(text) {
  const lines = text.split('\n')
  const cleaned = []
  let prevBlank = false

  for (const line of lines) {
    const trimmed = line.trim()

    // Remove single-line comment lines (// or # or * but not */)
    if (trimmed.startsWith('//') || trimmed.startsWith('#') ||
        (trimmed.startsWith('*') && !trimmed.startsWith('*/'))) {
      continue
    }

    // Track consecutive blank lines — collapse runs of 2+ into one
    const isBlank = trimmed.length === 0
    if (isBlank && prevBlank) continue
    prevBlank = isBlank

    // Remove trailing whitespace
    cleaned.push(line.trimEnd())
  }

  return cleaned.join('\n')
}

/**
 * Compress JSON content: detect repeated array elements and replace with
 * a summary object { _summary, count, schema, first }.
 */
function compressJSON(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return text // not valid JSON, return as-is
  }

  function summarizeArrays(obj) {
    if (Array.isArray(obj)) {
      // Summarize arrays with >3 object elements that share similar keys
      if (obj.length > 3 && obj.every(el => el !== null && typeof el === 'object' && !Array.isArray(el))) {
        const firstKeys = Object.keys(obj[0]).sort().join(',')
        const similar = obj.every(el => Object.keys(el).sort().join(',') === firstKeys)
        if (similar) {
          return [{ _summary: true, count: obj.length, schema: Object.keys(obj[0]), first: obj[0] }]
        }
      }
      // Recurse into array elements
      return obj.map(el => summarizeArrays(el))
    }
    if (obj !== null && typeof obj === 'object') {
      const result = {}
      for (const key of Object.keys(obj)) {
        result[key] = summarizeArrays(obj[key])
      }
      return result
    }
    return obj
  }

  const summarized = summarizeArrays(parsed)
  return JSON.stringify(summarized, null, 2)
}

/**
 * Compress log content: fold consecutive repeated lines into a single
 * line with [×N] count suffix.
 */
function compressLog(text) {
  const lines = text.split('\n')
  const result = []
  let i = 0

  while (i < lines.length) {
    const current = lines[i]
    let count = 1

    // Count consecutive identical lines
    while (i + count < lines.length && lines[i + count] === current) {
      count++
    }

    if (count >= 2) {
      result.push(current + ' [\u00d7' + count + ']')
    } else {
      result.push(current)
    }
    i += count
  }

  return result.join('\n')
}

/**
 * Compress search results: deduplicate results sharing the same file path
 * with overlapping or adjacent line ranges.
 * Expected format per line: filepath:linenum:content
 */
function compressSearch(text) {
  const lines = text.split('\n')
  const resultPattern = /^(.+?):(\d+):(.*)$/

  // Separate parseable search results from non-parseable lines
  const groups = new Map() // filepath -> [{line, content, originalIndex}]
  const output = []        // track order: {type: 'result'|'other', ...}

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(resultPattern)
    if (match) {
      const filepath = match[1]
      const lineNum = parseInt(match[2], 10)
      const content = match[3]
      if (!groups.has(filepath)) {
        groups.set(filepath, [])
        output.push({ type: 'group', filepath, insertIndex: output.length })
      }
      groups.get(filepath).push({ line: lineNum, content, raw: lines[i] })
    } else {
      output.push({ type: 'other', text: lines[i] })
    }
  }

  // For each file group, merge overlapping/adjacent line ranges
  const merged = new Map()
  for (const [filepath, entries] of groups) {
    // Sort by line number
    entries.sort((a, b) => a.line - b.line)

    const mergedEntries = []
    let current = null

    for (const entry of entries) {
      if (!current) {
        current = { startLine: entry.line, endLine: entry.line, contents: [entry] }
      } else if (entry.line <= current.endLine + 2) {
        // Overlapping or adjacent (within 2 lines)
        current.endLine = Math.max(current.endLine, entry.line)
        current.contents.push(entry)
      } else {
        mergedEntries.push(current)
        current = { startLine: entry.line, endLine: entry.line, contents: [entry] }
      }
    }
    if (current) mergedEntries.push(current)

    merged.set(filepath, mergedEntries)
  }

  // Reconstruct output
  const resultLines = []
  for (const item of output) {
    if (item.type === 'other') {
      resultLines.push(item.text)
    } else if (item.type === 'group') {
      const entries = merged.get(item.filepath)
      for (const range of entries) {
        // Use the first entry's content as representative for merged ranges
        if (range.contents.length === 1) {
          resultLines.push(range.contents[0].raw)
        } else {
          // Emit first line, then note the merge
          resultLines.push(range.contents[0].raw)
          if (range.contents.length > 1) {
            resultLines.push(`  [+${range.contents.length - 1} adjacent results in ${item.filepath}:${range.startLine}-${range.endLine}]`)
          }
        }
      }
    }
  }

  return resultLines.join('\n')
}

/**
 * Head/tail truncation — the default fallback strategy.
 */
function headTailTruncate(text, maxChars) {
  const headSize = Math.floor(maxChars * 0.7)
  const tailSize = maxChars - headSize - 50
  return text.slice(0, headSize) + '\n\n[...truncated...]\n\n' + text.slice(-tailSize)
}

/**
 * Build a stats object for compression results.
 */
function makeStats(originalTokens, compressedTokens) {
  return {
    compressed: true,
    original_tokens: originalTokens,
    compressed_tokens: compressedTokens,
    reduction_pct: originalTokens > 0
      ? Math.round((1 - compressedTokens / originalTokens) * 1000) / 10
      : 0,
  }
}

/**
 * Compress a text block using type-aware strategies.
 * Dispatches on contentType before falling back to head/tail truncation.
 */
function compressText(text, contentType = 'auto', options = {}) {
  if (!text) return { compressed: text, stats: { compressed: false, original_tokens: 0, compressed_tokens: 0, reduction_pct: 0 } }

  const originalTokens = estimateTokens(text)
  // Target 15% of context window for compressed tool output.
  // When a calibration profile is available, toolOutputTruncate (in chars)
  // is passed via options.maxChars and already scales with the model's real
  // context window. Fall back to config.CONTEXT_WINDOW for uncalibrated runs.
  const config = require('./config')
  const maxChars = options.maxChars || Math.max(16000, Math.floor(config.CONTEXT_WINDOW * 4 * 0.15))
  const maxTokens = Math.ceil(maxChars / 4)

  // Apply type-specific compression first
  let compressed = text
  switch (contentType) {
    case 'code':
      compressed = compressCode(text)
      break
    case 'json':
      compressed = compressJSON(text)
      break
    case 'log':
      compressed = compressLog(text)
      break
    case 'search':
      compressed = compressSearch(text)
      break
    default:
      // 'auto' and others — skip to truncation
      break
  }

  // If type-specific compression brought it under the limit, return
  const afterTypeTokens = estimateTokens(compressed)
  if (afterTypeTokens <= maxTokens) {
    if (compressed === text) {
      return { compressed: text, stats: { compressed: false, original_tokens: originalTokens, compressed_tokens: originalTokens, reduction_pct: 0 } }
    }
    return { compressed, stats: makeStats(originalTokens, afterTypeTokens) }
  }

  // Still over limit — apply head/tail truncation
  compressed = headTailTruncate(compressed, maxChars)
  const compressedTokens = estimateTokens(compressed)

  return {
    compressed,
    stats: makeStats(originalTokens, compressedTokens),
  }
}

module.exports = { compressMessages, compressText, estimateTokens }
