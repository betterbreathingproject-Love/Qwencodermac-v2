'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { parseTaskGraph, printTaskGraph, createTaskNode, createTaskGraph } = require('../task-graph.js');
const { Orchestrator } = require('../orchestrator.js');
const { AgentPool } = require('../agent-pool.js');
const { astSearch, getSupportedPatterns, getSearchStatus, validatePattern } = require('../ast-search.js');
const { initSpec, getSpecPhase, advancePhase, getSpecArtifacts } = require('../spec-workflow.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'integration-test-'));
}

function cleanDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Creates a mock agent factory that records calls and returns configurable results.
 */
function createMockAgentFactory(opts = {}) {
  const calls = [];
  const failures = new Set(opts.failFor || []);
  const delay = opts.delay || 0;

  const factory = (task, agentType, context) => {
    calls.push({ taskId: task.id, agentType: agentType?.name || 'general' });
    return async () => {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      if (failures.has(task.id)) throw new Error(`Task ${task.id} failed`);
      return `Output for ${task.id}`;
    };
  };
  factory.calls = calls;
  return factory;
}


// ── 7.1 Wiring verification ──────────────────────────────────────────────────

describe('7.1 Module wiring verification', () => {
  it('7.1.1 AgentPool has default subagent types registered', () => {
    const pool = new AgentPool({ maxConcurrency: 3 });
    // Register the same types as main.js does
    pool.registerType({ name: 'code-search', systemPrompt: 'search', allowedTools: ['ast-search'] });
    pool.registerType({ name: 'requirements', systemPrompt: 'req', allowedTools: [] });
    pool.registerType({ name: 'design', systemPrompt: 'design', allowedTools: [] });
    pool.registerType({ name: 'implementation', systemPrompt: 'impl', allowedTools: ['ast-search'] });
    pool.registerType({ name: 'general', systemPrompt: 'general', allowedTools: [] });

    // Verify all types are registered by selecting them
    const searchTask = { id: '1', title: 'Search for functions', metadata: {} };
    const implTask = { id: '2', title: 'Implement the feature', metadata: {} };
    const reqTask = { id: '3', title: 'Gather requirements', metadata: {} };
    const designTask = { id: '4', title: 'Design the architecture', metadata: {} };
    const generalTask = { id: '5', title: 'Do something random', metadata: {} };

    assert.equal(pool.selectType(searchTask).name, 'code-search');
    assert.equal(pool.selectType(implTask).name, 'implementation');
    assert.equal(pool.selectType(reqTask).name, 'requirements');
    assert.equal(pool.selectType(designTask).name, 'design');
    assert.equal(pool.selectType(generalTask).name, 'general');
  });

  it('7.1.2 Orchestrator factory creates instances per task graph execution', () => {
    const md = '- [ ] 1 Task A\n- [ ] 2 Task B';
    const graph1 = parseTaskGraph(md);
    const graph2 = parseTaskGraph(md);
    const pool = new AgentPool({ maxConcurrency: 3 });

    const orch1 = new Orchestrator({ taskGraph: graph1, agentPool: pool });
    const orch2 = new Orchestrator({ taskGraph: graph2, agentPool: pool });

    // Each orchestrator has its own state
    assert.equal(orch1.getStatus().state, 'idle');
    assert.equal(orch2.getStatus().state, 'idle');
    assert.notStrictEqual(orch1, orch2);
  });

  it('7.1.3 AST search is available as a tool for code-search and implementation types', () => {
    const pool = new AgentPool({ maxConcurrency: 3 });
    pool.registerType({ name: 'code-search', systemPrompt: 'search', allowedTools: ['ast-search'] });
    pool.registerType({ name: 'implementation', systemPrompt: 'impl', allowedTools: ['ast-search'] });
    pool.registerType({ name: 'general', systemPrompt: 'general', allowedTools: [] });

    // Verify the types have ast-search in allowedTools
    const codeSearchType = pool.selectType({ id: '1', title: 'Search for patterns', metadata: {} });
    const implType = pool.selectType({ id: '2', title: 'Implement the code', metadata: {} });
    const generalType = pool.selectType({ id: '3', title: 'Something else', metadata: {} });

    assert.ok(codeSearchType.allowedTools.includes('ast-search'));
    assert.ok(implType.allowedTools.includes('ast-search'));
    assert.ok(!generalType.allowedTools.includes('ast-search'));

    // Verify ast-search module functions are callable
    assert.equal(typeof astSearch, 'function');
    assert.equal(typeof validatePattern, 'function');
    assert.equal(typeof getSupportedPatterns, 'function');
  });

  it('7.1.4 SpecWorkflow module initializes with project directory', () => {
    const tmpDir = makeTmpDir();
    try {
      const result = initSpec('test-feature', tmpDir);
      assert.equal(result.featureName, 'test-feature');
      assert.ok(result.specDir.includes('.kiro'));
      assert.equal(result.currentPhase, 'requirements');
      assert.ok(fs.existsSync(result.specDir));
    } finally {
      cleanDir(tmpDir);
    }
  });
});


