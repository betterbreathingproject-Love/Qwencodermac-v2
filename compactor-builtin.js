/**
 * Built-in compactor — pure JS implementation that works without Python/pip.
 * Provides message compression and text summarization using token-aware truncation.
 * Falls back to this when claw-compactor Python package is not installed.
 */

/**
 * Rough token count estimate (~4 chars per token for English text).
 */
function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/**
 * Compress a list of chat messages by summarizing older ones.
 * Keeps recent messages intact, compresses older ones.
 */
function compressMessages(messages, options = {}) {
  const keepRecent = options.keepRecent || 10
  const maxTokensPerMsg = options.maxTokensPerMsg || 500

  if (messages.length <= keepRecent) {
    return { messages, stats: { compressed: false, reason: 'below threshold' } }
  }

  const recent = messages.slice(-keepRecent)
  const older = messages.slice(0, -keepRecent)

  // Compress older messages: keep role, truncate long content
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
  const result = [summary, ...recent]
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
    }
  }
}

/**
 * Compress a text block by intelligent truncation.
 */
function compressText(text, contentType = 'auto') {
  if (!text) return { compressed: text, stats: { compressed: false } }

  const originalTokens = estimateTokens(text)
  const maxTokens = 4000 // target compressed size

  if (originalTokens <= maxTokens) {
    return { compressed: text, stats: { compressed: false, reason: 'already small' } }
  }

  const maxChars = maxTokens * 4
  let compressed

  if (contentType === 'code' || text.includes('function ') || text.includes('class ') || text.includes('import ')) {
    // For code: keep structure, remove comments and blank lines
    compressed = text
      .split('\n')
      .filter(line => {
        const trimmed = line.trim()
        return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('#') && !trimmed.startsWith('*')
      })
      .join('\n')
      .slice(0, maxChars)
  } else {
    // For prose: keep first and last portions
    const headSize = Math.floor(maxChars * 0.7)
    const tailSize = maxChars - headSize - 50
    compressed = text.slice(0, headSize) + '\n\n[...truncated...]\n\n' + text.slice(-tailSize)
  }

  const compressedTokens = estimateTokens(compressed)
  return {
    compressed,
    stats: {
      compressed: true,
      original_tokens: originalTokens,
      compressed_tokens: compressedTokens,
      reduction_pct: originalTokens > 0 ? ((1 - compressedTokens / originalTokens) * 100) : 0,
    }
  }
}

module.exports = { compressMessages, compressText, estimateTokens }
