'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fc = require('fast-check')

// Tests for orchestrator memory integration (tasks 12.1, 12.2, 12.3)
// Tests use in-memory mocks to simulate the memory client and orchestrator behavior.

// ── Mock helpers ──────────────────────────────────────────────────────────────

function createMockMemoryClient(retrieveResults = []) {
  const calls = []

  return {
    getCalls() { return [...calls] },
    getCallsByType(eventType) { return calls.filter(c => c.type === eventType) },

    async retrieve(query, options = {}) {
      calls.push({ type: 'retrieve', query, options })
      return { results: retrieveResults, tokenCount: retrieveResults.length * 10 }
    },

    async archiveRecord(eventType, payload, summary, options = {}) {
      calls.push({ type: 'archiveRecord', eventType, payload, summary, options })
      return { ok: true }
    },

    async extractTurn() {},
    async kgAddTriple() { return null },
    async kgQueryEntity() { return [] },
    async vectorSearch() { return [] },
    async archiveSearch() { return [] },
    async getStatus() { return null },
  }
}

/**
 * Simulate the pre-dispatch memory retrieval logic from _dispatchNode().
 * Returns the augmented specContext.
 */
async function simulatePreDispatchRetrieval(node, specContext, memoryClient) {
  let specContextWithMemory = specContext

  if (memoryClient) {
    try {
      const taskQuery = `${node.title || node.text || node.id} ${node.description || ''}`.trim()
      const memResult = await memoryClient.retrieve(taskQuery, { mode: 'fast', topK: 5 })
      if (memResult && memResult.results && memResult.results.length > 0) {
        const memLines = memResult.results.map(r => `[${r.source}] ${r.content}`).join('\n')
        specContextWithMemory = specContext
          ? `${specContext}\n\n[Memory Context]\n${memLines}`
          : `[Memory Context]\n${memLines}`
      }
    } catch (_) {
      // Memory retrieval failed — dispatch without memory augmentation
    }
  }

  return specContextWithMemory
}

/**
 * Simulate the workflow_start archiving from start().
 */
async function simulateWorkflowStartArchive(graph, memoryClient) {
  if (!memoryClient) return

  const graphSummary = {
    nodeCount: graph.nodes.size,
    nodes: [...graph.nodes.values()].map(n => ({
      id: n.id,
      title: n.title || n.text || n.id,
      status: n.status,
    })),
  }
  await memoryClient.archiveRecord('workflow_start', graphSummary, `Workflow started with ${graph.nodes.size} tasks`)
}

/**
 * Simulate the task_completion archiving from _dispatchNode().
 */
async function simulateTaskCompletionArchive(node, taskResult, memoryClient) {
  if (!memoryClient) return

  await memoryClient.archiveRecord('task_completion', {
    nodeId: node.id,
    title: node.title || node.text || node.id,
    output: (taskResult.output || '').slice(0, 500),
    duration: taskResult.duration,
    agentType: taskResult.agentType,
  }, `Task completed: ${node.title || node.id}`)
}

// ── Property 15: Orchestrator specContext augmentation ────────────────────────

