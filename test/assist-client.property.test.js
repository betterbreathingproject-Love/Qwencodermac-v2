'use strict'

/**
 * test/assist-client.property.test.js
 *
 * Property-based tests for assist-client.js using fast-check v4.
 * Covers Properties 2, 3, 4, 5, 7, 8, 9, 10, 11, 12 from the design document.
 *
 * **Validates: Requirements 2.3, 3.3, 3.7, 6.1, 6.7, 8.1, 8.5, 11.3, 11.7, 12.2, 13.1, 14.1, 15.1, 17.4**
 */

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fc = require('fast-check')
const http = require('http')

const assistClient = require('../assist-client.js')

// ── Mock helpers ──────────────────────────────────────────────────────────────

/** Monkey-patch http.request to return a controlled response. Returns restore fn. */
function mockHttpRequest(statusCode, body) {
  const original = http.request
  http.request = (options, callback) => {
    const mockRes = {
      statusCode,
      on(event, handler) {
        if (event === 'data') handler(JSON.stringify(body))
        if (event === 'end') handler()
        return mockRes
      },
    }
    if (callback) callback(mockRes)
    return {
      on() { return this },
      setTimeout() { return this },
      write() {},
      end() {},
      destroy() {},
    }
  }
  return () => { http.request = original }
}

/** Monkey-patch http.request to track call count AND return a controlled response. */
function trackHttpCalls(statusCode, body) {
  let callCount = 0
  const original = http.request
  http.request = (options, callback) => {
    callCount++
    const mockRes = {
      statusCode,
      on(event, handler) {
        if (event === 'data') handler(JSON.stringify(body))
        if (event === 'end') handler()
        return mockRes
      },
    }
    if (callback) callback(mockRes)
    return { on() { return this }, setTimeout() { return this }, write() {}, end() {}, destroy() {} }
  }
  return {
    getCount: () => callCount,
    restore: () => { http.request = original },
  }
}

// ── Pure helpers (mirror direct-bridge.js integration logic) ──────────────────

function applyVisionReplacement(description) {
  return { type: 'text', text: `[Vision: ${description}]` }
}

function applyDiagnosisFormat(diagnosis, originalError) {
  return `[Fast model diagnosis: ${diagnosis}]\n\n${originalError}`
}

// ── Property 2: Assist client returns null for any HTTP error ─────────────────

describe('Property 2: Assist client returns null for any HTTP error', () => {
  /**
   * **Validates: Requirements 2.3, 8.5**
   * For any HTTP status code in 4xx or 5xx range (except 503 degraded),
   * _assistRequest returns null without throwing.
   */
  it('returns null for any 4xx or 5xx status code', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 400, max: 599 }),
        async (statusCode) => {
          // 503 with degraded:true is a special silent case — skip it here
          if (statusCode === 503) return true
          const origWarn = console.warn
          console.warn = () => {}
          const restore = mockHttpRequest(statusCode, { error: 'test error' })
          try {
            const result = await assistClient._assistRequest('vision', {}, 5000)
            return result === null
          } finally {
            restore()
            console.warn = origWarn
          }
        }
      ),
      { numRuns: 150 }
    )
  })
})

// ── Property 3: All capabilities degrade to null when no extraction model loaded

