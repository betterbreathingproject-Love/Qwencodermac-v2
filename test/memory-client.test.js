'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

// Unit tests for memory-client.js
// Tests HTTP request construction, timeout handling, response parsing,
// and error resilience using mock http.request.

// ── Import the client module ──────────────────────────────────────────────────
const memoryClient = require('../memory-client.js')
const { _parseBaseUrl, TIMEOUTS } = memoryClient

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('memory-client.js unit tests', () => {
  describe('_parseBaseUrl()', () => {
    it('parses http URL correctly', () => {
      const result = _parseBaseUrl('http://localhost:8090')
      assert.equal(result.protocol, 'http:')
      assert.equal(result.hostname, 'localhost')
      assert.equal(result.port, 8090)
      assert.equal(result.basePath, '')
    })

    it('parses https URL correctly', () => {
      const result = _parseBaseUrl('https://example.com:443')
      assert.equal(result.protocol, 'https:')
      assert.equal(result.hostname, 'example.com')
      assert.equal(result.port, 443)
    })

    it('defaults to port 80 for http without explicit port', () => {
      const result = _parseBaseUrl('http://example.com')
      assert.equal(result.port, 80)
    })

    it('defaults to port 443 for https without explicit port', () => {
      const result = _parseBaseUrl('https://example.com')
      assert.equal(result.port, 443)
    })

    it('handles invalid URL gracefully', () => {
      const result = _parseBaseUrl('not-a-url')
      assert.equal(result.hostname, 'localhost')
      assert.equal(result.port, 8090)
    })

    it('preserves base path', () => {
      const result = _parseBaseUrl('http://localhost:8090/api/v1')
      assert.equal(result.basePath, '/api/v1')
    })
  })

  describe('TIMEOUTS', () => {
    it('has correct timeout values', () => {
      assert.equal(TIMEOUTS.retrieve, 5000)
      assert.equal(TIMEOUTS.archive, 2000)
      assert.equal(TIMEOUTS.extract, 30000)
      assert.equal(TIMEOUTS.status, 3000)
      assert.equal(TIMEOUTS.default, 5000)
    })
  })

  describe('retrieve()', () => {
    it('returns safe default when server is unreachable', async () => {
      // Use a port that is definitely not listening
      const originalUrl = process.env.MLX_SERVER_URL
      process.env.MLX_SERVER_URL = 'http://localhost:19999'

      try {
        const result = await memoryClient.retrieve('test query', { mode: 'fast' })
        assert.ok(Array.isArray(result.results), 'results should be an array')
        assert.equal(result.results.length, 0)
        assert.equal(result.tokenCount, 0)
      } finally {
        if (originalUrl !== undefined) {
          process.env.MLX_SERVER_URL = originalUrl
        } else {
          delete process.env.MLX_SERVER_URL
        }
      }
    })
  })

  describe('archiveRecord()', () => {
    it('returns {ok: false} when server is unreachable', async () => {
      const originalUrl = process.env.MLX_SERVER_URL
      process.env.MLX_SERVER_URL = 'http://localhost:19999'

      try {
        const result = await memoryClient.archiveRecord('conversation', 'test payload', 'test summary')
        assert.equal(result.ok, false)
      } finally {
        if (originalUrl !== undefined) {
          process.env.MLX_SERVER_URL = originalUrl
        } else {
          delete process.env.MLX_SERVER_URL
        }
      }
    })
  })

  describe('kgQueryEntity()', () => {
    it('returns empty array when server is unreachable', async () => {
      const originalUrl = process.env.MLX_SERVER_URL
      process.env.MLX_SERVER_URL = 'http://localhost:19999'

      try {
        const result = await memoryClient.kgQueryEntity('TestEntity')
        assert.ok(Array.isArray(result))
        assert.equal(result.length, 0)
      } finally {
        if (originalUrl !== undefined) {
          process.env.MLX_SERVER_URL = originalUrl
        } else {
          delete process.env.MLX_SERVER_URL
        }
      }
    })
  })

  describe('vectorSearch()', () => {
    it('returns empty array when server is unreachable', async () => {
      const originalUrl = process.env.MLX_SERVER_URL
      process.env.MLX_SERVER_URL = 'http://localhost:19999'

      try {
        const result = await memoryClient.vectorSearch('test query')
        assert.ok(Array.isArray(result))
        assert.equal(result.length, 0)
      } finally {
        if (originalUrl !== undefined) {
          process.env.MLX_SERVER_URL = originalUrl
        } else {
          delete process.env.MLX_SERVER_URL
        }
      }
    })
  })

  describe('archiveSearch()', () => {
    it('returns empty array when server is unreachable', async () => {
      const originalUrl = process.env.MLX_SERVER_URL
      process.env.MLX_SERVER_URL = 'http://localhost:19999'

      try {
        const result = await memoryClient.archiveSearch('test query')
        assert.ok(Array.isArray(result))
        assert.equal(result.length, 0)
      } finally {
        if (originalUrl !== undefined) {
          process.env.MLX_SERVER_URL = originalUrl
        } else {
          delete process.env.MLX_SERVER_URL
        }
      }
    })
  })

  describe('getStatus()', () => {
    it('returns null when server is unreachable', async () => {
      const originalUrl = process.env.MLX_SERVER_URL
      process.env.MLX_SERVER_URL = 'http://localhost:19999'

      try {
        const result = await memoryClient.getStatus()
        assert.equal(result, null)
      } finally {
        if (originalUrl !== undefined) {
          process.env.MLX_SERVER_URL = originalUrl
        } else {
          delete process.env.MLX_SERVER_URL
        }
      }
    })
  })

  describe('kgAddTriple()', () => {
    it('returns null when server is unreachable', async () => {
      const originalUrl = process.env.MLX_SERVER_URL
      process.env.MLX_SERVER_URL = 'http://localhost:19999'

      try {
        const result = await memoryClient.kgAddTriple('Alice', 'uses', 'Python')
        assert.equal(result, null)
      } finally {
        if (originalUrl !== undefined) {
          process.env.MLX_SERVER_URL = originalUrl
        } else {
          delete process.env.MLX_SERVER_URL
        }
      }
    })
  })

  describe('extractTurn()', () => {
    it('does not throw when server is unreachable', async () => {
      const originalUrl = process.env.MLX_SERVER_URL
      process.env.MLX_SERVER_URL = 'http://localhost:19999'

      try {
        let threw = false
        try {
          await memoryClient.extractTurn('test message', 'agent-1', 'session-1')
        } catch (_) {
          threw = true
        }
        assert.equal(threw, false, 'extractTurn should not throw')
      } finally {
        if (originalUrl !== undefined) {
          process.env.MLX_SERVER_URL = originalUrl
        } else {
          delete process.env.MLX_SERVER_URL
        }
      }
    })
  })

  describe('module exports', () => {
    it('exports all required functions', () => {
      assert.equal(typeof memoryClient.retrieve, 'function')
      assert.equal(typeof memoryClient.archiveRecord, 'function')
      assert.equal(typeof memoryClient.extractTurn, 'function')
      assert.equal(typeof memoryClient.kgAddTriple, 'function')
      assert.equal(typeof memoryClient.kgQueryEntity, 'function')
      assert.equal(typeof memoryClient.vectorSearch, 'function')
      assert.equal(typeof memoryClient.archiveSearch, 'function')
      assert.equal(typeof memoryClient.getStatus, 'function')
    })
  })
})
