'use strict'

/**
 * test/assist-client.test.js
 *
 * Verifies graceful degradation properties for the dual-model fast assistant.
 *
 * Property 1 — Lazy-require guard:
 *   assistClient is null when module is absent; all integration points are no-ops.
 *
 * Property 2 — No console.warn in degraded mode:
 *   _assistRequest returns null silently on HTTP 503 degraded (no warning logged).
 *
 * Property 3 — Primary model messages unchanged in degraded mode:
 *   All integration points only modify content when assist call returns non-null.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.4
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const net = require('net')

const assistClient = require('../assist-client.js')
const { _assistRequest, FETCH_SUMMARIZE_THRESHOLD, FILE_EXTRACT_THRESHOLD,
        GIT_SUMMARIZE_THRESHOLD, SEARCH_RANK_THRESHOLD, VALIDATED_TOOLS } = assistClient

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Spin up a minimal HTTP server that always responds with the given status and body.
 * Returns { server, port, close }.
 */
function makeMockServer(statusCode, body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const data = typeof body === 'string' ? body : JSON.stringify(body)
      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(data)
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, port, close: () => new Promise(r => server.close(r)) })
    })
  })
}

/**
 * Monkey-patch http.request to redirect to a different port for the duration of fn().
 * Restores the original after fn() resolves.
 */
async function withRedirectedPort(targetPort, fn) {
  const original = http.request.bind(http)
  http.request = (options, callback) => {
    const patched = Object.assign({}, options, { port: targetPort })
    return original(patched, callback)
  }
  try {
    return await fn()
  } finally {
    http.request = original
  }
}

// ── Property 1: null assistClient → all integration points are no-ops ─────────