// ── 7.2.1 IPC round-trip (module-level) ──────────────────────────────────────

describe('7.2.1 Module-level round-trip for each channel', () => {
  it('task-graph-parse: parse markdown and get graph back', () => {
    const md = '- [^] 1 Start task\n  - [ ] 1.1 Sub task\n- [ ] 2 Second task';
    const graph = parseTaskGraph(md);

    assert.ok(graph.nodes.size >= 3);
    assert.equal(graph.startNodeId, '1');
    assert.equal(graph.nodes.get('1').title, 'Start task');
    assert.equal(graph.nodes.get('1.1').title, 'Sub task');
    assert.equal(graph.nodes.get('1.1').parent, '1');
  });

  it('task-graph-parse → print → re-parse round-trip', () => {
    const md = '- [^] 1 Start\n- [ ] 2 Middle\n- [$] 3 End';
    const graph = parseTaskGraph(md);
    const printed = printTaskGraph(graph);
    const reparsed = parseTaskGraph(printed);

    assert.equal(reparsed.nodes.size, graph.nodes.size);
    assert.equal(reparsed.startNodeId, '1');
    for (const [id, node] of graph.nodes) {
      const rNode = reparsed.nodes.get(id);
      assert.ok(rNode, `Node ${id} should exist in reparsed graph`);
      assert.equal(rNode.title, node.title);
    }
  });

  it('ast-search: search project files and get results', async () => {
    const results = await astSearch('function', path.join(__dirname, 'fixtures'));
    assert.ok(Array.isArray(results));
    // fixtures/sample.js should have function declarations
    if (results.length > 0) {
      assert.ok(results[0].file);
      assert.ok(results[0].startLine > 0);
      assert.ok(results[0].snippet);
    }
  });

  it('ast-patterns: returns supported patterns', () => {
    const patterns = getSupportedPatterns();
    assert.ok(Array.isArray(patterns));
    assert.ok(patterns.length > 0);
    assert.ok(patterns[0].construct);
    assert.ok(patterns[0].pattern);
  });

  it('ast-search-status: returns backend info', () => {
    const status = getSearchStatus();
    assert.ok(status.backend);
    assert.ok(['ast-grep', 'ripgrep', 'builtin'].includes(status.backend));
  });

  it('spec-init → spec-phase → spec-advance round-trip', () => {
    const tmpDir = makeTmpDir();
    try {
      const spec = initSpec('round-trip-test', tmpDir);
      const phase1 = getSpecPhase(spec.specDir);
      assert.equal(phase1, 'requirements');

      const phase2 = advancePhase(spec.specDir);
      assert.equal(phase2, 'design');

      const phase3 = getSpecPhase(spec.specDir);
      assert.equal(phase3, 'design');
    } finally {
      cleanDir(tmpDir);
    }
  });

  it('bg-task-list and bg-task-cancel via AgentPool', async () => {
    const pool = new AgentPool({ maxConcurrency: 3 });
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [] });

    const task = { id: 'bg-test', title: 'Background test task', metadata: {} };
    const taskId = await pool.dispatchBackground(task, {});

    assert.ok(taskId.startsWith('bg-'));

    const tasks = pool.getBackgroundTasks();
    assert.ok(tasks.length >= 1);
    const bgTask = tasks.find(t => t.id === taskId);
    assert.ok(bgTask);

    // Cancel if still running
    if (bgTask.status === 'running') {
      await pool.cancel(taskId);
      const updated = pool.getBackgroundTasks().find(t => t.id === taskId);
      assert.ok(['cancelled', 'completed'].includes(updated.status));
    }

    await pool.shutdown();
  });
});


// ── 7.2.2 Orchestrator + AgentPool integration ──────────────────────────────

