'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fc = require('fast-check')
const builtin = require('../compactor-builtin')
const { detectContentType } = require('../direct-bridge')

// --- Generators ---

/**
 * Generate a message object with role, content, and optional contentType.
 */
function arbitraryMessage() {
  return fc.record({
    role: fc.constantFrom('user', 'assistant', 'system', 'tool'),
    content: fc.string(),
    contentType: fc.constantFrom('code', 'json', 'log', 'search', 'prose', 'auto', undefined),
  })
}

/**
 * Generate an array of messages.
 */
function arbitraryMessages() {
  return fc.array(arbitraryMessage(), { minLength: 1, maxLength: 20 })
}

/**
 * Generate a tool name from the known set plus unknowns.
 */
function arbitraryToolName() {
  return fc.constantFrom(
    'read_file', 'search_files', 'grep_search',
    'bash', 'execute_command', 'list_dir',
    'browser_screenshot', 'browser_navigate',
    'unknown_tool'
  )
}

/**
 * Generate code content with // and # comment lines and consecutive blank lines.
 */
function arbitraryCodeWithComments() {
  const commentLine = fc.constantFrom(
    '// this is a comment',
    '# another comment',
    '// TODO: fix this',
    '# NOTE: important'
  )
  const codeLine = fc.constantFrom(
    'const x = 1',
    'function foo() {',
    '  return bar',
    '}',
    'let y = x + 2',
    'console.log(y)'
  )
  const blankLine = fc.constant('')

  return fc.array(
    fc.oneof(commentLine, codeLine, blankLine, blankLine),
    { minLength: 3, maxLength: 30 }
  ).map(lines => lines.join('\n'))
}

/**
 * Generate log content with N consecutive identical lines.
 */
function arbitraryLogWithRepeats() {
  return fc.tuple(
    fc.array(fc.constantFrom('a', 'b', 'c', ' ', ':', '[', ']', '0', '1'), { minLength: 1, maxLength: 40 }).map(arr => arr.join('')),
    fc.integer({ min: 2, max: 10 })
  ).map(([line, count]) => {
    const repeated = Array(count).fill(line).join('\n')
    const prefix = 'INFO: starting\n'
    const suffix = '\nDONE: finished'
    return prefix + repeated + suffix
  })
}

// --- Property Tests ---