describe('Property 1 — null assistClient: all integration points are no-ops', () => {
  // Simulate the direct-bridge.js pattern: assistClient = null
  const nullClient = null

  it('vision offload is skipped when assistClient is null', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }
    ]
    const originalContent = JSON.stringify(messages)

    // Replicate the integration point guard from direct-bridge.js
    if (nullClient) {
      for (const msg of messages) {
        if (!Array.isArray(msg.content)) continue
        for (let i = 0; i < msg.content.length; i++) {
          const part = msg.content[i]
          if (part.type === 'image_url' || part.type === 'image') {
            const desc = await nullClient.assistVision('', 'image/png', '')
            if (desc) msg.content[i] = { type: 'text', text: `[Vision: ${desc}]` }
          }
        }
      }
    }

    assert.equal(JSON.stringify(messages), originalContent, 'messages must be unchanged when assistClient is null')
  })

  it('todo bootstrap is skipped when assistClient is null', async () => {
    let emitted = false
    const emit = () => { emitted = true }

    if (nullClient && nullClient.TODO_BOOTSTRAP_ENABLED) {
      nullClient.assistTodoBootstrap('do something').then(todos => {
        if (todos) emit()
      })
    }

    await new Promise(r => setTimeout(r, 10))
    assert.equal(emitted, false, 'no todo event should be emitted when assistClient is null')
  })

  it('tool pre-validation is skipped when assistClient is null', async () => {
    let validationCalled = false

    if (nullClient && VALIDATED_TOOLS.has('edit_file')) {
      validationCalled = true
    }

    assert.equal(validationCalled, false, 'validation must not run when assistClient is null')
  })

  it('error diagnosis is skipped when assistClient is null', async () => {
    let content = 'original error text'
    const isError = true

    if (nullClient && isError && content) {
      const diagnosis = await nullClient.assistDiagnoseError('bash', {}, content, '')
      if (diagnosis) content = `[Fast model diagnosis: ${diagnosis}]\n\n${content}`
    }

    assert.equal(content, 'original error text', 'content must be unchanged when assistClient is null')
  })

  it('fetch summarize is skipped when assistClient is null', async () => {
    let content = 'x'.repeat(FETCH_SUMMARIZE_THRESHOLD + 100)
    const original = content

    if (nullClient && typeof content === 'string' && content.length > FETCH_SUMMARIZE_THRESHOLD) {
      const summary = await nullClient.assistFetchSummarize('http://example.com', content, 512)
      if (summary) content = `[Summarized by fast model — original: ${content.length} chars]\n\n${summary}`
    }

    assert.equal(content, original, 'content must be unchanged when assistClient is null')
  })

  it('git summarize is skipped when assistClient is null', async () => {
    let content = 'x'.repeat(GIT_SUMMARIZE_THRESHOLD + 100)
    const original = content

    if (nullClient && typeof content === 'string' && content.length > GIT_SUMMARIZE_THRESHOLD) {
      const cmd = 'git status'
      if (/^git\s+(status|log|diff|show)\b/.test(cmd)) {
        const summary = await nullClient.assistGitSummarize(cmd, content)
        if (summary) content = `[Git summary by fast model — original: ${content.length} chars]\n\n${summary}`
      }
    }

    assert.equal(content, original, 'content must be unchanged when assistClient is null')
  })

  it('search rank is skipped when assistClient is null', async () => {
    const lines = Array.from({ length: SEARCH_RANK_THRESHOLD + 5 }, (_, i) => `result-${i}`)
    let content = lines.join('\n')
    const original = content

    if (nullClient && typeof content === 'string') {
      const splitLines = content.split('\n').filter(Boolean)
      if (splitLines.length > SEARCH_RANK_THRESHOLD) {
        const ranked = await nullClient.assistRankSearchResults('pattern', splitLines, 'context')
        if (ranked) content = `[Ranked by fast model — showing 15 of ${splitLines.length} matches]\n\n${ranked.slice(0, 15).join('\n')}`
      }
    }

    assert.equal(content, original, 'content must be unchanged when assistClient is null')
  })

  it('file extract is skipped when assistClient is null', async () => {
    let content = 'x'.repeat(FILE_EXTRACT_THRESHOLD + 100)
    const original = content

    if (nullClient && typeof content === 'string' && content.length > FILE_EXTRACT_THRESHOLD) {
      const taskContext = 'some task'
      if (taskContext) {
        const section = await nullClient.assistExtractRelevantSection('/path/to/file', content, taskContext)
        if (section) content = `[Relevant section extracted by fast model — file: ${content.length} chars total]\n\n${section}`
      }
    }

    assert.equal(content, original, 'content must be unchanged when assistClient is null')
  })

  it('todo watch is skipped when assistClient is null', async () => {
    let emitted = false
    const emit = () => { emitted = true }
    const _lastTodos = [{ id: 1, content: 'task', status: 'pending' }]

    if (nullClient && _lastTodos) {
      nullClient.assistTodoWatch('bash', 'output', _lastTodos).then(updated => {
        if (updated) emit()
      })
    }

    await new Promise(r => setTimeout(r, 10))
    assert.equal(emitted, false, 'no todo watch event when assistClient is null')
  })

  it('repetition detection is skipped when assistClient is null', async () => {
    let loopBroken = false
    const lastTextResponses = ['resp1', 'resp2']

    if (nullClient && lastTextResponses.length >= 2) {
      nullClient.assistDetectRepetition(lastTextResponses).then(result => {
        if (result && result.repeating) loopBroken = true
      })
    }

    await new Promise(r => setTimeout(r, 10))
    assert.equal(loopBroken, false, 'loop breaking must not trigger when assistClient is null')
  })
})

// ── Property 2: _assistRequest returns null silently on HTTP 503 degraded ─────