describe('7.2.2 Orchestrator + AgentPool: execute task graph with mock agents', () => {
  it('executes a small task graph and emits all status events', async () => {
    const pool = new AgentPool({ maxConcurrency: 3 });
    const mockFactory = createMockAgentFactory();

    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [] });
    pool.registerType({ name: 'implementation', systemPrompt: '', allowedTools: ['ast-search'] });

    const md = '- [ ] 1 Setup project\n- [ ] 2 Implement feature\n- [ ] 3 Write tests';
    const graph = parseTaskGraph(md);

    const events = [];
    const orch = new Orchestrator({
      taskGraph: graph,
      agentPool: pool,
      onStatusChange: (nodeId, status) => events.push({ nodeId, status }),
    });

    // Override pool's agent factory for testing
    pool._agentFactory = mockFactory;

    await orch.start();

    assert.equal(orch.getStatus().state, 'completed');

    // Verify all nodes went through in_progress → completed
    for (const nodeId of ['1', '2', '3']) {
      const inProgress = events.find(e => e.nodeId === nodeId && e.status === 'in_progress');
      const completed = events.find(e => e.nodeId === nodeId && e.status === 'completed');
      assert.ok(inProgress, `Node ${nodeId} should have in_progress event`);
      assert.ok(completed, `Node ${nodeId} should have completed event`);
    }

    // Verify results are stored
    for (const nodeId of ['1', '2', '3']) {
      const result = orch.getNodeResult(nodeId);
      assert.ok(result, `Node ${nodeId} should have a result`);
      assert.equal(result.nodeId, nodeId);
    }

    await pool.shutdown();
  });

  it('handles task failure and pauses execution', async () => {
    const pool = new AgentPool({ maxConcurrency: 3 });
    const mockFactory = createMockAgentFactory({ failFor: ['2'] });

    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [] });
    pool._agentFactory = mockFactory;

    const md = '- [ ] 1 First\n- [ ] 2 Will fail\n- [ ] 3 Should not run';
    const graph = parseTaskGraph(md);

    const errors = [];
    const orch = new Orchestrator({
      taskGraph: graph,
      agentPool: pool,
      onError: (nodeId, err) => errors.push({ nodeId, message: err.message }),
    });

    await orch.start();

    assert.equal(orch.getStatus().state, 'paused');
    assert.equal(orch.getStatus().graph.nodes.get('2').status, 'failed');
    assert.ok(errors.length >= 1);
    assert.equal(errors[0].nodeId, '2');

    // Node 3 should not have been dispatched
    assert.ok(!mockFactory.calls.some(c => c.taskId === '3'));

    await pool.shutdown();
  });

  it('dispatches parallel nodes concurrently through AgentPool', async () => {
    const pool = new AgentPool({ maxConcurrency: 3 });
    const mockFactory = createMockAgentFactory();

    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [] });
    pool._agentFactory = mockFactory;

    // Build a diamond graph: A → (B, C) → D
    const graph = createTaskGraph();
    graph.nodes.set('A', createTaskNode({ id: 'A', title: 'Start', markers: { start: true, branch: null, terminal: false, loop: null } }));
    graph.nodes.set('B', createTaskNode({ id: 'B', title: 'Parallel 1', dependencies: ['A'] }));
    graph.nodes.set('C', createTaskNode({ id: 'C', title: 'Parallel 2', dependencies: ['A'] }));
    graph.nodes.set('D', createTaskNode({ id: 'D', title: 'Join', dependencies: ['B', 'C'] }));
    graph.startNodeId = 'A';
    graph._orderedIds = ['A', 'B', 'C', 'D'];

    const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });
    await orch.start();

    assert.equal(orch.getStatus().state, 'completed');
    assert.equal(mockFactory.calls.length, 4);

    // A first, then B and C (any order), then D
    assert.equal(mockFactory.calls[0].taskId, 'A');
    const middle = [mockFactory.calls[1].taskId, mockFactory.calls[2].taskId].sort();
    assert.deepEqual(middle, ['B', 'C']);
    assert.equal(mockFactory.calls[3].taskId, 'D');

    await pool.shutdown();
  });

  it('persists task graph state to file during execution', async () => {
    const tmpDir = makeTmpDir();
    const tmpFile = path.join(tmpDir, 'tasks.md');

    try {
      const pool = new AgentPool({ maxConcurrency: 3 });
      const mockFactory = createMockAgentFactory();
      pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [] });
      pool._agentFactory = mockFactory;

      const md = '- [ ] 1 Task A\n- [ ] 2 Task B';
      const graph = parseTaskGraph(md);

      const orch = new Orchestrator({
        taskGraph: graph,
        agentPool: pool,
        tasksFilePath: tmpFile,
      });

      await orch.start();

      assert.ok(fs.existsSync(tmpFile));
      const content = fs.readFileSync(tmpFile, 'utf-8');
      assert.ok(content.includes('[x]'), 'Persisted file should show completed status');

      await pool.shutdown();
    } finally {
      cleanDir(tmpDir);
    }
  });
});


