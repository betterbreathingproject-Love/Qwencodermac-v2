'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

// Unit tests for memory-bridge.py session management endpoints
// Tests use in-memory mocks to simulate the Python backend behavior

// ── Mock helpers ──────────────────────────────────────────────────────────────

function createMockArchive(events = []) {
  return {
    recent_events(limit = 50) {
      return events.slice(0, limit)
    },
    count() { return events.length },
  }
}

function createMockEvent(sessionId, payload, summary) {
  return {
    id: Math.floor(Math.random() * 10000),
    event_type: 'conversation',
    payload,
    summary,
    agent_name: 'test-agent',
    session_id: sessionId,
    timestamp: new Date(),
  }
}

// ── Simulate session_enrich heuristic tier ────────────────────────────────────

function simulateSessionEnrich(sessionId, archive, extractModel = null) {
  if (archive === null) {
    return { ok: false, error: 'Archive is unavailable' }
  }

  const allEvents = archive.recent_events(100)
  const sessionEvents = allEvents.filter(e => e.session_id === sessionId)

  const sessionText = sessionEvents
    .map(e => `${e.payload || ''} ${e.summary || ''}`)
    .join(' ')
    .slice(0, 2000)

  const enrichment = {
    session_id: sessionId,
    event_count: sessionEvents.length,
  }

  if (extractModel !== null && sessionText) {
    // Simulate LLM enrichment (mocked)
    enrichment.topics = 'coding, testing, debugging'
    enrichment.description = 'A coding session with testing activities'
    enrichment.category = 'coding'
    enrichment.enrichment_tier = 'llm'
  } else {
    // Heuristic enrichment
    const words = sessionText.toLowerCase().match(/\b[a-zA-Z]{4,}\b/g) || []
    const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'been', 'they', 'were', 'what', 'when', 'where', 'which', 'your', 'their', 'there', 'then', 'than', 'also', 'into', 'some', 'more', 'about', 'would', 'could', 'should'])
    const wordFreq = {}
    for (const w of words) {
      if (!stopWords.has(w)) wordFreq[w] = (wordFreq[w] || 0) + 1
    }
    const topics = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => w)

    enrichment.topics = topics.join(', ')
    enrichment.description = `Session with ${sessionEvents.length} events`
    enrichment.category = 'other'
    enrichment.enrichment_tier = 'heuristic'
  }

  return { ok: true, enrichment }
}

// ── Simulate session_crystallize ──────────────────────────────────────────────

