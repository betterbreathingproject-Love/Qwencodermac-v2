'use strict'

/**
 * memory-client.js — Node.js HTTP client for the taosmd memory backend.
 *
 * Wraps all /memory/* HTTP endpoints exposed by memory-bridge.py.
 * All functions catch errors internally and return safe defaults — never throw.
 * Uses Node.js built-in http module (no external dependencies).
 */

const http = require('http')
const https = require('https')

const BASE_URL = process.env.MLX_SERVER_URL || 'http://localhost:8090'

// Timeout presets (ms)
const TIMEOUTS = {
  retrieve: 5000,
  archive: 2000,
  extract: 30000,
  status: 3000,
  default: 5000,
}

/**
 * Parse BASE_URL into { protocol, hostname, port, basePath }.
 */
function parseBaseUrl(url) {
  try {
    const parsed = new URL(url)
    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      basePath: parsed.pathname.replace(/\/$/, ''),
    }
  } catch (_) {
    return { protocol: 'http:', hostname: 'localhost', port: 8090, basePath: '' }
  }
}

/**
 * Make an HTTP request to the memory backend.
 * Returns parsed JSON response or null on error.
 *
 * @param {'GET'|'POST'|'DELETE'} method
 * @param {string} path - URL path (e.g. '/memory/status')
 * @param {object|null} body - Request body (will be JSON-serialized)
 * @param {number} timeoutMs - Request timeout in milliseconds
 * @returns {Promise<object|null>}
 */
function httpRequest(method, path, body, timeoutMs) {
  return new Promise((resolve) => {
    const { protocol, hostname, port, basePath } = parseBaseUrl(BASE_URL)
    const fullPath = basePath + path
    const bodyStr = body !== null && body !== undefined ? JSON.stringify(body) : null

    const options = {
      hostname,
      port,
      path: fullPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    }

    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr)
    }

    const transport = protocol === 'https:' ? https : http
    let settled = false

    const req = transport.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (settled) return
        settled = true
        try {
          resolve(JSON.parse(data))
        } catch (_) {
          resolve(null)
        }
      })
    })

    req.on('error', () => {
      if (settled) return
      settled = true
      resolve(null)
    })

    req.setTimeout(timeoutMs, () => {
      if (settled) return
      settled = true
      req.destroy()
      resolve(null)
    })

    if (bodyStr) {
      req.write(bodyStr)
    }
    req.end()
  })
}

/**
 * Retrieve relevant memory context for a query.
 *
 * @param {string} query - The search query
 * @param {{ mode?: 'fast'|'thorough', agentName?: string, topK?: number }} options
 * @returns {Promise<{ results: Array<{source, content, score, metadata}>, tokenCount: number }>}
 */
async function retrieve(query, options = {}) {
  try {
    const body = {
      query,
      mode: options.mode || 'fast',
      agent_name: options.agentName || null,
      top_k: options.topK || 10,
    }
    const result = await httpRequest('POST', '/memory/retrieve', body, TIMEOUTS.retrieve)
    if (!result || !Array.isArray(result.results)) {
      return { results: [], tokenCount: 0 }
    }
    return {
      results: result.results,
      tokenCount: result.token_count || 0,
    }
  } catch (_) {
    return { results: [], tokenCount: 0 }
  }
}

/**
 * Record an event to the Zero-Loss Archive.
 *
 * @param {'conversation'|'tool_call'|'decision'|'error'|'pre_compaction'|'session_start'|'session_end'|'task_completion'|'workflow_start'} eventType
 * @param {string|object} payload - Verbatim content
 * @param {string} summary - Short description
 * @param {{ agentName?: string, sessionId?: string, turnNumber?: number }} options
 * @returns {Promise<{ok: boolean}>}
 */
async function archiveRecord(eventType, payload, summary, options = {}) {
  try {
    const body = {
      event_type: eventType,
      payload,
      summary,
      agent_name: options.agentName || null,
      session_id: options.sessionId || null,
      turn_number: options.turnNumber || null,
    }
    const result = await httpRequest('POST', '/memory/archive/record', body, TIMEOUTS.archive)
    return result && result.ok ? { ok: true } : { ok: false }
  } catch (_) {
    return { ok: false }
  }
}

/**
 * Fire-and-forget fact extraction from a conversation turn.
 * Returns immediately without awaiting the extraction result.
 *
 * @param {string} message - The turn content
 * @param {string} agentName - Agent identifier
 * @param {string} sessionId - Session identifier
 * @returns {Promise<void>}
 */
async function extractTurn(message, agentName, sessionId) {
  try {
    const body = { message, agent_name: agentName, session_id: sessionId }
    // Fire-and-forget: don't await, don't propagate errors
    httpRequest('POST', '/memory/extract', body, TIMEOUTS.extract).catch(() => {})
  } catch (_) {
    // Silently ignore — extraction must never block the agent loop
  }
}

