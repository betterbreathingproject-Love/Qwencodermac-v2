'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseRoutingDecision, validateRoutingDecision } = require('../orchestrator.js');

// --- parseRoutingDecision unit tests ---

describe('parseRoutingDecision', () => {
  // **Validates: Requirements 1.1, 1.5, 4.1**
  it('parses clean JSON with a string route', () => {
    const result = parseRoutingDecision('{"route": "task-1"}');
    assert.deepStrictEqual(result, { route: 'task-1' });
  });

  // **Validates: Requirements 1.1, 1.2, 4.1**
  it('parses JSON embedded in a markdown code block', () => {
    const input = '```json\n{"route": "task-2"}\n```';
    const result = parseRoutingDecision(input);
    assert.deepStrictEqual(result, { route: 'task-2' });
  });

  // **Validates: Requirements 1.1, 1.2, 4.1**
  it('parses JSON embedded in prose text', () => {
    const input = 'Based on analysis, {"route": "task-3"} is the best path';
    const result = parseRoutingDecision(input);
    assert.deepStrictEqual(result, { route: 'task-3' });
  });

  // **Validates: Requirements 1.1, 1.5**
  it('parses JSON with a reason field and preserves it', () => {
    const input = '{"route": "task-1", "reason": "condition met"}';
    const result = parseRoutingDecision(input);
    assert.deepStrictEqual(result, { route: 'task-1', reason: 'condition met' });
  });

  // **Validates: Requirements 1.2, 1.5**
  it('parses JSON with an array route', () => {
    const input = '{"route": ["task-1", "task-2"]}';
    const result = parseRoutingDecision(input);
    assert.deepStrictEqual(result, { route: ['task-1', 'task-2'] });
  });

  // **Validates: Requirements 1.4, 4.5**
  it('returns null for empty string', () => {
    assert.equal(parseRoutingDecision(''), null);
  });

  // **Validates: Requirements 1.4, 4.5**
  it('returns null for string with no JSON', () => {
    assert.equal(parseRoutingDecision('just some plain text with no json'), null);
  });

  // **Validates: Requirements 1.4, 4.5**
  it('returns null for JSON without route key', () => {
    assert.equal(parseRoutingDecision('{"name": "test", "value": 42}'), null);
  });

  // **Validates: Requirements 1.4, 4.5**
  it('returns null for malformed JSON', () => {
    assert.equal(parseRoutingDecision('{"route": "task-1"'), null);
  });

  // **Validates: Requirements 1.4, 4.5**
  it('returns null for empty route string', () => {
    assert.equal(parseRoutingDecision('{"route": ""}'), null);
  });

  // **Validates: Requirements 1.4, 4.5**
  it('returns null for empty route array', () => {
    assert.equal(parseRoutingDecision('{"route": []}'), null);
  });
});

// --- validateRoutingDecision unit tests ---