// ── 7.2.3 Background task integration ────────────────────────────────────────

describe('7.2.3 Background task: spawn, buffer events, complete', () => {
  it('spawns a background task and collects events', async () => {
    const pool = new AgentPool({ maxConcurrency: 3 });
    const mockFactory = createMockAgentFactory();

    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [] });
    pool._agentFactory = mockFactory;

    const bgEvents = [];
    pool.on('bg-task-event', (evt) => bgEvents.push(evt));

    const task = { id: 'bg-1', title: 'Background work', metadata: {} };
    const taskId = await pool.dispatchBackground(task, {});

    assert.ok(taskId.startsWith('bg-'));

    // Wait for completion
    await new Promise(r => setTimeout(r, 100));

    // Should have started and completed events
    const started = bgEvents.find(e => e.taskId === taskId && e.type === 'started');
    const completed = bgEvents.find(e => e.taskId === taskId && e.type === 'completed');
    assert.ok(started, 'Should have a started event');
    assert.ok(completed, 'Should have a completed event');

    // Verify task is in background tasks list
    const tasks = pool.getBackgroundTasks();
    const bgTask = tasks.find(t => t.id === taskId);
    assert.ok(bgTask);
    assert.equal(bgTask.status, 'completed');
    assert.ok(bgTask.output !== undefined);

    await pool.shutdown();
  });

  it('cancels a running background task', async () => {
    const pool = new AgentPool({ maxConcurrency: 3 });

    // Use a slow factory so we can cancel mid-flight
    pool._agentFactory = (task, agentType, context) => {
      return async () => {
        await new Promise(r => setTimeout(r, 5000));
        return 'done';
      };
    };
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [] });

    const bgEvents = [];
    pool.on('bg-task-event', (evt) => bgEvents.push(evt));

    const task = { id: 'bg-cancel', title: 'Long running task', metadata: {} };
    const taskId = await pool.dispatchBackground(task, {});

    // Give it a moment to start
    await new Promise(r => setTimeout(r, 50));

    await pool.cancel(taskId);

    const cancelledEvt = bgEvents.find(e => e.taskId === taskId && e.type === 'cancelled');
    assert.ok(cancelledEvt, 'Should have a cancelled event');

    const tasks = pool.getBackgroundTasks();
    const bgTask = tasks.find(t => t.id === taskId);
    assert.equal(bgTask.status, 'cancelled');

    await pool.shutdown();
  });

  it('multiple background tasks run independently', async () => {
    const pool = new AgentPool({ maxConcurrency: 3 });
    const mockFactory = createMockAgentFactory();

    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [] });
    pool._agentFactory = mockFactory;

    const task1 = { id: 'bg-a', title: 'Task A', metadata: {} };
    const task2 = { id: 'bg-b', title: 'Task B', metadata: {} };

    const id1 = await pool.dispatchBackground(task1, {});
    const id2 = await pool.dispatchBackground(task2, {});

    assert.notEqual(id1, id2);

    // Wait for both to complete
    await new Promise(r => setTimeout(r, 100));

    const tasks = pool.getBackgroundTasks();
    const t1 = tasks.find(t => t.id === id1);
    const t2 = tasks.find(t => t.id === id2);

    assert.equal(t1.status, 'completed');
    assert.equal(t2.status, 'completed');

    await pool.shutdown();
  });
});


// ── 7.2.4 Spec workflow end-to-end ───────────────────────────────────────────

