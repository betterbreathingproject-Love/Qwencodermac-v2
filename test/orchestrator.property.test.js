'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { Orchestrator } = require('../orchestrator.js');
const {
  createTaskNode,
  createTaskGraph,
  getNextExecutableNodes,
  updateNodeStatus,
} = require('../task-graph.js');

// --- Generators ---

/**
 * Generate a valid DAG (directed acyclic graph) as a TaskGraph.
 * Nodes are numbered 1..N with dependencies only pointing to lower-numbered nodes.
 */
function arbitraryDAG() {
  return fc
    .integer({ min: 2, max: 10 })
    .chain((numNodes) => {
      // For each node (except the first), generate a subset of earlier nodes as dependencies
      const depGens = [];
      for (let i = 1; i < numNodes; i++) {
        // Each node can depend on any subset of nodes before it
        depGens.push(
          fc.subarray(
            Array.from({ length: i }, (_, k) => String(k + 1)),
            { minLength: 0, maxLength: Math.min(i, 3) }
          )
        );
      }
      return fc.tuple(
        fc.constant(numNodes),
        fc.tuple(...(depGens.length > 0 ? depGens : [fc.constant([])]))
      );
    })
    .map(([numNodes, depArrays]) => {
      const graph = createTaskGraph();
      const orderedIds = [];

      for (let i = 1; i <= numNodes; i++) {
        const id = String(i);
        const deps = i === 1 ? [] : (depArrays[i - 2] || []);
        const node = createTaskNode({
          id,
          title: `Task ${id}`,
          dependencies: deps,
        });
        graph.nodes.set(id, node);
        orderedIds.push(id);
      }

      graph.startNodeId = '1';
      graph._orderedIds = orderedIds;
      return graph;
    });
}

/**
 * Generate a sequence of status transitions for testing the state machine.
 */
function arbitraryStatusSequence() {
  return fc.array(
    fc.constantFrom('start', 'pause', 'resume', 'abort'),
    { minLength: 1, maxLength: 8 }
  );
}

/**
 * Mock AgentPool that always succeeds.
 */
function createSuccessPool() {
  return {
    async dispatch(task) {
      return { output: `done-${task.id}`, duration: 1, agentType: 'general' };
    },
  };
}

// --- Property Tests ---

describe('Property-based tests for orchestrator.js', () => {
  // 2.9.1 Property 4: dependency-respecting traversal order
  // **Validates: Requirements 2.1, 2.4, 2.5**
  it('Property 4: dependency-respecting traversal order', () => {
    fc.assert(
      fc.property(arbitraryDAG(), (graph) => {
        // Simulate execution by repeatedly calling getNextExecutableNodes
        // and verifying all returned nodes have completed dependencies
        let currentGraph = graph;
        const executionOrder = [];
        let iterations = 0;
        const maxIterations = graph.nodes.size * 2;

        while (iterations < maxIterations) {
          const nextNodes = getNextExecutableNodes(currentGraph);
          if (nextNodes.length === 0) break;

          for (const node of nextNodes) {
            // PROPERTY: every returned node must have all deps completed
            for (const depId of node.dependencies) {
              const dep = currentGraph.nodes.get(depId);
              assert.ok(dep, `Dependency ${depId} should exist`);
              assert.equal(
                dep.status,
                'completed',
                `Dependency ${depId} of node ${node.id} should be completed, got ${dep.status}`
              );
            }

            // PROPERTY: node itself must be not_started
            assert.equal(
              node.status,
              'not_started',
              `Node ${node.id} should be not_started, got ${node.status}`
            );

            executionOrder.push(node.id);
          }

          // Mark all next nodes as completed
          for (const node of nextNodes) {
            currentGraph = updateNodeStatus(currentGraph, node.id, 'completed');
          }

          iterations++;
        }

        // PROPERTY: all nodes should eventually be completed
        for (const [id, node] of currentGraph.nodes) {
          assert.equal(
            node.status,
            'completed',
            `Node ${id} should be completed after full traversal`
          );
        }

        // PROPERTY: execution order respects dependencies
        const orderIndex = new Map();
        executionOrder.forEach((id, idx) => orderIndex.set(id, idx));

        for (const [id, node] of graph.nodes) {
          for (const depId of node.dependencies) {
            assert.ok(
              orderIndex.get(depId) <= orderIndex.get(id),
              `Dependency ${depId} should execute before ${id}`
            );
          }
        }
      }),
      { numRuns: 150 }
    );
  });

  // 2.9.2 Property 5: status lifecycle state machine
  // **Validates: Requirements 2.2, 2.3, 2.6**
  it('Property 5: status lifecycle state machine', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryDAG(), async (graph) => {
        const statusTransitions = new Map(); // nodeId → [status1, status2, ...]

        const pool = createSuccessPool();
        const orch = new Orchestrator({
          taskGraph: graph,
          agentPool: pool,
        });

        orch.on('task-status-event', ({ nodeId, status }) => {
          if (!statusTransitions.has(nodeId)) {
            statusTransitions.set(nodeId, ['not_started']);
          }
          statusTransitions.get(nodeId).push(status);
        });

        await orch.start();

        // PROPERTY: every node that was executed should follow the lifecycle:
        // not_started → in_progress → completed
        for (const [nodeId, transitions] of statusTransitions) {
          // First status should be not_started (initial)
          assert.equal(
            transitions[0],
            'not_started',
            `Node ${nodeId} should start as not_started`
          );

          // Should transition to in_progress before completed
          const inProgressIdx = transitions.indexOf('in_progress');
          const completedIdx = transitions.indexOf('completed');

          if (completedIdx !== -1) {
            assert.ok(
              inProgressIdx !== -1,
              `Node ${nodeId} should go through in_progress before completed`
            );
            assert.ok(
              inProgressIdx < completedIdx,
              `Node ${nodeId}: in_progress (${inProgressIdx}) should come before completed (${completedIdx})`
            );
          }

          // PROPERTY: no direct not_started → completed transition
          for (let i = 1; i < transitions.length; i++) {
            if (transitions[i] === 'completed') {
              assert.notEqual(
                transitions[i - 1],
                'not_started',
                `Node ${nodeId} should not jump from not_started to completed`
              );
            }
          }
        }

        // PROPERTY: orchestrator should be in completed state
        assert.equal(orch.getStatus().state, 'completed');
      }),
      { numRuns: 150 }
    );
  });
});