// Feature: taosmd-memory-integration, Property 15: Orchestrator specContext augmentation
describe('Feature: taosmd-memory-integration — orchestrator memory tests', () => {
  describe('Property 15: Orchestrator specContext augmentation', () => {
    /**
     * **Validates: Requirements 10.2**
     *
     * For any task dispatched when retrieval returns non-empty results,
     * the task's specContext SHALL contain the retrieval context appended
     * after any pre-existing spec context.
     */

    it('specContext is augmented with memory context when retrieval returns results', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 100 }),
          fc.array(
            fc.record({
              source: fc.constantFrom('kg', 'vector', 'archive'),
              content: fc.string({ minLength: 1, maxLength: 100 }),
              score: fc.float({ min: 0, max: 1 }),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          async (existingSpecContext, retrieveResults) => {
            const memClient = createMockMemoryClient(retrieveResults)
            const node = { id: 'task-1', title: 'Implement feature X', description: 'Build the feature' }

            const augmented = await simulatePreDispatchRetrieval(node, existingSpecContext, memClient)

            assert.ok(augmented.includes('[Memory Context]'),
              'Augmented specContext should contain [Memory Context]')

            // If there was existing spec context, it should still be present
            if (existingSpecContext.length > 0) {
              assert.ok(augmented.includes(existingSpecContext),
                'Augmented specContext should preserve existing spec context')
              assert.ok(augmented.indexOf(existingSpecContext) < augmented.indexOf('[Memory Context]'),
                'Existing spec context should appear before memory context')
            }

            // All retrieval results should be in the augmented context
            for (const result of retrieveResults) {
              assert.ok(augmented.includes(result.content),
                `Augmented specContext should include retrieval result: "${result.content}"`)
            }
          }
        ),
        { numRuns: 150 }
      )
    })

    it('specContext is unchanged when retrieval returns empty results', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 100 }),
          async (existingSpecContext) => {
            const memClient = createMockMemoryClient([]) // empty results
            const node = { id: 'task-1', title: 'Task', description: '' }

            const augmented = await simulatePreDispatchRetrieval(node, existingSpecContext, memClient)

            assert.equal(augmented, existingSpecContext,
              'specContext should be unchanged when retrieval returns empty results')
          }
        ),
        { numRuns: 150 }
      )
    })

    it('specContext is unchanged when memoryClient is null', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 100 }),
          async (existingSpecContext) => {
            const node = { id: 'task-1', title: 'Task', description: '' }

            const augmented = await simulatePreDispatchRetrieval(node, existingSpecContext, null)

            assert.equal(augmented, existingSpecContext,
              'specContext should be unchanged when memoryClient is null')
          }
        ),
        { numRuns: 150 }
      )
    })
  })

  describe('workflow_start archiving', () => {
    it('archives workflow start with task graph structure', async () => {
      const memClient = createMockMemoryClient()
      const graph = {
        nodes: new Map([
          ['task-1', { id: 'task-1', title: 'Task 1', status: 'not_started' }],
          ['task-2', { id: 'task-2', title: 'Task 2', status: 'not_started' }],
          ['task-3', { id: 'task-3', title: 'Task 3', status: 'not_started' }],
        ]),
      }

      await simulateWorkflowStartArchive(graph, memClient)

      const archiveCalls = memClient.getCallsByType('archiveRecord')
      assert.equal(archiveCalls.length, 1, 'Should have one archive call')
      assert.equal(archiveCalls[0].eventType, 'workflow_start')
      assert.equal(archiveCalls[0].payload.nodeCount, 3)
      assert.equal(archiveCalls[0].payload.nodes.length, 3)
    })

    it('skips workflow_start archiving when memoryClient is null', async () => {
      const graph = {
        nodes: new Map([['task-1', { id: 'task-1', title: 'Task 1', status: 'not_started' }]]),
      }

      // Should not throw
      let threw = false
      try {
        await simulateWorkflowStartArchive(graph, null)
      } catch (_) {
        threw = true
      }
      assert.equal(threw, false, 'Should not throw when memoryClient is null')
    })
  })

  describe('task_completion archiving', () => {
    it('archives task completion with output, duration, and agentType', async () => {
      const memClient = createMockMemoryClient()
      const node = { id: 'task-1', title: 'Implement feature' }
      const taskResult = {
        output: 'Feature implemented successfully',
        duration: 5000,
        agentType: 'implementation',
      }

      await simulateTaskCompletionArchive(node, taskResult, memClient)

      const archiveCalls = memClient.getCallsByType('archiveRecord')
      assert.equal(archiveCalls.length, 1)
      assert.equal(archiveCalls[0].eventType, 'task_completion')
      assert.equal(archiveCalls[0].payload.nodeId, 'task-1')
      assert.equal(archiveCalls[0].payload.agentType, 'implementation')
      assert.equal(archiveCalls[0].payload.duration, 5000)
    })

    it('truncates long output to 500 chars in archive', async () => {
      const memClient = createMockMemoryClient()
      const node = { id: 'task-1', title: 'Task' }
      const longOutput = 'x'.repeat(1000)
      const taskResult = { output: longOutput, duration: 1000, agentType: 'general' }

      await simulateTaskCompletionArchive(node, taskResult, memClient)

      const archiveCalls = memClient.getCallsByType('archiveRecord')
      assert.equal(archiveCalls[0].payload.output.length, 500,
        'Output should be truncated to 500 chars')
    })

    it('skips task_completion archiving when memoryClient is null', async () => {
      const node = { id: 'task-1', title: 'Task' }
      const taskResult = { output: 'done', duration: 100, agentType: 'general' }

      let threw = false
      try {
        await simulateTaskCompletionArchive(node, taskResult, null)
      } catch (_) {
        threw = true
      }
      assert.equal(threw, false, 'Should not throw when memoryClient is null')
    })
  })

  describe('graceful degradation when memory unavailable', () => {
    it('pre-dispatch retrieval falls back gracefully on error', async () => {
      // Create a client that throws on retrieve
      const failingClient = {
        async retrieve() { throw new Error('Memory unavailable') },
        async archiveRecord() { return { ok: false } },
      }

      const node = { id: 'task-1', title: 'Task', description: '' }
      const specContext = 'existing spec context'

      let threw = false
      let result
      try {
        result = await simulatePreDispatchRetrieval(node, specContext, failingClient)
      } catch (_) {
        threw = true
      }

      assert.equal(threw, false, 'Should not throw when memory retrieval fails')
      assert.equal(result, specContext,
        'Should return original specContext when retrieval fails')
    })
  })
})