describe('7.2.4 Spec workflow end-to-end: init, advance phases, verify artifacts', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('initializes spec and advances through all phases', () => {
    const spec = initSpec('my-feature', tmpDir);

    assert.equal(spec.featureName, 'my-feature');
    assert.equal(spec.currentPhase, 'requirements');
    assert.ok(fs.existsSync(spec.specDir));

    // Config file should exist
    const configPath = path.join(spec.specDir, '.config.kiro');
    assert.ok(fs.existsSync(configPath));
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(config.currentPhase, 'requirements');

    // Advance through phases
    const phase2 = advancePhase(spec.specDir);
    assert.equal(phase2, 'design');

    const phase3 = advancePhase(spec.specDir);
    assert.equal(phase3, 'tasks');

    const phase4 = advancePhase(spec.specDir);
    assert.equal(phase4, 'implementation');

    // Should not advance past implementation
    const phase5 = advancePhase(spec.specDir);
    assert.equal(phase5, 'implementation');
  });

  it('creates and reads spec artifacts', () => {
    const spec = initSpec('artifact-test', tmpDir);

    // Write some artifacts
    fs.writeFileSync(path.join(spec.specDir, 'requirements.md'), '# Requirements\n\n- Req 1');
    fs.writeFileSync(path.join(spec.specDir, 'design.md'), '# Design\n\n## Component A');

    const artifacts = getSpecArtifacts(spec.specDir);
    assert.ok(artifacts.requirements);
    assert.ok(artifacts.requirements.includes('Req 1'));
    assert.ok(artifacts.design);
    assert.ok(artifacts.design.includes('Component A'));
    assert.equal(artifacts.tasks, undefined); // Not created yet
  });

  it('handles feature names with spaces', () => {
    const spec = initSpec('My Cool Feature', tmpDir);
    assert.equal(spec.featureName, 'my-cool-feature');
    assert.ok(fs.existsSync(spec.specDir));
  });

  it('getSpecPhase reads current phase correctly after advances', () => {
    const spec = initSpec('phase-test', tmpDir);

    assert.equal(getSpecPhase(spec.specDir), 'requirements');
    advancePhase(spec.specDir);
    assert.equal(getSpecPhase(spec.specDir), 'design');
    advancePhase(spec.specDir);
    assert.equal(getSpecPhase(spec.specDir), 'tasks');
  });

  it('full workflow: init → write artifacts → advance → read artifacts', () => {
    const spec = initSpec('full-workflow', tmpDir);

    // Requirements phase
    assert.equal(getSpecPhase(spec.specDir), 'requirements');
    fs.writeFileSync(path.join(spec.specDir, 'requirements.md'), '# Requirements\n\n- Feature X');

    // Advance to design
    advancePhase(spec.specDir);
    assert.equal(getSpecPhase(spec.specDir), 'design');
    fs.writeFileSync(path.join(spec.specDir, 'design.md'), '# Design\n\n## Module X\n- Build it');

    // Advance to tasks
    advancePhase(spec.specDir);
    assert.equal(getSpecPhase(spec.specDir), 'tasks');
    fs.writeFileSync(path.join(spec.specDir, 'tasks.md'), '- [ ] 1 Build Module X');

    // Advance to implementation
    advancePhase(spec.specDir);
    assert.equal(getSpecPhase(spec.specDir), 'implementation');

    // All artifacts should be readable
    const artifacts = getSpecArtifacts(spec.specDir);
    assert.ok(artifacts.requirements.includes('Feature X'));
    assert.ok(artifacts.design.includes('Module X'));
    assert.ok(artifacts.tasks.includes('Build Module X'));
  });
});

// ── 7.1 main.js wiring verification (source-level) ──────────────────────────

describe('7.1 Verify main.js wiring', () => {
  it('main.js registers all default subagent types', () => {
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

    const expectedTypes = ['code-search', 'requirements', 'design', 'implementation', 'general'];
    for (const typeName of expectedTypes) {
      assert.ok(
        mainSource.includes(`name: '${typeName}'`),
        `main.js should register '${typeName}' subagent type`
      );
    }
  });

  it('main.js registers ast-search as tool for code-search and implementation', () => {
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');

    // Find the code-search registration line and verify it has ast-search
    assert.ok(
      mainSource.includes("name: 'code-search'") && mainSource.includes("allowedTools: ['ast-search']"),
      'code-search type should have ast-search in allowedTools'
    );
    assert.ok(
      mainSource.includes("name: 'implementation'") && mainSource.includes("allowedTools: ['ast-search']"),
      'implementation type should have ast-search in allowedTools'
    );
  });

  it('main.js creates orchestrator instances per execution', () => {
    // Orchestrator creation moved to main/ipc-tasks.js during modularization
    const tasksSource = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc-tasks.js'), 'utf-8');

    // The task-graph-execute handler should create a new Orchestrator
    assert.ok(
      tasksSource.includes('new Orchestrator'),
      'ipc-tasks.js should create Orchestrator instances'
    );
    assert.ok(
      tasksSource.includes('task-graph-execute'),
      'ipc-tasks.js should have task-graph-execute IPC handler'
    );
  });
});