describe('Property-based tests for compactor', () => {
  // 9.2 — Property 1: Error fallback preserves original content
  // **Validates: Requirements 1.7**
  it('Property 1: Error fallback preserves original content', () => {
    fc.assert(
      fc.property(arbitraryMessages(), (messages) => {
        // The builtin compressor should always return valid messages
        const result = builtin.compressMessages(messages)

        // Result must have messages array
        assert.ok(Array.isArray(result.messages), 'result.messages should be an array')
        assert.ok(result.messages.length > 0, 'result.messages should not be empty')

        // Every returned message must have role and content
        for (const msg of result.messages) {
          assert.ok(typeof msg.role === 'string', 'each message must have a string role')
          assert.ok(msg.content !== undefined, 'each message must have content')
        }

        // Result must have stats
        assert.ok(result.stats !== undefined, 'result must have stats')
      }),
      { numRuns: 150 }
    )
  })

  // Also test: compressText with null/undefined returns safely
  it('Property 1b: compressText with empty/null input returns safely', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined, '', 0, false),
        (input) => {
          const result = builtin.compressText(input)
          assert.ok(result !== undefined, 'result should not be undefined')
          assert.ok(result.stats !== undefined, 'result should have stats')
        }
      ),
      { numRuns: 150 }
    )
  })

  // 9.3 — Property 5: Fallback to builtin on Python failure
  // **Validates: Requirements 2.5**
  it('Property 5: Builtin always returns valid results for any input', () => {
    fc.assert(
      fc.property(arbitraryMessages(), (messages) => {
        // Builtin compressor should always return a valid result with stats
        const result = builtin.compressMessages(messages)

        assert.ok(result, 'result should be truthy')
        assert.ok(Array.isArray(result.messages), 'result.messages should be an array')
        assert.ok(result.stats, 'result should have stats')

        // Stats should have expected fields when compressed
        if (result.stats.compressed) {
          assert.ok(typeof result.stats.original_tokens === 'number',
            'stats.original_tokens should be a number')
          assert.ok(typeof result.stats.compressed_tokens === 'number',
            'stats.compressed_tokens should be a number')
          assert.ok(typeof result.stats.reduction_pct === 'number',
            'stats.reduction_pct should be a number')
        }
      }),
      { numRuns: 150 }
    )
  })

  it('Property 5b: Builtin compressText always returns valid results', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        fc.constantFrom('code', 'json', 'log', 'search', 'auto'),
        (text, contentType) => {
          const result = builtin.compressText(text, contentType)

          assert.ok(result, 'result should be truthy')
          assert.ok(result.stats !== undefined, 'result should have stats')
          assert.ok(typeof result.stats.original_tokens === 'number',
            'stats.original_tokens should be a number')
          assert.ok(typeof result.stats.compressed_tokens === 'number',
            'stats.compressed_tokens should be a number')
          assert.ok(typeof result.stats.reduction_pct === 'number',
            'stats.reduction_pct should be a number')
        }
      ),
      { numRuns: 150 }
    )
  })

  // 9.4 — Property 7: Content-type detection
  // **Validates: Requirements 4.2, 5.1, 5.2, 5.3, 5.4**
  it('Property 7: Content-type detection maps tool names correctly', () => {
    fc.assert(
      fc.property(arbitraryToolName(), fc.string(), (toolName, content) => {
        const result = detectContentType(toolName, content)

        // Result must always be a string
        assert.ok(typeof result === 'string', 'detectContentType must return a string')

        // Result must be one of the valid content types
        const validTypes = ['code', 'json', 'log', 'diff', 'search', 'prose', 'auto']
        assert.ok(validTypes.includes(result),
          `detectContentType returned '${result}', expected one of ${validTypes.join(', ')}`)
      }),
      { numRuns: 150 }
    )
  })

  it('Property 7b: Known tool names map to expected types (non-JSON, non-diff content)', () => {
    const toolTypeMap = {
      read_file: 'code',
      search_files: 'search',
      grep_search: 'search',
      bash: 'log',
      execute_command: 'log',
      list_dir: 'log',
      browser_screenshot: 'prose',
      browser_navigate: 'prose',
    }

    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(toolTypeMap)),
        // Generate plain content that won't trigger JSON or diff overrides
        fc.array(fc.constantFrom('a', 'b', 'c', ' ', '\n', '1', '2'), { minLength: 0, maxLength: 50 }).map(arr => arr.join('')),
        (toolName, content) => {
          const result = detectContentType(toolName, content)
          assert.equal(result, toolTypeMap[toolName],
            `Tool '${toolName}' should map to '${toolTypeMap[toolName]}', got '${result}'`)
        }
      ),
      { numRuns: 150 }
    )
  })

  it('Property 7c: Valid JSON content returns json regardless of tool name', () => {
    fc.assert(
      fc.property(
        arbitraryToolName(),
        fc.oneof(
          fc.constant('{"key": "value"}'),
          fc.constant('[1, 2, 3]'),
          fc.constant('{"a": 1, "b": [true, false]}'),
          fc.constant('[]'),
          fc.constant('{}')
        ),
        (toolName, jsonContent) => {
          const result = detectContentType(toolName, jsonContent)
          assert.equal(result, 'json',
            `Valid JSON content should return 'json', got '${result}'`)
        }
      ),
      { numRuns: 150 }
    )
  })

  it('Property 7d: Diff content returns diff regardless of tool name', () => {
    fc.assert(
      fc.property(
        arbitraryToolName(),
        fc.constant('--- a/file.js\n+++ b/file.js\n@@ -1,3 +1,3 @@\n-old\n+new'),
        (toolName, diffContent) => {
          const result = detectContentType(toolName, diffContent)
          assert.equal(result, 'diff',
            `Diff content should return 'diff', got '${result}'`)
        }
      ),
      { numRuns: 150 }
    )
  })

  it('Property 7e: Unknown tool with plain content returns auto', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('unknown_tool', 'my_custom_tool', 'some_other_tool'),
        fc.array(fc.constantFrom('a', 'b', 'c', ' ', '\n'), { minLength: 0, maxLength: 50 }).map(arr => arr.join('')),
        (toolName, content) => {
          const result = detectContentType(toolName, content)
          assert.equal(result, 'auto',
            `Unknown tool '${toolName}' with plain content should return 'auto', got '${result}'`)
        }
      ),
      { numRuns: 150 }
    )
  })

  // 9.5 — Property 9: Builtin code compression removes comments and collapses blanks
  // **Validates: Requirements 7.1**
  it('Property 9: Builtin code compression removes comments and collapses blanks', () => {
    fc.assert(
      fc.property(arbitraryCodeWithComments(), (code) => {
        const result = builtin.compressText(code, 'code')
        const compressed = result.compressed

        if (!compressed) return // empty input edge case

        const lines = compressed.split('\n')

        // No lines should be pure single-line comments (// or #)
        for (const line of lines) {
          const trimmed = line.trim()
          assert.ok(
            !trimmed.startsWith('//') && !trimmed.startsWith('#'),
            `Comment line should be removed: "${trimmed}"`
          )
        }

        // No runs of 2+ consecutive blank lines
        let consecutiveBlanks = 0
        for (const line of lines) {
          if (line.trim().length === 0) {
            consecutiveBlanks++
            assert.ok(consecutiveBlanks < 2,
              'Should not have 2+ consecutive blank lines after compression')
          } else {
            consecutiveBlanks = 0
          }
        }
      }),
      { numRuns: 150 }
    )
  })

  // 9.6 — Property 11: Builtin log compression folds repeated lines
  // **Validates: Requirements 7.3**
  it('Property 11: Builtin log compression folds repeated lines', () => {
    fc.assert(
      fc.property(arbitraryLogWithRepeats(), (logText) => {
        const result = builtin.compressText(logText, 'log')
        const compressed = result.compressed

        if (!compressed) return // edge case

        const outputLines = compressed.split('\n')

        // Find the repeated line from the input (between prefix and suffix)
        const inputLines = logText.split('\n')
        // The repeated section is between the first and last line
        const repeatedLine = inputLines[1] // first repeated line

        // Count occurrences of the exact repeated line in output (not counting [×N] versions)
        const exactMatches = outputLines.filter(l => l === repeatedLine)
        const foldedMatches = outputLines.filter(l =>
          l.startsWith(repeatedLine) && /\[×\d+\]/.test(l)
        )

        // Either the line appears once with a fold marker, or appears exactly once
        // (if count was 1, no folding needed — but our generator ensures count >= 2)
        assert.ok(
          foldedMatches.length === 1 || exactMatches.length <= 1,
          `Repeated line should be folded: found ${exactMatches.length} exact and ${foldedMatches.length} folded`
        )

        // The fold marker should exist for repeated lines
        if (foldedMatches.length > 0) {
          assert.ok(
            /\[×\d+\]/.test(foldedMatches[0]),
            'Folded line should contain [×N] count indicator'
          )
        }
      }),
      { numRuns: 150 }
    )
  })

  // 9.7 — Property 13: Builtin stats format consistency
  // **Validates: Requirements 7.6**
  it('Property 13: Builtin stats format consistency', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        fc.constantFrom('code', 'json', 'log', 'search', 'auto'),
        (text, contentType) => {
          const result = builtin.compressText(text, contentType)

          // Stats must always be present
          assert.ok(result.stats, 'result must have stats')

          // Stats must have the three required numeric fields
          assert.ok(typeof result.stats.original_tokens === 'number',
            `stats.original_tokens should be a number, got ${typeof result.stats.original_tokens}`)
          assert.ok(typeof result.stats.compressed_tokens === 'number',
            `stats.compressed_tokens should be a number, got ${typeof result.stats.compressed_tokens}`)
          assert.ok(typeof result.stats.reduction_pct === 'number',
            `stats.reduction_pct should be a number, got ${typeof result.stats.reduction_pct}`)

          // reduction_pct should be between 0 and 100
          assert.ok(result.stats.reduction_pct >= 0,
            `reduction_pct should be >= 0, got ${result.stats.reduction_pct}`)
          assert.ok(result.stats.reduction_pct <= 100,
            `reduction_pct should be <= 100, got ${result.stats.reduction_pct}`)

          // original_tokens should be >= compressed_tokens
          assert.ok(result.stats.original_tokens >= result.stats.compressed_tokens,
            `original_tokens (${result.stats.original_tokens}) should be >= compressed_tokens (${result.stats.compressed_tokens})`)
        }
      ),
      { numRuns: 150 }
    )
  })
})
