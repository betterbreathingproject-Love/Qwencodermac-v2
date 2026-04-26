'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createTaskNode, createTaskGraph } = require('../task-graph.js');
const { Orchestrator } = require('../orchestrator.js');
const { AgentPool } = require('../agent-pool.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'routing-integration-'));
}

function cleanDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Build a task graph: A → B (branch) → [C, D, E]
 * B is a branch point. C, D, E are siblings after B (same parent=null, same depth=0).
 */
function buildBranchGraph() {
  const graph = createTaskGraph();

  graph.nodes.set('A', createTaskNode({
    id: 'A', title: 'Setup', depth: 0, parent: null,
    markers: { start: true, branch: null, terminal: false, loop: null },
  }));
  graph.nodes.set('B', createTaskNode({
    id: 'B', title: 'Branch decision', depth: 0, parent: null,
    dependencies: ['A'],
    markers: { start: false, branch: 'route_check', terminal: false, loop: null },
  }));
  graph.nodes.set('C', createTaskNode({
    id: 'C', title: 'Path C', depth: 0, parent: null,
    dependencies: ['B'],
  }));
  graph.nodes.set('D', createTaskNode({
    id: 'D', title: 'Path D', depth: 0, parent: null,
    dependencies: ['B'],
  }));
  graph.nodes.set('E', createTaskNode({
    id: 'E', title: 'Path E', depth: 0, parent: null,
    dependencies: ['B'],
  }));

  graph.startNodeId = 'A';
  graph._orderedIds = ['A', 'B', 'C', 'D', 'E'];
  return graph;
}

/**
 * Create a mock agent factory where the branch node (B) returns a specific output,
 * and all other nodes return generic output.
 */
function createRoutingMockFactory(branchOutput) {
  const calls = [];
  const factory = (task, _agentType, _context) => {
    calls.push(task.id);
    return async () => {
      if (task.id === 'B') return branchOutput;
      return `Output for ${task.id}`;
    };
  };
  factory.calls = calls;
  return factory;
}


// ── Test 1: End-to-end single routing ─────────────────────────────────────────
// **Validates: Requirements 1.1, 2.1, 2.2**

describe('End-to-end routing: branch selects single path', () => {
  it('routes to C, skips D and E, stores reason, completes overall', async () => {
    const graph = buildBranchGraph();
    const pool = new AgentPool({ maxConcurrency: 3 });
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [] });

    const branchOutput = '{"route": "C", "reason": "C is optimal"}';
    const mockFactory = createRoutingMockFactory(branchOutput);
    pool._agentFactory = mockFactory;

    const events = [];
    const orch = new Orchestrator({
      taskGraph: graph,
      agentPool: pool,
      onStatusChange: (nodeId, status) => events.push({ nodeId, status }),
    });

    await orch.start();

    const status = orch.getStatus();

    // Overall state is completed
    assert.equal(status.state, 'completed');

    // A completed
    assert.equal(status.graph.nodes.get('A').status, 'completed');

    // B completed (branch node)
    assert.equal(status.graph.nodes.get('B').status, 'completed');

    // C completed (was routed to)
    assert.equal(status.graph.nodes.get('C').status, 'completed');

    // D skipped
    assert.equal(status.graph.nodes.get('D').status, 'skipped');

    // E skipped
    assert.equal(status.graph.nodes.get('E').status, 'skipped');

    // Reason stored in context
    assert.equal(orch._context['B_reason'], 'C is optimal');

    // Verify dispatch order: A first, then B (branch), then C (routed)
    assert.equal(mockFactory.calls[0], 'A');
    assert.equal(mockFactory.calls[1], 'B');
    assert.equal(mockFactory.calls[2], 'C');
    assert.equal(mockFactory.calls.length, 3); // D and E never dispatched

    await pool.shutdown();
  });
});


// ── Test 2: End-to-end fan-out routing ────────────────────────────────────────
// **Validates: Requirements 2.1, 2.2**

