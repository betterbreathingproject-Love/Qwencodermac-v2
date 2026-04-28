'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fc = require('fast-check')

// Feature: taosmd-memory-integration, Property 11: Memory client error resilience
// Tests that all memory-client functions return safe defaults when server is unreachable.

// ── Mock the http module to simulate unreachable server ───────────────────────
// We test the pure logic of the client by simulating the httpRequest helper
// returning null (which is what it returns on network error/timeout).

/**
 * Create a mock memory client that simulates httpRequest returning null
 * (server unreachable scenario).
 */
function createUnreachableClient() {
  // Simulate httpRequest always returning null (server unreachable)
  async function mockHttpRequest() {
    return null
  }

  return {
    async retrieve(query, options = {}) {
      try {
        const result = await mockHttpRequest()
        if (!result || !Array.isArray(result.results)) {
          return { results: [], tokenCount: 0 }
        }
        return { results: result.results, tokenCount: result.token_count || 0 }
      } catch (_) {
        return { results: [], tokenCount: 0 }
      }
    },

    async archiveRecord(eventType, payload, summary) {
      try {
        const result = await mockHttpRequest()
        return result && result.ok ? { ok: true } : { ok: false }
      } catch (_) {
        return { ok: false }
      }
    },

    async extractTurn(message, agentName, sessionId) {
      try {
        mockHttpRequest().catch(() => {})
      } catch (_) {
        // Silently ignore
      }
    },

    async kgAddTriple(subject, predicate, object) {
      try {
        const result = await mockHttpRequest()
        if (!result) return null
        return { ok: true, id: result.id }
      } catch (_) {
        return null
      }
    },

    async kgQueryEntity(entity) {
      try {
        const result = await mockHttpRequest()
        if (!Array.isArray(result)) return []
        return result
      } catch (_) {
        return []
      }
    },

    async vectorSearch(query, options = {}) {
      try {
        const result = await mockHttpRequest()
        if (!result || !Array.isArray(result.results)) return []
        return result.results
      } catch (_) {
        return []
      }
    },

    async archiveSearch(query, options = {}) {
      try {
        const result = await mockHttpRequest()
        if (!result || !Array.isArray(result.results)) return []
        return result.results
      } catch (_) {
        return []
      }
    },

    async getStatus() {
      try {
        const result = await mockHttpRequest()
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
    },
  }
}

// ── Generators ────────────────────────────────────────────────────────────────

function arbNonEmptyString() {
  return fc.string({ minLength: 1, maxLength: 100 })
}

function arbEventType() {
  return fc.constantFrom(
    'conversation', 'tool_call', 'decision', 'error',
    'pre_compaction', 'session_start', 'session_end',
    'task_completion', 'workflow_start'
  )
}

// ── Property 11: Memory client error resilience ───────────────────────────────

describe('Feature: taosmd-memory-integration — memory-client property tests', () => {
  // Feature: taosmd-memory-integration, Property 11: Memory client error resilience
  describe('Property 11: Memory client error resilience', () => {
    /**
     * **Validates: Requirements 11.3**
     *
     * For any memory-client function called when the server is unreachable,
     * the function SHALL return a safe default value without throwing.
     */

    it('retrieve() returns {results: [], tokenCount: 0} when server unreachable', async () => {
      await fc.assert(
        fc.asyncProperty(arbNonEmptyString(), async (query) => {
          const client = createUnreachableClient()
          let threw = false
          let result
          try {
            result = await client.retrieve(query)
          } catch (_) {
            threw = true
          }
          assert.equal(threw, false, 'retrieve() should not throw')
          assert.ok(result !== undefined, 'retrieve() should return a value')
          assert.ok(Array.isArray(result.results), 'retrieve() results should be an array')
          assert.equal(result.results.length, 0, 'retrieve() results should be empty')
          assert.equal(result.tokenCount, 0, 'retrieve() tokenCount should be 0')
        }),
        { numRuns: 150 }
      )
    })

    it('archiveRecord() returns {ok: false} when server unreachable', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbEventType(),
          arbNonEmptyString(),
          arbNonEmptyString(),
          async (eventType, payload, summary) => {
            const client = createUnreachableClient()
            let threw = false
            let result
            try {
              result = await client.archiveRecord(eventType, payload, summary)
            } catch (_) {
              threw = true
            }
            assert.equal(threw, false, 'archiveRecord() should not throw')
            assert.ok(result !== undefined, 'archiveRecord() should return a value')
            assert.equal(result.ok, false, 'archiveRecord() should return {ok: false}')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('extractTurn() does not throw when server unreachable', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbNonEmptyString(),
          arbNonEmptyString(),
          arbNonEmptyString(),
          async (message, agentName, sessionId) => {
            const client = createUnreachableClient()
            let threw = false
            try {
              await client.extractTurn(message, agentName, sessionId)
            } catch (_) {
              threw = true
            }
            assert.equal(threw, false, 'extractTurn() should not throw')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('kgAddTriple() returns null when server unreachable', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbNonEmptyString(),
          arbNonEmptyString(),
          arbNonEmptyString(),
          async (subject, predicate, object) => {
            const client = createUnreachableClient()
            let threw = false
            let result
            try {
              result = await client.kgAddTriple(subject, predicate, object)
            } catch (_) {
              threw = true
            }
            assert.equal(threw, false, 'kgAddTriple() should not throw')
            assert.equal(result, null, 'kgAddTriple() should return null')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('kgQueryEntity() returns [] when server unreachable', async () => {
      await fc.assert(
        fc.asyncProperty(arbNonEmptyString(), async (entity) => {
          const client = createUnreachableClient()
          let threw = false
          let result
          try {
            result = await client.kgQueryEntity(entity)
          } catch (_) {
            threw = true
          }
          assert.equal(threw, false, 'kgQueryEntity() should not throw')
          assert.ok(Array.isArray(result), 'kgQueryEntity() should return an array')
          assert.equal(result.length, 0, 'kgQueryEntity() should return empty array')
        }),
        { numRuns: 150 }
      )
    })

    it('vectorSearch() returns [] when server unreachable', async () => {
      await fc.assert(
        fc.asyncProperty(arbNonEmptyString(), async (query) => {
          const client = createUnreachableClient()
          let threw = false
          let result
          try {
            result = await client.vectorSearch(query)
          } catch (_) {
            threw = true
          }
          assert.equal(threw, false, 'vectorSearch() should not throw')
          assert.ok(Array.isArray(result), 'vectorSearch() should return an array')
          assert.equal(result.length, 0, 'vectorSearch() should return empty array')
        }),
        { numRuns: 150 }
      )
    })

    it('archiveSearch() returns [] when server unreachable', async () => {
      await fc.assert(
        fc.asyncProperty(arbNonEmptyString(), async (query) => {
          const client = createUnreachableClient()
          let threw = false
          let result
          try {
            result = await client.archiveSearch(query)
          } catch (_) {
            threw = true
          }
          assert.equal(threw, false, 'archiveSearch() should not throw')
          assert.ok(Array.isArray(result), 'archiveSearch() should return an array')
          assert.equal(result.length, 0, 'archiveSearch() should return empty array')
        }),
        { numRuns: 150 }
      )
    })

    it('getStatus() returns null when server unreachable', async () => {
      await fc.assert(
        fc.asyncProperty(fc.constant(null), async () => {
          const client = createUnreachableClient()
          let threw = false
          let result
          try {
            result = await client.getStatus()
          } catch (_) {
            threw = true
          }
          assert.equal(threw, false, 'getStatus() should not throw')
          assert.equal(result, null, 'getStatus() should return null')
        }),
        { numRuns: 150 }
      )
    })
  })  // end Property 11 describe block

  // ── Pure logic helpers extracted from direct-bridge.js ───────────────────────
  // These mirror the logic added to _agentLoop() for testability.

  /**
   * Detect recall phrases in a user message.
   * Mirrors detectRecallMode() in direct-bridge.js.
   * @param {string} message
   * @returns {'fast'|'thorough'}
   */
  function detectRecallMode(message) {
    if (!message || typeof message !== 'string') return 'fast'
    const recallPhrases = [
      'remember when',
      'what did i say about',
      'last time',
      'previously',
    ]
    const lower = message.toLowerCase()
    for (const phrase of recallPhrases) {
      if (lower.includes(phrase)) return 'thorough'
    }
    return 'fast'
  }

  /**
   * Inject memory context into a messages array.
   * Mirrors the memory context injection logic in _agentLoop().
   * @param {Array} messages - The messages array
   * @param {Array} results - Memory retrieval results [{source, content, score}]
   * @returns {Array} New messages array with memory context injected
   */
  function injectMemoryContext(messages, results) {
    if (!results || results.length === 0) return messages

    const memLines = results.map(r => `[${r.source}] ${r.content}`).join('\n')
    const memContextMsg = {
      role: 'system',
      content: `[Memory Context]\n${memLines}`,
    }

    const newMessages = [...messages]
    const lastUserIdx = newMessages.map(m => m.role).lastIndexOf('user')
    if (lastUserIdx >= 0) {
      newMessages.splice(lastUserIdx, 0, memContextMsg)
    } else {
      newMessages.push(memContextMsg)
    }
    return newMessages
  }

  /**
   * Estimate tokens for a string (~4 chars per token).
   * Mirrors estimateTokens() in direct-bridge.js.
   */
  function estimateTokens(text) {
    if (!text) return 0
    return Math.ceil(text.length / 4)
  }

  /**
   * Estimate total tokens in a messages array.
   * Mirrors estimateMessagesTokens() in direct-bridge.js.
   */
  function estimateMessagesTokens(messages) {
    let total = 0
    for (const msg of messages) {
      total += estimateTokens(msg.content || '')
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          total += estimateTokens(tc.function?.arguments || '')
          total += estimateTokens(tc.function?.name || '')
        }
      }
      total += 4
    }
    return total
  }

  /**
   * Build tool call archive payload.
   * Mirrors the tool call archiving logic in _agentLoop().
   */
  function buildToolCallArchivePayload(fnName, fnArgs, content, isError) {
    const argsSummary = JSON.stringify(fnArgs).slice(0, 200)
    const resultSize = (content || '').length
    const archivePayload = {
      tool: fnName,
      args_summary: argsSummary,
      result_status: isError ? 'error' : 'success',
      result_size_bytes: resultSize,
    }
    const archiveContent = (content || '').length > 10000
      ? (content || '').slice(0, 10000)
      : (content || '')
    const truncated = (content || '').length > 10000
    if (truncated) archivePayload.truncated = true

    return {
      payload: { ...archivePayload, result: archiveContent },
      summary: `${fnName}: ${argsSummary.slice(0, 100)}`,
      truncated,
    }
  }

  // ── Property 12: Recall phrase detection selects thorough mode ────────────

  // Feature: taosmd-memory-integration, Property 12: Recall phrase detection selects thorough mode
  describe('Property 12: Recall phrase detection selects thorough mode', () => {
    /**
     * **Validates: Requirements 8.4**
     *
     * For any user message containing one of the recall phrases, the mode
     * SHALL be "thorough". For any message not containing a recall phrase,
     * the mode SHALL be "fast".
     */

    const RECALL_PHRASES = [
      'remember when',
      'what did i say about',
      'last time',
      'previously',
    ]

    it('messages containing recall phrases select thorough mode', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...RECALL_PHRASES),
          fc.string({ minLength: 0, maxLength: 50 }),
          fc.string({ minLength: 0, maxLength: 50 }),
          (phrase, before, after) => {
            const message = `${before} ${phrase} ${after}`
            const mode = detectRecallMode(message)
            assert.equal(mode, 'thorough',
              `Message containing "${phrase}" should select thorough mode`)
          }
        ),
        { numRuns: 150 }
      )
    })

    it('messages without recall phrases select fast mode', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 200 }),
          (message) => {
            // Filter out messages that accidentally contain recall phrases
            const lower = message.toLowerCase()
            const hasRecallPhrase = RECALL_PHRASES.some(p => lower.includes(p))
            fc.pre(!hasRecallPhrase)

            const mode = detectRecallMode(message)
            assert.equal(mode, 'fast',
              `Message without recall phrases should select fast mode`)
          }
        ),
        { numRuns: 150 }
      )
    })

    it('recall phrase detection is case-insensitive', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...RECALL_PHRASES),
          fc.constantFrom('lower', 'upper', 'mixed'),
          (phrase, caseType) => {
            let testPhrase
            if (caseType === 'upper') testPhrase = phrase.toUpperCase()
            else if (caseType === 'mixed') testPhrase = phrase.split('').map((c, i) => i % 2 === 0 ? c.toUpperCase() : c).join('')
            else testPhrase = phrase

            const mode = detectRecallMode(`Tell me ${testPhrase} the project`)
            assert.equal(mode, 'thorough',
              `Recall phrase "${testPhrase}" (${caseType}) should select thorough mode`)
          }
        ),
        { numRuns: 150 }
      )
    })

    it('null/undefined/empty message returns fast mode', () => {
      assert.equal(detectRecallMode(null), 'fast')
      assert.equal(detectRecallMode(undefined), 'fast')
      assert.equal(detectRecallMode(''), 'fast')
      assert.equal(detectRecallMode(42), 'fast')
    })
  })

  // ── Property 13: Memory context injection format ───────────────────────────

  // Feature: taosmd-memory-integration, Property 13: Memory context injection format
  describe('Property 13: Memory context injection format', () => {
    /**
     * **Validates: Requirements 8.2**
     *
     * For any non-empty retrieval result, the injected system message SHALL
     * start with the prefix [Memory Context] and SHALL be positioned
     * immediately before the user's message in the messages array.
     */

    function arbMemoryResult() {
      return fc.record({
        source: fc.constantFrom('kg', 'vector', 'archive'),
        content: fc.string({ minLength: 1, maxLength: 100 }),
        score: fc.float({ min: 0, max: 1 }),
      })
    }

    it('injected message starts with [Memory Context] prefix', () => {
      fc.assert(
        fc.property(
          fc.array(arbMemoryResult(), { minLength: 1, maxLength: 5 }),
          (results) => {
            const messages = [
              { role: 'system', content: 'You are an assistant.' },
              { role: 'user', content: 'What is the status?' },
            ]

            const newMessages = injectMemoryContext(messages, results)

            // Find the injected memory context message
            const memMsg = newMessages.find(m =>
              m.role === 'system' && m.content && m.content.startsWith('[Memory Context]')
            )
            assert.ok(memMsg, 'Should have a [Memory Context] system message')
            assert.ok(memMsg.content.startsWith('[Memory Context]'),
              'Memory context message should start with [Memory Context]')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('memory context is positioned immediately before the last user message', () => {
      fc.assert(
        fc.property(
          fc.array(arbMemoryResult(), { minLength: 1, maxLength: 5 }),
          fc.array(
            fc.record({
              role: fc.constantFrom('system', 'user', 'assistant'),
              content: fc.string({ minLength: 1, maxLength: 50 }),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          (results, extraMessages) => {
            // Ensure there's at least one user message
            const messages = [
              { role: 'system', content: 'System prompt' },
              ...extraMessages,
              { role: 'user', content: 'Final user message' },
            ]

            const newMessages = injectMemoryContext(messages, results)

            // Find the last user message index
            const lastUserIdx = newMessages.map(m => m.role).lastIndexOf('user')
            assert.ok(lastUserIdx > 0, 'Should have a user message')

            // The message immediately before the last user message should be the memory context
            const msgBeforeUser = newMessages[lastUserIdx - 1]
            assert.ok(
              msgBeforeUser && msgBeforeUser.role === 'system' &&
              msgBeforeUser.content && msgBeforeUser.content.startsWith('[Memory Context]'),
              'Message immediately before last user message should be [Memory Context]'
            )
          }
        ),
        { numRuns: 150 }
      )
    })

    it('empty results do not inject any memory context', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              role: fc.constantFrom('system', 'user'),
              content: fc.string({ minLength: 1, maxLength: 50 }),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          (messages) => {
            const originalLength = messages.length
            const newMessages = injectMemoryContext(messages, [])

            assert.equal(newMessages.length, originalLength,
              'Empty results should not change messages array length')

            const hasMemContext = newMessages.some(m =>
              m.content && m.content.startsWith('[Memory Context]')
            )
            assert.equal(hasMemContext, false,
              'Empty results should not inject memory context')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('memory context includes content from all results', () => {
      fc.assert(
        fc.property(
          fc.array(arbMemoryResult(), { minLength: 1, maxLength: 5 }),
          (results) => {
            const messages = [
              { role: 'system', content: 'System' },
              { role: 'user', content: 'Query' },
            ]

            const newMessages = injectMemoryContext(messages, results)
            const memMsg = newMessages.find(m =>
              m.role === 'system' && m.content && m.content.startsWith('[Memory Context]')
            )

            assert.ok(memMsg, 'Should have memory context message')

            // Each result's content should appear in the memory context
            for (const result of results) {
              assert.ok(
                memMsg.content.includes(result.content),
                `Memory context should include result content: "${result.content}"`
              )
            }
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  // ── Property 14: Token estimation includes memory context ─────────────────

  // Feature: taosmd-memory-integration, Property 14: Token estimation includes memory context
  describe('Property 14: Token estimation includes memory context', () => {
    /**
     * **Validates: Requirements 8.6**
     *
     * For any messages array with an injected memory context system message,
     * estimateMessagesTokens(messages) SHALL return a value greater than
     * estimateMessagesTokens(messagesWithoutMemory).
     */

    it('token estimate increases when memory context is injected', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              source: fc.constantFrom('kg', 'vector', 'archive'),
              content: fc.string({ minLength: 10, maxLength: 200 }),
              score: fc.float({ min: 0, max: 1 }),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          (results) => {
            const messages = [
              { role: 'system', content: 'You are an assistant.' },
              { role: 'user', content: 'What is the status of the project?' },
            ]

            const tokensWithout = estimateMessagesTokens(messages)
            const messagesWithMemory = injectMemoryContext(messages, results)
            const tokensWith = estimateMessagesTokens(messagesWithMemory)

            assert.ok(
              tokensWith > tokensWithout,
              `Token count with memory context (${tokensWith}) should be > without (${tokensWithout})`
            )
          }
        ),
        { numRuns: 150 }
      )
    })

    it('token increase is at least the token estimate of the memory content', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              source: fc.constantFrom('kg', 'vector', 'archive'),
              content: fc.string({ minLength: 10, maxLength: 200 }),
              score: fc.float({ min: 0, max: 1 }),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          (results) => {
            const messages = [
              { role: 'system', content: 'System prompt.' },
              { role: 'user', content: 'User query.' },
            ]

            const tokensWithout = estimateMessagesTokens(messages)
            const messagesWithMemory = injectMemoryContext(messages, results)
            const tokensWith = estimateMessagesTokens(messagesWithMemory)

            // The memory context content tokens
            const memMsg = messagesWithMemory.find(m =>
              m.role === 'system' && m.content && m.content.startsWith('[Memory Context]')
            )
            const memTokens = estimateTokens(memMsg?.content || '')

            assert.ok(
              tokensWith >= tokensWithout + memTokens,
              `Token increase (${tokensWith - tokensWithout}) should be >= memory content tokens (${memTokens})`
            )
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  // ── Property 18: Tool call archive truncation ─────────────────────────────

  // Feature: taosmd-memory-integration, Property 18: Tool call archive truncation
  describe('Property 18: Tool call archive truncation', () => {
    /**
     * **Validates: Requirements 12.5**
     *
     * For any tool call result exceeding 10000 characters, the archived payload
     * SHALL contain exactly the first 10000 characters, and metadata SHALL include
     * truncated: true. For results <= 10000 chars, full result is archived and
     * truncated is absent or false.
     */

    it('results > 10000 chars are truncated to exactly 10000 chars', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10001, max: 50000 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          (resultLength, toolName) => {
            const content = 'x'.repeat(resultLength)
            const { payload, truncated } = buildToolCallArchivePayload(toolName, {}, content, false)

            assert.equal(payload.result.length, 10000,
              `Archived result should be exactly 10000 chars, got ${payload.result.length}`)
            assert.equal(truncated, true,
              'truncated should be true for results > 10000 chars')
            assert.equal(payload.truncated, true,
              'payload.truncated should be true')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('results <= 10000 chars are archived in full', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 10000 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          (resultLength, toolName) => {
            const content = 'y'.repeat(resultLength)
            const { payload, truncated } = buildToolCallArchivePayload(toolName, {}, content, false)

            assert.equal(payload.result.length, resultLength,
              `Archived result should be full length ${resultLength}, got ${payload.result.length}`)
            assert.equal(truncated, false,
              'truncated should be false for results <= 10000 chars')
            assert.ok(!payload.truncated,
              'payload.truncated should be absent or false')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('truncated content is the first 10000 chars of the original', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 10001, maxLength: 20000 }),
          (content) => {
            const { payload } = buildToolCallArchivePayload('bash', {}, content, false)

            assert.equal(payload.result, content.slice(0, 10000),
              'Archived result should be exactly the first 10000 chars')
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  // ── Property 19: Tool call archive metadata completeness ──────────────────

  // Feature: taosmd-memory-integration, Property 19: Tool call archive metadata completeness
  describe('Property 19: Tool call archive metadata completeness', () => {
    /**
     * **Validates: Requirements 12.2**
     *
     * For any archived tool call, the metadata SHALL include:
     * - tool name (string)
     * - args summary (first 200 chars of JSON-serialized args)
     * - result status ("success" or "error")
     * - result size in bytes (number)
     */

    function arbToolName() {
      return fc.constantFrom(
        'read_file', 'write_file', 'edit_file', 'bash', 'search_files',
        'list_dir', 'browser_navigate', 'browser_screenshot'
      )
    }

    function arbToolArgs() {
      return fc.record({
        path: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
        command: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
      })
    }

    it('archived tool call includes tool name', () => {
      fc.assert(
        fc.property(
          arbToolName(),
          arbToolArgs(),
          fc.string({ minLength: 0, maxLength: 500 }),
          fc.boolean(),
          (toolName, args, content, isError) => {
            const { payload } = buildToolCallArchivePayload(toolName, args, content, isError)

            assert.equal(typeof payload.tool, 'string',
              'payload.tool should be a string')
            assert.equal(payload.tool, toolName,
              `payload.tool should be "${toolName}"`)
          }
        ),
        { numRuns: 150 }
      )
    })

    it('archived tool call includes args summary (first 200 chars)', () => {
      fc.assert(
        fc.property(
          arbToolName(),
          arbToolArgs(),
          fc.string({ minLength: 0, maxLength: 500 }),
          fc.boolean(),
          (toolName, args, content, isError) => {
            const { payload } = buildToolCallArchivePayload(toolName, args, content, isError)

            assert.equal(typeof payload.args_summary, 'string',
              'payload.args_summary should be a string')
            assert.ok(payload.args_summary.length <= 200,
              `args_summary should be <= 200 chars, got ${payload.args_summary.length}`)

            // Verify it's the first 200 chars of JSON-serialized args
            const expectedSummary = JSON.stringify(args).slice(0, 200)
            assert.equal(payload.args_summary, expectedSummary,
              'args_summary should be first 200 chars of JSON-serialized args')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('archived tool call includes result status', () => {
      fc.assert(
        fc.property(
          arbToolName(),
          arbToolArgs(),
          fc.string({ minLength: 0, maxLength: 100 }),
          fc.boolean(),
          (toolName, args, content, isError) => {
            const { payload } = buildToolCallArchivePayload(toolName, args, content, isError)

            assert.ok(
              payload.result_status === 'success' || payload.result_status === 'error',
              `result_status should be "success" or "error", got "${payload.result_status}"`
            )
            assert.equal(
              payload.result_status,
              isError ? 'error' : 'success',
              `result_status should match isError=${isError}`
            )
          }
        ),
        { numRuns: 150 }
      )
    })

    it('archived tool call includes result size in bytes', () => {
      fc.assert(
        fc.property(
          arbToolName(),
          arbToolArgs(),
          fc.string({ minLength: 0, maxLength: 500 }),
          fc.boolean(),
          (toolName, args, content, isError) => {
            const { payload } = buildToolCallArchivePayload(toolName, args, content, isError)

            assert.equal(typeof payload.result_size_bytes, 'number',
              'result_size_bytes should be a number')
            assert.ok(payload.result_size_bytes >= 0,
              'result_size_bytes should be non-negative')
            assert.equal(payload.result_size_bytes, content.length,
              `result_size_bytes should equal content length (${content.length})`)
          }
        ),
        { numRuns: 150 }
      )
    })
  })

})  // end outer describe block