describe('validateRoutingDecision', () => {
  /**
   * Helper: build a mock graph with a `nodes` Map from an array of task IDs.
   */
  function buildGraph(taskIds) {
    const nodes = new Map();
    for (const id of taskIds) {
      nodes.set(id, { id, status: 'not_started' });
    }
    return { nodes };
  }

  // **Validates: Requirements 4.2, 4.3**
  it('returns valid for a single route with an existing ID', () => {
    const graph = buildGraph(['task-1', 'task-2', 'task-3']);
    const result = validateRoutingDecision({ route: 'task-1' }, graph);
    assert.equal(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  // **Validates: Requirements 4.2, 4.3**
  it('returns valid for an array route with all existing IDs', () => {
    const graph = buildGraph(['task-1', 'task-2', 'task-3']);
    const result = validateRoutingDecision({ route: ['task-1', 'task-3'] }, graph);
    assert.equal(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  // **Validates: Requirements 4.2, 4.3**
  it('returns invalid for a non-existent single ID and errors mention the ID', () => {
    const graph = buildGraph(['task-1', 'task-2']);
    const result = validateRoutingDecision({ route: 'task-99' }, graph);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some(e => e.includes('task-99')));
  });

  // **Validates: Requirements 4.2, 4.3, 4.4**
  it('returns invalid for an array with some non-existent IDs and errors mention each missing ID', () => {
    const graph = buildGraph(['task-1']);
    const result = validateRoutingDecision({ route: ['task-1', 'task-x', 'task-y'] }, graph);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('task-x')));
    assert.ok(result.errors.some(e => e.includes('task-y')));
  });

  // **Validates: Requirements 4.4**
  it('returns invalid for empty string route', () => {
    const graph = buildGraph(['task-1']);
    const result = validateRoutingDecision({ route: '' }, graph);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  // **Validates: Requirements 4.4**
  it('returns invalid for empty array route', () => {
    const graph = buildGraph(['task-1']);
    const result = validateRoutingDecision({ route: [] }, graph);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  // **Validates: Requirements 4.2**
  it('returns invalid for null decision', () => {
    const graph = buildGraph(['task-1']);
    const result = validateRoutingDecision(null, graph);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  // **Validates: Requirements 4.2**
  it('returns invalid for undefined decision', () => {
    const graph = buildGraph(['task-1']);
    const result = validateRoutingDecision(undefined, graph);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });
});

// --- Branch handling refactor unit tests ---
// Tests the full _handleBranch flow: dispatch to pool → parse routing decision → apply or fallback

const { Orchestrator } = require('../orchestrator.js');
const { createTaskNode, createTaskGraph } = require('../task-graph.js');

/**
 * Creates a mock AgentPool that returns a configurable output string.
 * @param {object} opts
 * @param {string|function} opts.output - Static output string or function(task) => string
 * @param {Set|string[]} [opts.failFor] - Task IDs that should throw on dispatch
 * @returns {object} mock pool with calls array and dispatch method
 */
function createBranchMockPool(opts = {}) {
  const calls = [];
  const failures = new Set(opts.failFor || []);

  return {
    calls,
    async dispatch(task, context) {
      calls.push({ task, context });
      if (failures.has(task.id)) {
        throw new Error(`Dispatch failed for ${task.id}`);
      }
      const output = typeof opts.output === 'function'
        ? opts.output(task)
        : (opts.output ?? `Result for ${task.id}`);
      return { output, duration: 10, agentType: 'general' };
    },
  };
}

/**
 * Build a graph with a branch node that has routable siblings.
 * Structure: A (start) → B (branch:condition) → [C, D, E] siblings → F (after)
 * B is a branch node; C, D, E are routable siblings at the same depth.
 */
function buildBranchGraph() {
  const graph = createTaskGraph();

  const nodeA = createTaskNode({
    id: 'A', title: 'Start', markers: { start: true, branch: null, terminal: false, loop: null },
  });
  const nodeB = createTaskNode({
    id: 'B', title: 'Branch', dependencies: ['A'],
    markers: { start: false, branch: 'A', terminal: false, loop: null },
  });
  const nodeC = createTaskNode({
    id: 'C', title: 'Option C', dependencies: ['B'],
  });
  const nodeD = createTaskNode({
    id: 'D', title: 'Option D', dependencies: ['B'],
  });
  const nodeE = createTaskNode({
    id: 'E', title: 'Option E', dependencies: ['B'],
  });

  graph.nodes.set('A', nodeA);
  graph.nodes.set('B', nodeB);
  graph.nodes.set('C', nodeC);
  graph.nodes.set('D', nodeD);
  graph.nodes.set('E', nodeE);
  graph.startNodeId = 'A';
  graph._orderedIds = ['A', 'B', 'C', 'D', 'E'];

  return graph;
}

describe('Orchestrator - branch handling refactor', () => {
  // **Validates: Requirements 2.1, 2.5, 2.6**
  it('single route dispatch: activates target, skips non-selected siblings, completes branch', async () => {
    const graph = buildBranchGraph();
    const pool = createBranchMockPool({
      output: (task) => {
        if (task.id === 'B') return '{"route": "C"}';
        return `Result for ${task.id}`;
      },
    });

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    await orch.start();

    const status = orch.getStatus();
    // Branch B should be completed
    assert.equal(status.graph.nodes.get('B').status, 'completed');
    // Target C should be completed (was activated and dispatched)
    assert.equal(status.graph.nodes.get('C').status, 'completed');
    // Non-selected siblings D and E should be skipped
    assert.equal(status.graph.nodes.get('D').status, 'skipped');
    assert.equal(status.graph.nodes.get('E').status, 'skipped');
    // Overall should complete
    assert.equal(status.state, 'completed');
  });

  // **Validates: Requirements 2.2, 2.5**
  it('fan-out dispatch: activates all targets in array route', async () => {
    const graph = buildBranchGraph();
    const pool = createBranchMockPool({
      output: (task) => {
        if (task.id === 'B') return '{"route": ["C", "D"]}';
        return `Result for ${task.id}`;
      },
    });

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    await orch.start();

    const status = orch.getStatus();
    // Branch B completed
    assert.equal(status.graph.nodes.get('B').status, 'completed');
    // Both C and D activated and completed
    assert.equal(status.graph.nodes.get('C').status, 'completed');
    assert.equal(status.graph.nodes.get('D').status, 'completed');
    // E not selected → skipped
    assert.equal(status.graph.nodes.get('E').status, 'skipped');
  });

  // **Validates: Requirements 2.4**
  it('retry pattern: routes to a completed task, resets it to not_started and re-executes', async () => {
    // Build a simpler graph: A → B (branch) with C as sibling
    // C will be completed before B routes back to it
    const graph = createTaskGraph();

    const nodeA = createTaskNode({
      id: 'A', title: 'Start',
      markers: { start: true, branch: null, terminal: false, loop: null },
    });
    const nodeC = createTaskNode({
      id: 'C', title: 'Target', dependencies: ['A'],
    });
    const nodeB = createTaskNode({
      id: 'B', title: 'Branch', dependencies: ['C'],
      markers: { start: false, branch: 'A', terminal: false, loop: null },
    });

    graph.nodes.set('A', nodeA);
    graph.nodes.set('C', nodeC);
    graph.nodes.set('B', nodeB);
    graph.startNodeId = 'A';
    graph._orderedIds = ['A', 'C', 'B'];

    let cDispatchCount = 0;
    const pool = createBranchMockPool({
      output: (task) => {
        if (task.id === 'C') {
          cDispatchCount++;
          return `Result for C (run ${cDispatchCount})`;
        }
        // B routes back to C (retry)
        if (task.id === 'B') return '{"route": "C"}';
        return `Result for ${task.id}`;
      },
    });

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    await orch.start();

    // C should have been dispatched at least twice (initial + retry)
    assert.ok(cDispatchCount >= 2, `Expected C dispatched at least 2 times, got ${cDispatchCount}`);
    // Branch should be completed
    assert.equal(orch.getStatus().graph.nodes.get('B').status, 'completed');
  });

  // **Validates: Requirements 1.3**
  it('reason stored: routing decision reason is stored in context', async () => {
    const graph = buildBranchGraph();
    const pool = createBranchMockPool({
      output: (task) => {
        if (task.id === 'B') return '{"route": "C", "reason": "C is the best option"}';
        return `Result for ${task.id}`;
      },
    });

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    await orch.start();

    // The reason should be stored in context under B_reason
    assert.equal(orch._context['B_reason'], 'C is the best option');
    assert.equal(orch.getStatus().graph.nodes.get('B').status, 'completed');
  });

  // **Validates: Requirements 1.4, 2.6**
  it('fallback to condition evaluation: no RoutingDecision in output falls back to _evaluateCondition', async () => {
    const graph = createTaskGraph();

    const nodeA = createTaskNode({
      id: 'A', title: 'Setup',
      markers: { start: true, branch: null, terminal: false, loop: null },
    });
    const nodeB = createTaskNode({
      id: 'B', title: 'Branch', dependencies: ['A'],
      markers: { start: false, branch: 'A', terminal: false, loop: null },
    });
    const nodeC = createTaskNode({
      id: 'C', title: 'After branch', dependencies: ['B'],
    });

    graph.nodes.set('A', nodeA);
    graph.nodes.set('B', nodeB);
    graph.nodes.set('C', nodeC);
    graph.startNodeId = 'A';
    graph._orderedIds = ['A', 'B', 'C'];

    // Pool returns plain text (no RoutingDecision JSON)
    const pool = createBranchMockPool({
      output: (task) => `Plain result for ${task.id}`,
    });

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    await orch.start();

    // A completes → context['A'] = 'Plain result for A' (truthy)
    // B branch dispatched, no RoutingDecision → fallback to _evaluateCondition('A') → truthy → completed
    // C executes
    assert.equal(orch.getStatus().graph.nodes.get('B').status, 'completed');
    assert.equal(orch.getStatus().graph.nodes.get('C').status, 'completed');
    assert.equal(orch.getStatus().state, 'completed');
  });

  // **Validates: Requirements 2.3 (error case)**
  it('branch failure: pool dispatch throws error, branch marked failed, orchestrator paused', async () => {
    const graph = createTaskGraph();

    const nodeA = createTaskNode({
      id: 'A', title: 'Setup',
      markers: { start: true, branch: null, terminal: false, loop: null },
    });
    const nodeB = createTaskNode({
      id: 'B', title: 'Branch', dependencies: ['A'],
      markers: { start: false, branch: 'A', terminal: false, loop: null },
    });
    const nodeC = createTaskNode({
      id: 'C', title: 'After branch', dependencies: ['B'],
    });

    graph.nodes.set('A', nodeA);
    graph.nodes.set('B', nodeB);
    graph.nodes.set('C', nodeC);
    graph.startNodeId = 'A';
    graph._orderedIds = ['A', 'B', 'C'];

    const errors = [];
    // Pool fails when dispatching B
    const pool = createBranchMockPool({
      output: (task) => `Result for ${task.id}`,
      failFor: ['B'],
    });

    const orch = new Orchestrator({
      taskGraph: graph,
      agentPool: pool,
      onError: (nodeId, err) => errors.push({ nodeId, err }),
    });
    await orch.start();

    // Branch B should be failed
    assert.equal(orch.getStatus().graph.nodes.get('B').status, 'failed');
    // Orchestrator should be paused
    assert.equal(orch.getStatus().state, 'paused');
    // C should NOT have been dispatched
    assert.ok(!pool.calls.some((c) => c.task.id === 'C'));
    // onError callback should have been called for B
    assert.equal(errors.length, 1);
    assert.equal(errors[0].nodeId, 'B');
  });
});

// --- Branch point prompt augmentation unit tests ---
// Tests the `buildRoutingInstructions` function from main.js

describe('buildRoutingInstructions - branch point prompt augmentation', () => {
  // main.js requires Electron at top level, so we inject a mock into the
  // require cache before loading it.
  const path = require('node:path');

  let buildRoutingInstructions;

  const electronMock = {
    app: { whenReady: () => ({ then: () => {} }), on: () => {}, quit: () => {} },
    BrowserWindow: class {},
    ipcMain: { handle: () => {}, on: () => {} },
    nativeTheme: { themeSource: 'dark' },
  };

  const mainPath = path.resolve(__dirname, '..', 'main.js');

  const cachedElectron = require.cache[require.resolve('electron')] ?? null;
  const cachedMain = require.cache[mainPath] ?? null;

  require.cache[require.resolve('electron')] = {
    id: require.resolve('electron'),
    filename: require.resolve('electron'),
    loaded: true,
    exports: electronMock,
  };
  delete require.cache[mainPath];

  try {
    buildRoutingInstructions = require(mainPath).buildRoutingInstructions;
  } finally {
    if (cachedElectron) {
      require.cache[require.resolve('electron')] = cachedElectron;
    } else {
      delete require.cache[require.resolve('electron')];
    }
    if (cachedMain) {
      require.cache[mainPath] = cachedMain;
    } else {
      delete require.cache[mainPath];
    }
  }

  // **Validates: Requirements 3.1**
  it('output contains "## Routing Instructions" header for valid routable tasks', () => {
    const tasks = [
      { id: 'task-a', title: 'Option A' },
      { id: 'task-b', title: 'Option B' },
    ];
    const result = buildRoutingInstructions(tasks);
    assert.ok(result.includes('## Routing Instructions'), 'Should contain routing instructions header');
  });

  // **Validates: Requirements 3.2**
  it('output contains all task IDs for valid routable tasks', () => {
    const tasks = [
      { id: 'task-alpha', title: 'Alpha path' },
      { id: 'task-beta', title: 'Beta path' },
      { id: 'task-gamma', title: 'Gamma path' },
    ];
    const result = buildRoutingInstructions(tasks);
    for (const t of tasks) {
      assert.ok(result.includes(t.id), `Should contain task ID '${t.id}'`);
    }
  });

  // **Validates: Requirements 3.3**
  it('output contains example JSON for valid routable tasks', () => {
    const tasks = [
      { id: 'deploy', title: 'Deploy service' },
      { id: 'rollback', title: 'Rollback service' },
    ];
    const result = buildRoutingInstructions(tasks);
    assert.ok(result.includes('"route"'), 'Should contain example JSON with route key');
    assert.ok(result.includes('"reason"'), 'Should contain example JSON with reason key');
    assert.ok(result.includes(tasks[0].id), 'Example should use first task ID');
  });

  // **Validates: Requirements 3.1, 3.3**
  it('output contains RoutingDecision format description', () => {
    const tasks = [{ id: 'check', title: 'Run checks' }];
    const result = buildRoutingInstructions(tasks);
    assert.ok(result.includes('RoutingDecision'), 'Should mention RoutingDecision format');
  });

  // **Validates: Requirements 3.1, 3.2**
  it('returns empty string for empty array', () => {
    const result = buildRoutingInstructions([]);
    assert.equal(result, '', 'Empty array should return empty string');
  });

  // **Validates: Requirements 3.1, 3.2**
  it('returns empty string for null/undefined', () => {
    assert.equal(buildRoutingInstructions(null), '', 'null should return empty string');
    assert.equal(buildRoutingInstructions(undefined), '', 'undefined should return empty string');
  });
});