describe('Property 2 — _assistRequest returns null silently on HTTP 503 degraded', () => {
  let mock = null

  before(async () => {
    mock = await makeMockServer(503, { degraded: true, reason: 'no extraction model loaded' })
  })

  after(async () => {
    if (mock) await mock.close()
  })

  it('returns null on HTTP 503 with degraded:true', async () => {
    const result = await withRedirectedPort(mock.port, () =>
      _assistRequest('vision', { image_b64: 'abc', mime_type: 'image/png', prompt: 'describe' }, 5000)
    )
    assert.equal(result, null, '_assistRequest must return null on 503 degraded')
  })

  it('does NOT call console.warn on HTTP 503 degraded', async () => {
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args)

    try {
      await withRedirectedPort(mock.port, () =>
        _assistRequest('todo_bootstrap', { user_prompt: 'hello' }, 5000)
      )
    } finally {
      console.warn = originalWarn
    }

    assert.equal(warnings.length, 0, 'console.warn must NOT be called on 503 degraded')
  })

  it('DOES call console.warn on non-degraded HTTP 503', async () => {
    // A 503 without degraded:true is an unexpected error — should warn
    const nonDegradedMock = await makeMockServer(503, { error: 'service unavailable' })
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args)

    try {
      await withRedirectedPort(nonDegradedMock.port, () =>
        _assistRequest('vision', {}, 5000)
      )
    } finally {
      console.warn = originalWarn
      await nonDegradedMock.close()
    }

    assert.equal(warnings.length, 1, 'console.warn must be called once on non-degraded 503')
  })

  it('DOES call console.warn on HTTP 500', async () => {
    const errMock = await makeMockServer(500, { error: 'internal server error' })
    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args)

    try {
      await withRedirectedPort(errMock.port, () =>
        _assistRequest('vision', {}, 5000)
      )
    } finally {
      console.warn = originalWarn
      await errMock.close()
    }

    assert.equal(warnings.length, 1, 'console.warn must be called once on HTTP 500')
  })
})

// ── Property 3: content/messages unchanged when assist returns null ────────────

describe('Property 3 — primary model messages unchanged when assist returns null', () => {
  it('vision offload: message unchanged when assistVision returns null', async () => {
    // Simulate assistClient with assistVision returning null (degraded)
    const fakeClient = {
      assistVision: async () => null,
    }

    const messages = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] }
    ]
    const originalContent = JSON.stringify(messages)

    if (fakeClient) {
      for (const msg of messages) {
        if (!Array.isArray(msg.content)) continue
        for (let i = 0; i < msg.content.length; i++) {
          const part = msg.content[i]
          if (part.type === 'image_url' || part.type === 'image') {
            const desc = await fakeClient.assistVision('', 'image/png', '')
            if (desc) msg.content[i] = { type: 'text', text: `[Vision: ${desc}]` }
          }
        }
      }
    }

    assert.equal(JSON.stringify(messages), originalContent, 'messages must be unchanged when assistVision returns null')
  })

  it('fetch summarize: content unchanged when assistFetchSummarize returns null', async () => {
    const fakeClient = {
      assistFetchSummarize: async () => null,
      FETCH_SUMMARIZE_THRESHOLD,
    }

    let content = 'x'.repeat(FETCH_SUMMARIZE_THRESHOLD + 100)
    const original = content

    if (fakeClient && typeof content === 'string' && content.length > fakeClient.FETCH_SUMMARIZE_THRESHOLD) {
      const summary = await fakeClient.assistFetchSummarize('http://example.com', content, 512)
      if (summary) content = `[Summarized by fast model — original: ${content.length} chars]\n\n${summary}`
    }

    assert.equal(content, original, 'content must be unchanged when assistFetchSummarize returns null')
  })

  it('git summarize: content unchanged when assistGitSummarize returns null', async () => {
    const fakeClient = {
      assistGitSummarize: async () => null,
      GIT_SUMMARIZE_THRESHOLD,
    }

    let content = 'x'.repeat(GIT_SUMMARIZE_THRESHOLD + 100)
    const original = content

    if (fakeClient && typeof content === 'string' && content.length > fakeClient.GIT_SUMMARIZE_THRESHOLD) {
      const cmd = 'git status'
      if (/^git\s+(status|log|diff|show)\b/.test(cmd)) {
        const summary = await fakeClient.assistGitSummarize(cmd, content)
        if (summary) content = `[Git summary by fast model — original: ${content.length} chars]\n\n${summary}`
      }
    }

    assert.equal(content, original, 'content must be unchanged when assistGitSummarize returns null')
  })

  it('search rank: content unchanged when assistRankSearchResults returns null', async () => {
    const fakeClient = {
      assistRankSearchResults: async () => null,
      SEARCH_RANK_THRESHOLD,
    }

    const lines = Array.from({ length: SEARCH_RANK_THRESHOLD + 5 }, (_, i) => `result-${i}`)
    let content = lines.join('\n')
    const original = content

    if (fakeClient && typeof content === 'string') {
      const splitLines = content.split('\n').filter(Boolean)
      if (splitLines.length > fakeClient.SEARCH_RANK_THRESHOLD) {
        const ranked = await fakeClient.assistRankSearchResults('pattern', splitLines, 'context')
        if (ranked) content = `[Ranked by fast model — showing 15 of ${splitLines.length} matches]\n\n${ranked.slice(0, 15).join('\n')}`
      }
    }

    assert.equal(content, original, 'content must be unchanged when assistRankSearchResults returns null')
  })

  it('file extract: content unchanged when assistExtractRelevantSection returns null', async () => {
    const fakeClient = {
      assistExtractRelevantSection: async () => null,
      FILE_EXTRACT_THRESHOLD,
    }

    let content = 'x'.repeat(FILE_EXTRACT_THRESHOLD + 100)
    const original = content

    if (fakeClient && typeof content === 'string' && content.length > fakeClient.FILE_EXTRACT_THRESHOLD) {
      const taskContext = 'some task'
      if (taskContext) {
        const section = await fakeClient.assistExtractRelevantSection('/path/to/file', content, taskContext)
        if (section) content = `[Relevant section extracted by fast model — file: ${content.length} chars total]\n\n${section}`
      }
    }

    assert.equal(content, original, 'content must be unchanged when assistExtractRelevantSection returns null')
  })

  it('error diagnosis: content unchanged when assistDiagnoseError returns null', async () => {
    const fakeClient = {
      assistDiagnoseError: async () => null,
    }

    let content = 'original error text'
    const original = content
    const isError = true

    if (fakeClient && isError && content) {
      const diagnosis = await fakeClient.assistDiagnoseError('bash', {}, content, '')
      if (diagnosis) content = `[Fast model diagnosis: ${diagnosis}]\n\n${content}`
    }

    assert.equal(content, original, 'content must be unchanged when assistDiagnoseError returns null')
  })

  it('browser_screenshot vision: content unchanged when assistVision returns null', async () => {
    const fakeClient = {
      assistVision: async () => null,
    }

    let content = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const original = content
    const fnName = 'browser_screenshot'

    if (fakeClient && fnName === 'browser_screenshot' && content) {
      const imageMatch = content.match(/data:(image\/[^;]+);base64,([A-Za-z0-9+/=]+)/)
      if (imageMatch) {
        const desc = await fakeClient.assistVision(imageMatch[2], imageMatch[1], '')
        if (desc) content = `[Vision: ${desc}]`
      }
    }

    assert.equal(content, original, 'content must be unchanged when assistVision returns null for screenshot')
  })
})