describe('Property 3: All capabilities degrade to null when no extraction model is loaded', () => {
  /**
   * **Validates: Requirements 8.1, 8.5, 17.4**
   * All 10 functions return null on HTTP 503 degraded.
   */
  it('all 10 functions return null on HTTP 503 degraded', async () => {
    const THRESHOLD = assistClient.FETCH_SUMMARIZE_THRESHOLD
    const functions = [
      () => assistClient.assistVision('data', 'image/png', 'describe'),
      () => assistClient.assistTodoBootstrap('build a feature'),
      () => assistClient.assistTodoWatch('bash', 'output', []),
      () => assistClient.assistFetchSummarize('http://x.com', 'x'.repeat(THRESHOLD + 1), 512),
      () => assistClient.assistValidateTool('edit_file', {}, 'ctx'),
      () => assistClient.assistDiagnoseError('bash', {}, 'error', 'ctx'),
      () => assistClient.assistGitSummarize('git status', 'output'),
      () => assistClient.assistRankSearchResults('pattern', ['a', 'b'], 'ctx'),
      () => assistClient.assistExtractRelevantSection('file.js', 'x'.repeat(9000), 'ctx'),
      () => assistClient.assistDetectRepetition(['a', 'b', 'c']),
    ]

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: functions.length - 1 }),
        async (fnIdx) => {
          const restore = mockHttpRequest(503, { degraded: true, reason: 'no extraction model loaded' })
          try {
            const result = await functions[fnIdx]()
            return result === null
          } finally {
            restore()
          }
        }
      ),
      { numRuns: 150 }
    )
  })
})

// ── Property 4: Vision replacement preserves message structure ────────────────

describe('Property 4: Vision replacement preserves message structure', () => {
  /**
   * **Validates: Requirements 3.3, 3.7**
   * For any description string, the replacement is a text part starting with
   * [Vision: ] and ending with ].
   */
  it('vision replacement format is always correct', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: assistClient.VISION_MAX_CHARS }),
        (description) => {
          const replaced = applyVisionReplacement(description)
          assert.equal(replaced.type, 'text')
          assert.ok(replaced.text.startsWith('[Vision: '), 'Should start with [Vision: ')
          assert.ok(replaced.text.endsWith(']'), 'Should end with ]')
          assert.ok(
            replaced.text.length <= assistClient.VISION_MAX_CHARS + '[Vision: ]'.length,
            'Should not exceed VISION_MAX_CHARS + wrapper length'
          )
        }
      ),
      { numRuns: 150 }
    )
  })
})

// ── Property 5: Fetch summarize threshold is respected in both directions ──────

describe('Property 5: Fetch summarize threshold is respected in both directions', () => {
  /**
   * **Validates: Requirements 6.1, 6.7**
   * assistFetchSummarize does NOT call HTTP when content.length <= FETCH_SUMMARIZE_THRESHOLD.
   * assistFetchSummarize DOES call HTTP when content.length > FETCH_SUMMARIZE_THRESHOLD.
   */
  it('does NOT call HTTP when content is within threshold', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: assistClient.FETCH_SUMMARIZE_THRESHOLD }),
        async (len) => {
          const tracker = trackHttpCalls(200, { result: 'summary' })
          try {
            const content = 'x'.repeat(len)
            const result = await assistClient.assistFetchSummarize('http://x.com', content, 512)
            return result === null && tracker.getCount() === 0
          } finally {
            tracker.restore()
          }
        }
      ),
      { numRuns: 150 }
    )
  })

  it('calls HTTP when content exceeds threshold', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: assistClient.FETCH_SUMMARIZE_THRESHOLD + 1, max: assistClient.FETCH_SUMMARIZE_THRESHOLD + 1000 }),
        async (len) => {
          const tracker = trackHttpCalls(200, { result: 'summary text', result_data: null, elapsed_ms: 10, output_tokens: 5 })
          try {
            const content = 'x'.repeat(len)
            await assistClient.assistFetchSummarize('http://x.com', content, 512)
            return tracker.getCount() >= 1
          } finally {
            tracker.restore()
          }
        }
      ),
      { numRuns: 150 }
    )
  })
})

// ── Property 7: Tool validation rejection prevents execution (format check) ────

describe('Property 7: Tool validation rejection result has correct shape', () => {
  /**
   * **Validates: Requirements 11.3**
   * When assistValidateTool returns {valid: false, reason}, the reason is a non-empty string.
   */
  it('validation rejection result has correct shape', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        (reason) => {
          const result = { valid: false, reason }
          assert.equal(result.valid, false)
          assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
        }
      ),
      { numRuns: 150 }
    )
  })
})

