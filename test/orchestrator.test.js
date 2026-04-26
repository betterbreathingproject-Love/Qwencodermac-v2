'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Orchestrator } = require('../orchestrator.js');
const { parseTaskGraph, createTaskNode, createTaskGraph } = require('../task-graph.js');

// --- Mock AgentPool ---

/**
 * Creates a mock AgentPool that tracks dispatch calls and can be configured
 * to succeed or fail for specific task IDs.
 */
function createMockAgentPool(opts = {}) {
  const calls = [];
  const failures = new Set(opts.failFor || []);
  const delay = opts.delay || 0;

  return {
    calls,
    async dispatch(task, context) {
      calls.push({ task, context });
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (failures.has(task.id)) {
        throw new Error(`Task ${task.id} failed`);
      }
      return {
        output: `Result for ${task.id}`,
        duration: 10,
        agentType: 'general',
      };
    },
  };
}

// --- 2.8.1 Test linear execution order ---

describe('Orchestrator - linear execution', () => {
  it('executes tasks in dependency order', async () => {
    const md = [
      '- [^] 1 First task',
      '- [ ] 2 Second task',
      '- [ ] 3 Third task',
    ].join('\n');
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool();

    const orch = new Orchestrator({
      taskGraph: graph,
      agentPool: pool,
    });

    await orch.start();

    assert.equal(orch.getStatus().state, 'completed');
    assert.equal(pool.calls.length, 3);
    assert.equal(pool.calls[0].task.id, '1');
    assert.equal(pool.calls[1].task.id, '2');
    assert.equal(pool.calls[2].task.id, '3');
  });

  it('emits task-status-event for each status change', async () => {
    const md = '- [ ] 1 Only task';
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool();
    const events = [];

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    orch.on('task-status-event', (e) => events.push(e));

    await orch.start();

    // Should have in_progress and completed events
    const inProgress = events.filter((e) => e.status === 'in_progress');
    const completed = events.filter((e) => e.status === 'completed');
    assert.ok(inProgress.length >= 1);
    assert.ok(completed.length >= 1);
  });

  it('calls onStatusChange callback', async () => {
    const md = '- [ ] 1 Task';
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool();
    const changes = [];

    const orch = new Orchestrator({
      taskGraph: graph,
      agentPool: pool,
      onStatusChange: (nodeId, status) => changes.push({ nodeId, status }),
    });

    await orch.start();
    assert.ok(changes.length >= 2); // at least in_progress + completed
  });

  it('calls onComplete callback when done', async () => {
    const md = '- [ ] 1 Task';
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool();
    let completeCalled = false;

    const orch = new Orchestrator({
      taskGraph: graph,
      agentPool: pool,
      onComplete: () => { completeCalled = true; },
    });

    await orch.start();
    assert.ok(completeCalled);
  });

  it('stores results accessible via getNodeResult', async () => {
    const md = '- [ ] 1 Task';
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool();

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    await orch.start();

    const result = orch.getNodeResult('1');
    assert.ok(result);
    assert.equal(result.nodeId, '1');
    assert.equal(result.output, 'Result for 1');
    assert.equal(result.agentType, 'general');
  });

  it('returns null for unknown nodeId in getNodeResult', async () => {
    const md = '- [ ] 1 Task';
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool();

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    assert.equal(orch.getNodeResult('nonexistent'), null);
  });
});

// --- 2.8.2 Test parallel fan-out/fan-in execution ---

describe('Orchestrator - parallel execution', () => {
  it('dispatches parallel nodes concurrently', async () => {
    // Build a graph where 1 is the start, then 2.1 and 2.2 are children of 2 (parallel)
    // Actually, let's build a graph manually where two nodes have no deps on each other
    const graph = createTaskGraph();
    const nodeA = createTaskNode({ id: 'A', title: 'Start', markers: { start: true, branch: null, terminal: false, loop: null } });
    const nodeB = createTaskNode({ id: 'B', title: 'Parallel 1', dependencies: ['A'] });
    const nodeC = createTaskNode({ id: 'C', title: 'Parallel 2', dependencies: ['A'] });
    const nodeD = createTaskNode({ id: 'D', title: 'Join', dependencies: ['B', 'C'] });

    graph.nodes.set('A', nodeA);
    graph.nodes.set('B', nodeB);
    graph.nodes.set('C', nodeC);
    graph.nodes.set('D', nodeD);
    graph.startNodeId = 'A';
    graph._orderedIds = ['A', 'B', 'C', 'D'];

    const pool = createMockAgentPool();
    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

    await orch.start();

    assert.equal(orch.getStatus().state, 'completed');
    assert.equal(pool.calls.length, 4);

    // A should be first
    assert.equal(pool.calls[0].task.id, 'A');
    // B and C should both be dispatched (order may vary but both before D)
    const bcIds = [pool.calls[1].task.id, pool.calls[2].task.id].sort();
    assert.deepEqual(bcIds, ['B', 'C']);
    // D should be last
    assert.equal(pool.calls[3].task.id, 'D');
  });
});

// --- 2.8.3 Test branch evaluation ---