describe('End-to-end fan-out: branch selects multiple paths', () => {
  it('routes to C and D, skips E, both complete', async () => {
    const graph = buildBranchGraph();
    const pool = new AgentPool({ maxConcurrency: 3 });
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [] });

    const branchOutput = '{"route": ["C", "D"]}';
    const mockFactory = createRoutingMockFactory(branchOutput);
    pool._agentFactory = mockFactory;

    const orch = new Orchestrator({
      taskGraph: graph,
      agentPool: pool,
    });

    await orch.start();

    const status = orch.getStatus();

    // Overall state is completed
    assert.equal(status.state, 'completed');

    // A and B completed
    assert.equal(status.graph.nodes.get('A').status, 'completed');
    assert.equal(status.graph.nodes.get('B').status, 'completed');

    // C and D both completed (fan-out)
    assert.equal(status.graph.nodes.get('C').status, 'completed');
    assert.equal(status.graph.nodes.get('D').status, 'completed');

    // E skipped
    assert.equal(status.graph.nodes.get('E').status, 'skipped');

    // A, B dispatched, then C and D (any order), E never dispatched
    assert.ok(mockFactory.calls.includes('C'));
    assert.ok(mockFactory.calls.includes('D'));
    assert.ok(!mockFactory.calls.includes('E'));

    await pool.shutdown();
  });
});


// ── Test 3: IPC steering-generate integration ─────────────────────────────────
// **Validates: Requirements 8.2**

describe('IPC steering-generate integration', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = makeTmpDir();
    // Write a package.json so the generator has something to analyze
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'integration-test-project',
        description: 'A test project for steering integration',
        main: 'index.js',
        dependencies: { express: '^4.18.0' },
        devDependencies: {},
        scripts: { start: 'node index.js', test: 'node --test' },
      }, null, 2),
      'utf8'
    );
  });

  afterEach(() => cleanDir(projectDir));

  it('steering-generate handler invokes generator, writes docs, emits progress', async () => {
    // Build mock IPC infrastructure
    const handlers = {};
    const mockIpc = {
      handle(channel, fn) { handlers[channel] = fn; },
    };

    const sentMessages = [];
    const mockWindow = {
      webContents: {
        send(channel, data) { sentMessages.push({ channel, data }); },
      },
    };

    const mockPool = {
      async dispatch(_task, _context) {
        return { output: 'Mock explore output', duration: 50, agentType: 'explore' };
      },
    };

    // Register IPC handlers
    const { register } = require('../main/ipc-tasks.js');
    register(mockIpc, {
      getMainWindow: () => mockWindow,
      getCurrentProject: () => projectDir,
      getAgentPool: () => mockPool,
      findPython: () => 'python3',
    });

    // Call steering-generate
    const result = await handlers['steering-generate']({}, { projectDir });

    // Returns { ok: true, docsGenerated: [...] }
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.docsGenerated));
    assert.ok(result.docsGenerated.includes('project-overview.md'));

    // project-overview.md exists on disk
    const overviewPath = path.join(projectDir, '.maccoder', 'steering', 'project-overview.md');
    assert.ok(fs.existsSync(overviewPath), 'project-overview.md should exist on disk');

    const overviewContent = fs.readFileSync(overviewPath, 'utf8');
    assert.ok(overviewContent.includes('project-overview'), 'Overview should contain its name');

    // Progress events were emitted
    const progressEvents = sentMessages.filter(m => m.channel === 'steering-progress');
    assert.ok(progressEvents.length >= 3, `Expected at least 3 progress events, got ${progressEvents.length}`);

    const stages = progressEvents.map(e => e.data.stage);
    assert.ok(stages.includes('starting'));
    assert.ok(stages.includes('analyzing'));
    assert.ok(stages.includes('complete'));

    // Verify order: starting before analyzing before complete
    assert.ok(stages.indexOf('starting') < stages.indexOf('analyzing'));
    assert.ok(stages.indexOf('analyzing') < stages.indexOf('complete'));
  });
});