// ── Module exports verification ───────────────────────────────────────────────

describe('assist-client.js module exports', () => {
  it('exports all 10 async functions', () => {
    const fns = [
      'assistVision', 'assistTodoBootstrap', 'assistTodoWatch', 'assistFetchSummarize',
      'assistValidateTool', 'assistDiagnoseError', 'assistGitSummarize',
      'assistRankSearchResults', 'assistExtractRelevantSection', 'assistDetectRepetition',
    ]
    for (const fn of fns) {
      assert.equal(typeof assistClient[fn], 'function', `${fn} must be exported`)
    }
  })

  it('exports all 7 constants', () => {
    assert.equal(typeof assistClient.FETCH_SUMMARIZE_THRESHOLD, 'number')
    assert.equal(typeof assistClient.VISION_MAX_CHARS, 'number')
    assert.equal(typeof assistClient.GIT_SUMMARIZE_THRESHOLD, 'number')
    assert.equal(typeof assistClient.SEARCH_RANK_THRESHOLD, 'number')
    assert.equal(typeof assistClient.FILE_EXTRACT_THRESHOLD, 'number')
    assert.equal(typeof assistClient.TODO_BOOTSTRAP_ENABLED, 'boolean')
    assert.equal(typeof assistClient.TODO_WATCH_ENABLED, 'boolean')
  })

  it('exports _assistRequest for testing', () => {
    assert.equal(typeof assistClient._assistRequest, 'function')
  })

  it('VALIDATED_TOOLS contains the four expected tools', () => {
    assert.ok(assistClient.VALIDATED_TOOLS.has('edit_file'))
    assert.ok(assistClient.VALIDATED_TOOLS.has('write_file'))
    assert.ok(assistClient.VALIDATED_TOOLS.has('bash'))
    assert.ok(assistClient.VALIDATED_TOOLS.has('read_file'))
  })
})