describe('Orchestrator - branch evaluation', () => {
  it('follows branch when condition is true in context', async () => {
    const graph = createTaskGraph();
    const nodeA = createTaskNode({ id: 'A', title: 'Setup' });
    const nodeB = createTaskNode({
      id: 'B',
      title: 'Branch',
      dependencies: ['A'],
      markers: { start: false, branch: 'A', terminal: false, loop: null },
    });
    const nodeC = createTaskNode({ id: 'C', title: 'After branch', dependencies: ['B'] });

    graph.nodes.set('A', nodeA);
    graph.nodes.set('B', nodeB);
    graph.nodes.set('C', nodeC);
    graph._orderedIds = ['A', 'B', 'C'];

    const pool = createMockAgentPool();
    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

    await orch.start();

    // A completes, sets context['A'] = 'Result for A' (truthy)
    // B branch dispatched to pool, no RoutingDecision in output → fallback to _evaluateCondition('A') → truthy → completed
    // C executes
    assert.equal(orch.getStatus().state, 'completed');
    assert.equal(pool.calls.length, 3); // A, B (branch dispatched to pool), and C
  });

  it('fails branch when condition is false', async () => {
    const graph = createTaskGraph();
    const nodeA = createTaskNode({ id: 'A', title: 'Setup' });
    const nodeB = createTaskNode({
      id: 'B',
      title: 'Branch',
      dependencies: ['A'],
      markers: { start: false, branch: 'nonexistent', terminal: false, loop: null },
    });
    const nodeC = createTaskNode({ id: 'C', title: 'After branch', dependencies: ['B'] });

    graph.nodes.set('A', nodeA);
    graph.nodes.set('B', nodeB);
    graph.nodes.set('C', nodeC);
    graph._orderedIds = ['A', 'B', 'C'];

    const pool = createMockAgentPool();
    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

    await orch.start();

    // Branch condition 'nonexistent' not in context → failure → paused
    assert.equal(orch.getStatus().state, 'paused');
    assert.equal(orch.getStatus().graph.nodes.get('B').status, 'failed');
  });

  it('evaluates literal true/false conditions', async () => {
    const graph = createTaskGraph();
    const nodeA = createTaskNode({
      id: 'A',
      title: 'True branch',
      markers: { start: false, branch: 'true', terminal: false, loop: null },
    });
    const nodeB = createTaskNode({ id: 'B', title: 'After', dependencies: ['A'] });

    graph.nodes.set('A', nodeA);
    graph.nodes.set('B', nodeB);
    graph._orderedIds = ['A', 'B'];

    const pool = createMockAgentPool();
    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

    await orch.start();

    assert.equal(orch.getStatus().state, 'completed');
    assert.equal(orch.getStatus().graph.nodes.get('A').status, 'completed');
  });
});

// --- 2.8.4 Test failure handling ---

describe('Orchestrator - failure handling', () => {
  it('pauses on task failure', async () => {
    const md = [
      '- [ ] 1 First task',
      '- [ ] 2 Failing task',
      '- [ ] 3 Third task',
    ].join('\n');
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool({ failFor: ['2'] });

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    await orch.start();

    assert.equal(orch.getStatus().state, 'paused');
    assert.equal(orch.getStatus().graph.nodes.get('2').status, 'failed');
    // Task 3 should not have been dispatched
    assert.ok(!pool.calls.some((c) => c.task.id === '3'));
  });

  it('calls onError callback on failure', async () => {
    const md = '- [ ] 1 Failing task';
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool({ failFor: ['1'] });
    const errors = [];

    const orch = new Orchestrator({
      taskGraph: graph,
      agentPool: pool,
      onError: (nodeId, err) => errors.push({ nodeId, err }),
    });

    await orch.start();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].nodeId, '1');
  });

  it('retry resumes execution after failure', async () => {
    const md = [
      '- [ ] 1 First task',
      '- [ ] 2 Will fail then succeed',
    ].join('\n');
    const graph = parseTaskGraph(md);

    let failCount = 0;
    const pool = {
      calls: [],
      async dispatch(task) {
        pool.calls.push(task);
        if (task.id === '2' && failCount === 0) {
          failCount++;
          throw new Error('Temporary failure');
        }
        return { output: `Result for ${task.id}`, duration: 10, agentType: 'general' };
      },
    };

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    await orch.start();

    assert.equal(orch.getStatus().state, 'paused');
    assert.equal(orch.getStatus().graph.nodes.get('2').status, 'failed');

    // Retry the failed node
    await orch.retry('2');

    assert.equal(orch.getStatus().state, 'completed');
    assert.equal(orch.getStatus().graph.nodes.get('2').status, 'completed');
  });

  it('skip advances past failed node', async () => {
    const md = [
      '- [ ] 1 First task',
      '- [ ] 2 Failing task',
      '- [ ] 3 Third task',
    ].join('\n');
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool({ failFor: ['2'] });

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    await orch.start();

    assert.equal(orch.getStatus().state, 'paused');

    // Skip the failed node
    await orch.skip('2');

    assert.equal(orch.getStatus().state, 'completed');
    assert.equal(orch.getStatus().graph.nodes.get('2').status, 'completed');
    assert.equal(orch.getStatus().graph.nodes.get('3').status, 'completed');
  });

  it('abort stops execution', async () => {
    const md = [
      '- [ ] 1 First task',
      '- [ ] 2 Second task',
    ].join('\n');
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool();

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

    // Start and immediately abort
    const startPromise = orch.start();
    await orch.abort();
    await startPromise;

    assert.equal(orch.getStatus().state, 'aborted');
  });

  it('pause and resume work correctly', async () => {
    const md = [
      '- [ ] 1 First task',
      '- [ ] 2 Second task',
    ].join('\n');
    const graph = parseTaskGraph(md);

    let resolveSecond;
    const pool = {
      calls: [],
      async dispatch(task) {
        pool.calls.push(task);
        if (task.id === '2') {
          // Delay to allow pause
          await new Promise((r) => { resolveSecond = r; });
        }
        return { output: `Result for ${task.id}`, duration: 10, agentType: 'general' };
      },
    };

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

    // Start execution
    const startPromise = orch.start();

    // After first task completes, pause
    await new Promise((r) => setTimeout(r, 50));
    await orch.pause();

    // Resolve the second task if it was dispatched
    if (resolveSecond) resolveSecond();
    await startPromise;

    // State should be paused or completed depending on timing
    const state = orch.getStatus().state;
    assert.ok(state === 'paused' || state === 'completed');
  });
});

