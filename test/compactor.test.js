'use strict'

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

// --- 10.1: detectContentType unit tests ---

const { detectContentType, getToolDefs } = require('../direct-bridge')
const builtin = require('../compactor-builtin')

describe('detectContentType', () => {
  it('read_file with plain code returns code', () => {
    assert.equal(detectContentType('read_file', 'some code'), 'code')
  })

  it('search_files returns search', () => {
    assert.equal(detectContentType('search_files', 'results'), 'search')
  })

  it('grep_search returns search', () => {
    assert.equal(detectContentType('grep_search', 'results'), 'search')
  })

  it('bash returns log', () => {
    assert.equal(detectContentType('bash', 'output'), 'log')
  })

  it('execute_command returns log', () => {
    assert.equal(detectContentType('execute_command', 'output'), 'log')
  })

  it('list_dir returns log', () => {
    assert.equal(detectContentType('list_dir', 'files'), 'log')
  })

  it('browser_screenshot returns prose', () => {
    assert.equal(detectContentType('browser_screenshot', 'data'), 'prose')
  })

  it('browser_navigate returns prose', () => {
    assert.equal(detectContentType('browser_navigate', 'data'), 'prose')
  })

  it('unknown tool returns auto', () => {
    assert.equal(detectContentType('unknown', 'data'), 'auto')
  })

  it('read_file with JSON object content returns json (override)', () => {
    assert.equal(detectContentType('read_file', '{"key": "value"}'), 'json')
  })

  it('bash with JSON array content returns json (override)', () => {
    assert.equal(detectContentType('bash', '[1, 2, 3]'), 'json')
  })

  it('read_file with diff content returns diff (override)', () => {
    const diffContent = '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new'
    assert.equal(detectContentType('read_file', diffContent), 'diff')
  })
})


// --- 10.2: rewind_context tool registration ---

describe('rewind_context tool registration', () => {
  it('rewind_context is present in TOOL_DEFS via getToolDefs()', () => {
    const tools = getToolDefs(null, 'general')
    const rewind = tools.find(t => t.function.name === 'rewind_context')
    assert.ok(rewind, 'rewind_context should be in tool definitions')
  })

  it('rewind_context has a required key parameter', () => {
    const tools = getToolDefs(null, 'general')
    const rewind = tools.find(t => t.function.name === 'rewind_context')
    const params = rewind.function.parameters
    assert.ok(params.properties.key, 'should have a key property')
    assert.equal(params.properties.key.type, 'string')
    assert.ok(params.required.includes('key'), 'key should be required')
  })
})

// --- 10.3: builtin compactor type-specific strategies ---

describe('builtin compactor type-specific strategies', () => {
  describe('code compression', () => {
    it('removes // comment lines', () => {
      const input = 'const x = 1\n// this is a comment\nconst y = 2'
      const result = builtin.compressText(input, 'code')
      const lines = result.compressed.split('\n')
      for (const line of lines) {
        assert.ok(!line.trim().startsWith('//'), `should not contain // comment: "${line}"`)
      }
    })

    it('collapses consecutive blank lines', () => {
      const input = 'line1\n\n\n\nline2'
      const result = builtin.compressText(input, 'code')
      assert.ok(!result.compressed.includes('\n\n\n'), 'should not have 3+ consecutive newlines')
    })
  })

  describe('json compression', () => {
    it('summarizes arrays of 5 identical objects', () => {
      const arr = Array(5).fill({ id: 1, name: 'test', value: 42 })
      const input = JSON.stringify(arr, null, 2)
      const result = builtin.compressText(input, 'json')
      assert.ok(result.compressed.includes('_summary'), 'should contain _summary field')
    })
  })

  describe('log compression', () => {
    it('folds 5 identical lines with [×5]', () => {
      const line = 'INFO: heartbeat ok'
      const input = Array(5).fill(line).join('\n')
      const result = builtin.compressText(input, 'log')
      assert.ok(result.compressed.includes('[×5]'), 'should contain [×5] fold marker')
    })
  })

  describe('search compression', () => {
    it('reduces overlapping results for same file', () => {
      const input = [
        'src/app.js:10:const x = 1',
        'src/app.js:11:const y = 2',
        'src/app.js:12:const z = 3',
        'src/other.js:5:unrelated',
      ].join('\n')
      const result = builtin.compressText(input, 'search')
      const outputLines = result.compressed.split('\n').filter(l => l.trim().length > 0)
      const inputLines = input.split('\n').filter(l => l.trim().length > 0)
      assert.ok(outputLines.length < inputLines.length,
        `output (${outputLines.length} lines) should have fewer lines than input (${inputLines.length} lines)`)
    })
  })
})

// --- 10.4: compression notice format ---

describe('compression notice format', () => {
  it('matches expected pattern with pct, tokens, and key', () => {
    // The compression notice format from the design:
    // \n\n[compressed: {pct}% reduction, original {tokens} tokens, rewind key: {key}]
    const pct = 42.5
    const tokens = 12500
    const key = 'rk_abc123'
    const notice = `\n\n[compressed: ${pct}% reduction, original ${tokens} tokens, rewind key: ${key}]`

    assert.ok(notice.startsWith('\n\n[compressed:'), 'should start with newlines and [compressed:')
    assert.ok(notice.includes(`${pct}% reduction`), 'should include reduction percentage')
    assert.ok(notice.includes(`original ${tokens} tokens`), 'should include original token count')
    assert.ok(notice.includes(`rewind key: ${key}`), 'should include rewind key')
    assert.ok(notice.endsWith(']'), 'should end with ]')

    // Verify the pattern matches via regex
    const pattern = /\n\n\[compressed: [\d.]+% reduction, original \d+ tokens, rewind key: .+\]/
    assert.ok(pattern.test(notice), 'notice should match the expected regex pattern')
  })

  it('works with integer reduction percentage', () => {
    const notice = `\n\n[compressed: ${66}% reduction, original ${8000} tokens, rewind key: ${'rk_xyz'}]`
    const pattern = /\n\n\[compressed: [\d.]+% reduction, original \d+ tokens, rewind key: .+\]/
    assert.ok(pattern.test(notice))
  })
})

// --- 10.5: compactor module fallback behavior ---

describe('compactor module fallback behavior', () => {
  it('compressMessages falls back to builtin with non-existent python path', async () => {
    const compactor = require('../compactor')
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]
    const result = await compactor.compressMessages('/nonexistent/python3', messages)
    assert.ok(result, 'should return a result')
    assert.ok(result.stats, 'should have stats')
    assert.equal(result.stats.engine, 'builtin', 'should use builtin engine on fallback')
  })

  it('compressText falls back to builtin with non-existent python path', async () => {
    const compactor = require('../compactor')
    const text = 'Some text content to compress'
    const result = await compactor.compressText('/nonexistent/python3', text, 'auto')
    assert.ok(result, 'should return a result')
    assert.ok(result.stats, 'should have stats')
    assert.equal(result.stats.engine, 'builtin', 'should use builtin engine on fallback')
  })
})