/**
 * Add a triple to the Knowledge Graph.
 *
 * @param {string} subject
 * @param {string} predicate
 * @param {string} object
 * @param {string|null} validFrom - ISO timestamp or null
 * @param {string|null} validUntil - ISO timestamp or null
 * @returns {Promise<{ok: boolean, id?: number}|null>}
 */
async function kgAddTriple(subject, predicate, object, validFrom = null, validUntil = null) {
  try {
    const body = { subject, predicate, object, valid_from: validFrom, valid_until: validUntil }
    const result = await httpRequest('POST', '/memory/kg/triples', body, TIMEOUTS.default)
    if (!result) return null
    return { ok: true, id: result.id }
  } catch (_) {
    return null
  }
}

/**
 * Query the Knowledge Graph for triples involving an entity.
 *
 * @param {string} entity - Entity name to query
 * @returns {Promise<Array<{id, subject, predicate, object, valid_from, valid_until}>>}
 */
async function kgQueryEntity(entity) {
  try {
    const result = await httpRequest('GET', `/memory/kg/query/${encodeURIComponent(entity)}`, null, TIMEOUTS.default)
    if (!Array.isArray(result)) return []
    return result
  } catch (_) {
    return []
  }
}

/**
 * Search Vector Memory with hybrid semantic search.
 *
 * @param {string} query - Search query
 * @param {{ topK?: number, hybrid?: boolean }} options
 * @returns {Promise<Array<{id, text, score, metadata}>>}
 */
async function vectorSearch(query, options = {}) {
  try {
    const body = {
      query,
      top_k: options.topK || 10,
      hybrid: options.hybrid !== false,
    }
    const result = await httpRequest('POST', '/memory/vector/search', body, TIMEOUTS.retrieve)
    if (!result || !Array.isArray(result.results)) return []
    return result.results
  } catch (_) {
    return []
  }
}

/**
 * Full-text search over the Archive.
 *
 * @param {string} query - Search query
 * @param {{ limit?: number }} options
 * @returns {Promise<Array<{id, event_type, payload, summary, agent_name, session_id, timestamp}>>}
 */
async function archiveSearch(query, options = {}) {
  try {
    const limit = options.limit || 20
    const result = await httpRequest('GET', `/memory/archive/search?query=${encodeURIComponent(query)}&limit=${limit}`, null, TIMEOUTS.retrieve)
    if (!result || !Array.isArray(result.results)) return []
    return result.results
  } catch (_) {
    return []
  }
}

/**
 * Get the memory system status.
 *
 * @returns {Promise<{knowledgeGraph: string, vectorMemory: string, archive: string, extractionModel: string|null}|null>}
 */
async function getStatus() {
  try {
    const result = await httpRequest('GET', '/memory/status', null, TIMEOUTS.status)
    if (!result) return null
    return {
      knowledgeGraph: result.knowledge_graph || 'unavailable',
      vectorMemory: result.vector_memory || 'unavailable',
      archive: result.archive || 'unavailable',
      extractionModel: result.extraction_model || null,
    }
  } catch (_) {
    return null
  }
}

/**
 * Ask the small extraction model to pick the best agent type for a task.
 * Returns the agent type string (e.g. 'implementation', 'explore') or null
 * when the extraction model is not loaded (degraded mode) or on any error.
 *
 * @param {string} taskTitle - Task title
 * @param {string} [taskDescription] - Optional task description
 * @returns {Promise<string|null>}
 */
async function assistRouteTask(taskTitle, taskDescription = '') {
  try {
    const task = taskDescription ? `${taskTitle}\n${taskDescription}` : taskTitle
    const body = { task_type: 'route_task', payload: { task } }
    const result = await httpRequest('POST', '/memory/assist', body, 8000)
    if (!result) return null
    if (result.degraded) return null
    // Handler returns AssistResponse with result_data: { agent_type: "..." }
    if (result.result_data && typeof result.result_data.agent_type === 'string') return result.result_data.agent_type
    // Fallback: flat result field
    if (result.result && typeof result.result === 'string') return result.result
    return null
  } catch (err) {
    // Silently degrade — routing failure is non-critical
    return null
  }
}

module.exports = {
  retrieve,
  archiveRecord,
  extractTurn,
  kgAddTriple,
  kgQueryEntity,
  vectorSearch,
  archiveSearch,
  getStatus,
  assistRouteTask,
  // Expose for testing
  _httpRequest: httpRequest,
  _parseBaseUrl: parseBaseUrl,
  TIMEOUTS,
}