function simulateSessionCrystallize(sessionId, archive, extractModel = null) {
  if (archive === null) {
    return { ok: false, error: 'Archive is unavailable' }
  }

  const allEvents = archive.recent_events(200)
  const sessionEvents = allEvents.filter(e => e.session_id === sessionId)

  const crystal = {
    session_id: sessionId,
    event_count: sessionEvents.length,
  }

  if (extractModel !== null) {
    // Simulate LLM crystal generation (mocked)
    crystal.summary = 'The session involved implementing a new feature with tests.'
    crystal.outcomes = 'Feature implemented, tests passing'
    crystal.lessons = 'Always write tests first'
    crystal.crystal_tier = 'llm'
  } else {
    // Heuristic crystal
    crystal.summary = `Session ${sessionId} with ${sessionEvents.length} events`
    crystal.outcomes = 'Session completed'
    crystal.lessons = ''
    crystal.crystal_tier = 'heuristic'
  }

  return { ok: true, crystal }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('memory-bridge session management unit tests', () => {
  describe('POST /memory/session/enrich', () => {
    it('returns error when archive is unavailable', () => {
      const result = simulateSessionEnrich('session-1', null)
      assert.equal(result.ok, false)
      assert.ok(result.error.includes('unavailable'))
    })

    it('heuristic enrichment when no extraction model loaded', () => {
      const events = [
        createMockEvent('session-1', 'implementing authentication module', 'auth work'),
        createMockEvent('session-1', 'writing unit tests for login', 'test writing'),
        createMockEvent('session-1', 'debugging token validation', 'debug session'),
      ]
      const archive = createMockArchive(events)

      const result = simulateSessionEnrich('session-1', archive, null)

      assert.equal(result.ok, true)
      assert.equal(result.enrichment.session_id, 'session-1')
      assert.equal(result.enrichment.event_count, 3)
      assert.equal(result.enrichment.enrichment_tier, 'heuristic')
      assert.ok(typeof result.enrichment.topics === 'string')
      assert.ok(typeof result.enrichment.description === 'string')
      assert.ok(typeof result.enrichment.category === 'string')
    })

    it('LLM enrichment when extraction model is loaded', () => {
      const events = [
        createMockEvent('session-2', 'building REST API endpoints', 'api work'),
      ]
      const archive = createMockArchive(events)
      const mockExtractModel = { name: 'Qwen3-4B' }

      const result = simulateSessionEnrich('session-2', archive, mockExtractModel)

      assert.equal(result.ok, true)
      assert.equal(result.enrichment.enrichment_tier, 'llm')
      assert.ok(result.enrichment.topics.length > 0)
      assert.ok(result.enrichment.description.length > 0)
    })

    it('only enriches events for the specified session_id', () => {
      const events = [
        createMockEvent('session-A', 'session A content', 'session A'),
        createMockEvent('session-B', 'session B content', 'session B'),
        createMockEvent('session-A', 'more session A content', 'session A again'),
      ]
      const archive = createMockArchive(events)

      const resultA = simulateSessionEnrich('session-A', archive, null)
      const resultB = simulateSessionEnrich('session-B', archive, null)

      assert.equal(resultA.enrichment.event_count, 2)
      assert.equal(resultB.enrichment.event_count, 1)
    })

    it('handles empty session gracefully', () => {
      const archive = createMockArchive([])
      const result = simulateSessionEnrich('empty-session', archive, null)

      assert.equal(result.ok, true)
      assert.equal(result.enrichment.event_count, 0)
      assert.equal(result.enrichment.enrichment_tier, 'heuristic')
    })
  })

  describe('POST /memory/session/crystallize', () => {
    it('returns error when archive is unavailable', () => {
      const result = simulateSessionCrystallize('session-1', null)
      assert.equal(result.ok, false)
      assert.ok(result.error.includes('unavailable'))
    })

    it('heuristic crystal generation when no extraction model loaded', () => {
      const events = [
        createMockEvent('session-3', 'implemented feature X', 'feature work'),
        createMockEvent('session-3', 'fixed bug in module Y', 'bug fix'),
      ]
      const archive = createMockArchive(events)

      const result = simulateSessionCrystallize('session-3', archive, null)

      assert.equal(result.ok, true)
      assert.equal(result.crystal.session_id, 'session-3')
      assert.equal(result.crystal.event_count, 2)
      assert.equal(result.crystal.crystal_tier, 'heuristic')
      assert.ok(result.crystal.summary.includes('session-3'))
    })

    it('LLM crystal generation when extraction model is loaded', () => {
      const events = [
        createMockEvent('session-4', 'built authentication system', 'auth'),
      ]
      const archive = createMockArchive(events)
      const mockExtractModel = { name: 'Qwen3-4B' }

      const result = simulateSessionCrystallize('session-4', archive, mockExtractModel)

      assert.equal(result.ok, true)
      assert.equal(result.crystal.crystal_tier, 'llm')
      assert.ok(result.crystal.summary.length > 0)
      assert.ok(result.crystal.outcomes.length > 0)
    })

    it('crystal includes required fields', () => {
      const events = [createMockEvent('session-5', 'some work', 'work')]
      const archive = createMockArchive(events)

      const result = simulateSessionCrystallize('session-5', archive, null)

      assert.equal(result.ok, true)
      assert.ok('session_id' in result.crystal)
      assert.ok('event_count' in result.crystal)
      assert.ok('summary' in result.crystal)
      assert.ok('outcomes' in result.crystal)
      assert.ok('lessons' in result.crystal)
      assert.ok('crystal_tier' in result.crystal)
    })
  })
})

describe('single-model extraction fallback unit tests', () => {
  /**
   * Simulate the extraction routing logic from memory-bridge.py.
   * Returns which model source would be used for extraction.
   */
  function simulateExtractionRouting(extractModel, extractProcessor) {
    if (extractModel !== null && extractProcessor !== null) {
      return 'extraction_model'
    }
    return 'primary_model'
  }

  /**
   * Simulate the regex extraction pipeline.
   * Mirrors _regex_extract_triples() in memory-bridge.py.
   */
  function regexExtractTriples(text) {
    const triples = []
    const relationPattern = /\b(\w+)\s+(uses|is a|is an|has|works with|depends on|created by|located in|part of|related to|knows|owns|manages)\s+(\w+)/gi
    let match
    while ((match = relationPattern.exec(text)) !== null) {
      triples.push([match[1], match[2], match[3]])
    }
    return triples
  }

  describe('extraction routing', () => {
    it('routes to extraction_model when dedicated model is loaded', () => {
      const source = simulateExtractionRouting({ name: 'Qwen3-4B' }, { tokenize: () => {} })
      assert.equal(source, 'extraction_model',
        'Should use extraction_model when both model and processor are loaded')
    })

    it('routes to primary_model when no extraction model loaded', () => {
      const source = simulateExtractionRouting(null, null)
      assert.equal(source, 'primary_model',
        'Should fall back to primary_model when extraction model is not loaded')
    })

    it('routes to primary_model when model is loaded but processor is null', () => {
      const source = simulateExtractionRouting({ name: 'Qwen3-4B' }, null)
      assert.equal(source, 'primary_model',
        'Should fall back to primary_model when processor is null')
    })

    it('routes to primary_model when processor is loaded but model is null', () => {
      const source = simulateExtractionRouting(null, { tokenize: () => {} })
      assert.equal(source, 'primary_model',
        'Should fall back to primary_model when model is null')
    })
  })

  describe('regex extraction (fast path)', () => {
    it('extracts entity-relationship triples from text', () => {
      const text = 'Alice uses Python for data analysis'
      const triples = regexExtractTriples(text)
      assert.ok(triples.length >= 1, 'Should extract at least one triple')
      const found = triples.some(([s, p, o]) =>
        s.toLowerCase() === 'alice' &&
        p.toLowerCase() === 'uses' &&
        o.toLowerCase() === 'python'
      )
      assert.ok(found, 'Should extract (Alice, uses, Python) triple')
    })

    it('extracts multiple triples from text with multiple relations', () => {
      const text = 'Bob manages Redis and Alice knows Docker'
      const triples = regexExtractTriples(text)
      assert.ok(triples.length >= 2, 'Should extract at least 2 triples')
    })

    it('returns empty array for text with no extractable relations', () => {
      const text = 'Hello world, just some random words here'
      const triples = regexExtractTriples(text)
      assert.equal(triples.length, 0, 'Should return empty array for text without relations')
    })

    it('handles empty string gracefully', () => {
      const triples = regexExtractTriples('')
      assert.equal(triples.length, 0, 'Should return empty array for empty string')
    })
  })

  describe('sequential queuing to avoid inference contention', () => {
    it('extraction requests are processed sequentially (semaphore concurrency=1)', async () => {
      // Simulate sequential processing with a simple queue
      const queue = []
      let processing = false
      const results = []

      async function processExtraction(id) {
        return new Promise((resolve) => {
          queue.push({ id, resolve })
          if (!processing) processNext()
        })
      }

      function processNext() {
        if (queue.length === 0) { processing = false; return }
        processing = true
        const { id, resolve } = queue.shift()
        // Simulate async processing
        setTimeout(() => {
          results.push(id)
          resolve(id)
          processNext()
        }, 1)
      }

      // Queue 3 extractions
      await Promise.all([
        processExtraction(1),
        processExtraction(2),
        processExtraction(3),
      ])

      // All should be processed in order
      assert.deepStrictEqual(results, [1, 2, 3],
        'Extractions should be processed sequentially in order')
    })
  })
})