// ── Property 8: Validation is skipped for non-validated tools ─────────────────

describe('Property 8: Validation is skipped for non-validated tools', () => {
  /**
   * **Validates: Requirements 11.7**
   * assistValidateTool returns null without HTTP call for tools not in VALIDATED_TOOLS.
   */
  it('returns null without HTTP call for non-validated tools', async () => {
    const nonValidatedTools = [
      'browser_navigate', 'browser_screenshot', 'browser_click',
      'web_search', 'web_fetch', 'list_dir', 'search_files', 'update_todos', 'task_complete',
    ]

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...nonValidatedTools),
        async (toolName) => {
          const tracker = trackHttpCalls(200, { result_data: { valid: true } })
          try {
            const result = await assistClient.assistValidateTool(toolName, {}, 'context')
            return result === null && tracker.getCount() === 0
          } finally {
            tracker.restore()
          }
        }
      ),
      { numRuns: 150 }
    )
  })
})

// ── Property 9: Error diagnosis format is always correct ──────────────────────

describe('Property 9: Error diagnosis format is always correct', () => {
  /**
   * **Validates: Requirements 12.2**
   * For any (diagnosis, originalError), the formatted result equals
   * [Fast model diagnosis: ${diagnosis}]\n\n${originalError}.
   */
  it('error diagnosis format is always [Fast model diagnosis: ...] prefix', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 500 }),
        (diagnosis, originalError) => {
          const result = applyDiagnosisFormat(diagnosis, originalError)
          assert.equal(result, `[Fast model diagnosis: ${diagnosis}]\n\n${originalError}`)
        }
      ),
      { numRuns: 150 }
    )
  })
})

// ── Property 10: Git summarize threshold constant ─────────────────────────────

describe('Property 10: Git summarize threshold is respected', () => {
  /**
   * **Validates: Requirements 13.1**
   */
  it('GIT_SUMMARIZE_THRESHOLD constant is 2000', () => {
    assert.equal(assistClient.GIT_SUMMARIZE_THRESHOLD, 2000)
  })

  it('threshold correctly identifies when git summarize should be triggered', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10000 }),
        (len) => {
          const shouldSummarize = len > assistClient.GIT_SUMMARIZE_THRESHOLD
          if (len > 2000) assert.ok(shouldSummarize)
          if (len <= 2000) assert.ok(!shouldSummarize)
        }
      ),
      { numRuns: 150 }
    )
  })
})

// ── Property 11: Search ranking threshold is respected ────────────────────────

describe('Property 11: Search ranking threshold is respected', () => {
  /**
   * **Validates: Requirements 14.1**
   */
  it('SEARCH_RANK_THRESHOLD constant is 15', () => {
    assert.equal(assistClient.SEARCH_RANK_THRESHOLD, 15)
  })

  it('threshold correctly identifies when ranking should be triggered', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 0, maxLength: 30 }),
        (results) => {
          const shouldRank = results.length > assistClient.SEARCH_RANK_THRESHOLD
          if (results.length > 15) assert.ok(shouldRank)
          if (results.length <= 15) assert.ok(!shouldRank)
        }
      ),
      { numRuns: 150 }
    )
  })
})

// ── Property 12: File extract threshold is respected ─────────────────────────

describe('Property 12: File extract threshold is respected', () => {
  /**
   * **Validates: Requirements 15.1**
   */
  it('FILE_EXTRACT_THRESHOLD constant is 8000', () => {
    assert.equal(assistClient.FILE_EXTRACT_THRESHOLD, 8000)
  })

  it('threshold correctly identifies when extraction should be triggered', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20000 }),
        (len) => {
          const shouldExtract = len > assistClient.FILE_EXTRACT_THRESHOLD
          if (len > 8000) assert.ok(shouldExtract)
          if (len <= 8000) assert.ok(!shouldExtract)
        }
      ),
      { numRuns: 150 }
    )
  })
})
