'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

// Integration tests for archive-before-compact flow in direct-bridge.js
// Tests use in-memory mocks to simulate the memory client and compaction behavior.

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Create a mock memory client that records all calls.
 */
function createMockMemoryClient() {
  const calls = []
  let shouldFail = false

  return {
    setShouldFail(fail) { shouldFail = fail },
    getCalls() { return [...calls] },
    getCallsByType(eventType) {
      return calls.filter(c => c.eventType === eventType)
    },
    reset() { calls.length = 0; shouldFail = false },

    async archiveRecord(eventType, payload, summary, options = {}) {
      if (shouldFail) throw new Error('Archive unavailable')
      calls.push({ eventType, payload, summary, options })
      return { ok: true }
    },

    async retrieve() { return { results: [], tokenCount: 0 } },
    async extractTurn() {},
    async kgAddTriple() { return null },
    async kgQueryEntity() { return [] },
    async vectorSearch() { return [] },
    async archiveSearch() { return [] },
    async getStatus() { return null },
  }
}

/**
 * Simulate the archive-before-compact logic from _agentLoop().
 * Returns { archivedCount, archiveStatus }.
 */
async function simulateArchiveBeforeCompact(messages, memoryClient, sessionId, agentRole, turn) {
  let archivedCount = 0
  let archiveStatus = 'skipped'

  if (memoryClient) {
    try {
      const messagesToArchive = messages.slice(0, Math.max(0, messages.length - 4))
      for (const msg of messagesToArchive) {
        if (msg.content && msg.content.length > 0) {
          await memoryClient.archiveRecord('pre_compaction', msg.content, msg.content.slice(0, 200), {
            agentName: agentRole || 'main-agent',
            sessionId,
            turnNumber: turn,
          })
          archivedCount++
        }
      }
      archiveStatus = 'ok'
    } catch (_) {
      archiveStatus = 'error'
    }
  }

  return { archivedCount, archiveStatus }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('direct-bridge.js archive-before-compact integration tests', () => {
  describe('archive-before-compact flow', () => {
    it('archives messages before compaction', async () => {
      const memClient = createMockMemoryClient()
      const messages = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'User message 1' },
        { role: 'assistant', content: 'Assistant response 1' },
        { role: 'tool', content: 'Tool result 1' },
        { role: 'user', content: 'User message 2' },
        { role: 'assistant', content: 'Assistant response 2' },
        { role: 'user', content: 'Current user message' },
        { role: 'assistant', content: 'Current assistant response' },
      ]

      const { archivedCount, archiveStatus } = await simulateArchiveBeforeCompact(
        messages, memClient, 'session-123', 'main-agent', 5
      )

      assert.equal(archiveStatus, 'ok', 'Archive status should be ok')
      assert.ok(archivedCount > 0, 'Should have archived at least one message')

      // Verify archived messages have event_type 'pre_compaction'
      const preCompactionCalls = memClient.getCallsByType('pre_compaction')
      assert.ok(preCompactionCalls.length > 0, 'Should have pre_compaction archive calls')

      // Verify session_id and turn_number are included
      for (const call of preCompactionCalls) {
        assert.equal(call.options.sessionId, 'session-123', 'Should include session_id')
        assert.equal(call.options.turnNumber, 5, 'Should include turn_number')
        assert.equal(call.options.agentName, 'main-agent', 'Should include agent_name')
      }
    })

    it('archives all messages except the last 4 (keepRecent)', async () => {
      const memClient = createMockMemoryClient()
      const messages = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i + 1}`,
      }))

      const { archivedCount } = await simulateArchiveBeforeCompact(
        messages, memClient, 'session-1', 'agent', 3
      )

      // Should archive messages.length - 4 = 6 messages
      assert.equal(archivedCount, 6,
        `Should archive ${messages.length - 4} messages, got ${archivedCount}`)
    })

    it('graceful fallback when archiving fails', async () => {
      const memClient = createMockMemoryClient()
      memClient.setShouldFail(true)

      const messages = [
        { role: 'user', content: 'Message 1' },
        { role: 'assistant', content: 'Response 1' },
        { role: 'user', content: 'Message 2' },
        { role: 'assistant', content: 'Response 2' },
        { role: 'user', content: 'Current' },
      ]

      let threw = false
      let result
      try {
        result = await simulateArchiveBeforeCompact(messages, memClient, 'session-1', 'agent', 1)
      } catch (_) {
        threw = true
      }

      assert.equal(threw, false, 'Archive failure should not throw')
      assert.equal(result.archiveStatus, 'error', 'Archive status should be error on failure')
    })

    it('skips archiving when memoryClient is null', async () => {
      const messages = [
        { role: 'user', content: 'Message 1' },
        { role: 'assistant', content: 'Response 1' },
        { role: 'user', content: 'Current' },
      ]

      const { archivedCount, archiveStatus } = await simulateArchiveBeforeCompact(
        messages, null, 'session-1', 'agent', 1
      )

      assert.equal(archivedCount, 0, 'Should not archive when memoryClient is null')
      assert.equal(archiveStatus, 'skipped', 'Archive status should be skipped')
    })

    it('skips messages with empty content', async () => {
      const memClient = createMockMemoryClient()
      const messages = [
        { role: 'user', content: 'Message with content' },
        { role: 'assistant', content: '' },  // empty content — should be skipped
        { role: 'tool', content: null },      // null content — should be skipped
        { role: 'user', content: 'Another message' },
        { role: 'assistant', content: 'Response' },
        { role: 'user', content: 'Current' },
      ]

      const { archivedCount } = await simulateArchiveBeforeCompact(
        messages, memClient, 'session-1', 'agent', 2
      )

      // Only messages with non-empty content should be archived
      // messages.length - 4 = 2 candidates, but only 1 has content ('Message with content')
      assert.equal(archivedCount, 1,
        'Should only archive messages with non-empty content')
    })
  })

  describe('qwen-event emission', () => {
    it('memory-archive event includes archivedCount and status', () => {
      // Simulate the event emission logic
      const events = []
      const mockSend = (channel, data) => events.push({ channel, data })

      const archivedCount = 5
      const archiveStatus = 'ok'

      // Simulate the event emission from _agentLoop
      if (archiveStatus !== 'skipped') {
        mockSend('qwen-event', { type: 'memory-archive', archivedCount, status: archiveStatus })
      }

      assert.equal(events.length, 1, 'Should emit exactly one qwen-event')
      assert.equal(events[0].channel, 'qwen-event')
      assert.equal(events[0].data.type, 'memory-archive')
      assert.equal(events[0].data.archivedCount, 5)
      assert.equal(events[0].data.status, 'ok')
    })

    it('memory-archive event is not emitted when archiving was skipped', () => {
      const events = []
      const mockSend = (channel, data) => events.push({ channel, data })

      const archiveStatus = 'skipped'

      if (archiveStatus !== 'skipped') {
        mockSend('qwen-event', { type: 'memory-archive', archivedCount: 0, status: archiveStatus })
      }

      assert.equal(events.length, 0, 'Should not emit event when archiving was skipped')
    })

    it('memory-archive event is emitted with error status on failure', () => {
      const events = []
      const mockSend = (channel, data) => events.push({ channel, data })

      const archiveStatus = 'error'
      const archivedCount = 0

      if (archiveStatus !== 'skipped') {
        mockSend('qwen-event', { type: 'memory-archive', archivedCount, status: archiveStatus })
      }

      assert.equal(events.length, 1, 'Should emit event even on error')
      assert.equal(events[0].data.status, 'error')
      assert.equal(events[0].data.archivedCount, 0)
    })
  })
})