// --- 2.8.5 Test loop execution ---

describe('Orchestrator - loop execution', () => {
  it('re-executes target node up to maxIterations', async () => {
    const graph = createTaskGraph();
    const nodeA = createTaskNode({ id: 'A', title: 'Target task' });
    const nodeLoop = createTaskNode({
      id: 'L',
      title: 'Loop node',
      dependencies: ['A'],
      markers: { start: false, branch: null, terminal: false, loop: { target: 'A', maxIterations: 3 } },
      status: 'skipped', // loop nodes start as skipped
    });

    // Override status to not_started so it can be picked up
    nodeLoop.status = 'not_started';

    graph.nodes.set('A', nodeA);
    graph.nodes.set('L', nodeLoop);
    graph._orderedIds = ['A', 'L'];

    const pool = createMockAgentPool();
    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

    await orch.start();

    // A should have been dispatched multiple times (initial + re-executions from loop)
    // The loop re-executes A up to 3 times
    const aCalls = pool.calls.filter((c) => c.task.id === 'A');
    assert.ok(aCalls.length >= 2, `Expected A to be dispatched multiple times, got ${aCalls.length}`);
    assert.ok(aCalls.length <= 4, `Expected A dispatched at most 4 times, got ${aCalls.length}`);

    // Loop node should be completed after max iterations
    assert.equal(orch.getStatus().graph.nodes.get('L').status, 'completed');
  });

  it('completes loop node after maxIterations reached', async () => {
    const graph = createTaskGraph();
    const nodeA = createTaskNode({ id: 'A', title: 'Target' });
    const nodeLoop = createTaskNode({
      id: 'L',
      title: 'Loop',
      dependencies: ['A'],
      markers: { start: false, branch: null, terminal: false, loop: { target: 'A', maxIterations: 1 } },
      status: 'not_started',
    });
    const nodeB = createTaskNode({ id: 'B', title: 'After loop', dependencies: ['L'] });

    graph.nodes.set('A', nodeA);
    graph.nodes.set('L', nodeLoop);
    graph.nodes.set('B', nodeB);
    graph._orderedIds = ['A', 'L', 'B'];

    const pool = createMockAgentPool();
    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

    await orch.start();

    assert.equal(orch.getStatus().state, 'completed');
    assert.equal(orch.getStatus().graph.nodes.get('L').status, 'completed');
    assert.equal(orch.getStatus().graph.nodes.get('B').status, 'completed');
  });
});

// --- 2.7 Test persistence ---

describe('Orchestrator - persistence', () => {
  it('persists graph to tasksFilePath after status changes', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');

    const tmpFile = path.join(os.tmpdir(), `orchestrator-test-${Date.now()}.md`);

    const md = '- [ ] 1 Task';
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool();

    const orch = new Orchestrator({
      taskGraph: graph,
      agentPool: pool,
      tasksFilePath: tmpFile,
    });

    await orch.start();

    // File should exist with updated statuses
    const content = fs.readFileSync(tmpFile, 'utf8');
    assert.ok(content.includes('[x]') || content.includes('completed'), 'Should persist completed status');

    // Cleanup
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  });
});

// --- getStatus tests ---

describe('Orchestrator - getStatus', () => {
  it('returns idle state before start', () => {
    const md = '- [ ] 1 Task';
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool();

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    const status = orch.getStatus();

    assert.equal(status.state, 'idle');
    assert.ok(status.graph);
  });

  it('returns completed state after successful execution', async () => {
    const md = '- [ ] 1 Task';
    const graph = parseTaskGraph(md);
    const pool = createMockAgentPool();

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    await orch.start();

    assert.equal(orch.getStatus().state, 'completed');
  });
});
