'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { AgentPool, CATEGORY_KEYWORDS } = require('../agent-pool.js');

// --- Helpers ---

function createTestTypes() {
  return [
    { name: 'code-search', systemPrompt: 'You search code.', allowedTools: ['ast-search'], timeout: 10000, maxConcurrent: 2 },
    { name: 'implementation', systemPrompt: 'You implement code.', allowedTools: ['write-file'], timeout: 60000, maxConcurrent: 2 },
    { name: 'requirements', systemPrompt: 'You gather requirements.', allowedTools: [], timeout: 30000, maxConcurrent: 1 },
    { name: 'design', systemPrompt: 'You design systems.', allowedTools: [], timeout: 30000, maxConcurrent: 1 },
    { name: 'general', systemPrompt: 'You are a general agent.', allowedTools: [], timeout: 30000, maxConcurrent: 3 },
  ];
}

function mockAgentFactory(resolveValue = 'mock-output', delay = 0) {
  return (task, agentType, context) => {
    return async () => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return resolveValue;
    };
  };
}

function createTask(id, title, metadata = {}) {
  return { id, title, status: 'not_started', dependencies: [], children: [], parent: null, markers: { start: false, branch: null, terminal: false, loop: null }, parallel: false, metadata, depth: 0 };
}

// --- 3.7.1 Test type registration and selection ---

describe('AgentPool - type registration and selection', () => {
  let pool;

  beforeEach(() => {
    pool = new AgentPool({ maxConcurrency: 3, defaultTimeout: 5000 });
    for (const t of createTestTypes()) {
      pool.registerType(t);
    }
  });

  it('registers types and retrieves them', () => {
    assert.equal(pool._types.size, 5);
    assert.ok(pool._types.has('code-search'));
    assert.ok(pool._types.has('implementation'));
    assert.ok(pool._types.has('general'));
  });

  it('throws on registering type without name', () => {
    assert.throws(() => pool.registerType({}), /must have a name/);
    assert.throws(() => pool.registerType(null), /must have a name/);
  });

  it('selects code-search type for search-related tasks', () => {
    const task = createTask('1', 'Search for all async functions');
    const selected = pool.selectType(task);
    assert.equal(selected.name, 'code-search');
  });

  it('selects implementation type for coding tasks', () => {
    const task = createTask('2', 'Implement the user authentication module');
    const selected = pool.selectType(task);
    assert.equal(selected.name, 'implementation');
  });

  it('selects requirements type for spec tasks', () => {
    const task = createTask('3', 'Gather requirements for the login feature');
    const selected = pool.selectType(task);
    assert.equal(selected.name, 'requirements');
  });

  it('selects design type for architecture tasks', () => {
    const task = createTask('4', 'Design the database schema');
    const selected = pool.selectType(task);
    assert.equal(selected.name, 'design');
  });

  it('falls back to general for unrecognized tasks', () => {
    const task = createTask('5', 'Do something random');
    const selected = pool.selectType(task);
    assert.equal(selected.name, 'general');
  });

  it('uses explicit metadata category when available', () => {
    const task = createTask('6', 'Do something random', { category: 'code-search' });
    const selected = pool.selectType(task);
    assert.equal(selected.name, 'code-search');
  });

  it('dispatches task with mock agent and returns result', async () => {
    const task = createTask('1', 'Implement feature');
    const result = await pool.dispatch(task, {}, { agentFactory: mockAgentFactory('done') });

    assert.equal(result.nodeId, '1');
    assert.equal(result.output, 'done');
    assert.equal(result.agentType, 'implementation');
    assert.ok(result.duration >= 0);
  });
});

// --- 3.7.2 Test timeout behavior ---

describe('AgentPool - timeout behavior', () => {
  it('returns timeout error when agent exceeds timeout', async () => {
    const pool = new AgentPool({ maxConcurrency: 1, defaultTimeout: 50 });
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [], timeout: 50, maxConcurrent: 1 });

    const task = createTask('1', 'Slow task');
    const slowFactory = (t, type, ctx) => {
      return async () => {
        await new Promise((r) => setTimeout(r, 500));
        return 'should not reach';
      };
    };

    const result = await pool.dispatch(task, {}, { agentFactory: slowFactory });

    assert.ok(result.error);
    assert.ok(result.error.includes('timed out'));
    assert.equal(result.nodeId, '1');
  });

  it('does not timeout when agent completes quickly', async () => {
    const pool = new AgentPool({ maxConcurrency: 1, defaultTimeout: 5000 });
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [], timeout: 5000, maxConcurrent: 1 });

    const task = createTask('1', 'Fast task');
    const result = await pool.dispatch(task, {}, { agentFactory: mockAgentFactory('fast-result', 10) });

    assert.ok(!result.error);
    assert.equal(result.output, 'fast-result');
  });
});

// --- 3.7.3 Test background task lifecycle ---

describe('AgentPool - background task lifecycle', () => {
  it('spawns background task and returns taskId immediately', async () => {
    const pool = new AgentPool({ maxConcurrency: 3, defaultTimeout: 5000 });
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [], timeout: 5000, maxConcurrent: 3 });

    const task = createTask('1', 'Background work');
    const factory = mockAgentFactory('bg-result', 50);

    const taskId = await pool.dispatchBackground(task, {}, { agentFactory: factory });

    assert.ok(taskId);
    assert.ok(taskId.startsWith('bg-'));

    // Task should be in background tasks list
    const bgTasks = pool.getBackgroundTasks();
    assert.equal(bgTasks.length, 1);
    assert.equal(bgTasks[0].id, taskId);
    assert.equal(bgTasks[0].status, 'running');
  });

  it('completes background task and stores result', async () => {
    const pool = new AgentPool({ maxConcurrency: 3, defaultTimeout: 5000 });
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [], timeout: 5000, maxConcurrent: 3 });

    const task = createTask('1', 'Background work');
    const factory = mockAgentFactory('bg-done', 20);

    const taskId = await pool.dispatchBackground(task, {}, { agentFactory: factory });

    // Wait for completion
    await new Promise((r) => setTimeout(r, 100));

    const bgTasks = pool.getBackgroundTasks();
    const bt = bgTasks.find((t) => t.id === taskId);
    assert.ok(bt);
    assert.equal(bt.status, 'completed');
    assert.equal(bt.output, 'bg-done');
    assert.ok(bt.endTime);
  });

  it('cancels a running background task', async () => {
    const pool = new AgentPool({ maxConcurrency: 3, defaultTimeout: 5000 });
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [], timeout: 5000, maxConcurrent: 3 });

    const task = createTask('1', 'Long background work');
    const factory = mockAgentFactory('should-not-complete', 2000);

    const taskId = await pool.dispatchBackground(task, {}, { agentFactory: factory });

    // Cancel immediately
    await pool.cancel(taskId);

    const bgTasks = pool.getBackgroundTasks();
    const bt = bgTasks.find((t) => t.id === taskId);
    assert.ok(bt);
    assert.equal(bt.status, 'cancelled');
    assert.ok(bt.endTime);
  });

  it('emits bg-task-event on lifecycle changes', async () => {
    const pool = new AgentPool({ maxConcurrency: 3, defaultTimeout: 5000 });
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [], timeout: 5000, maxConcurrent: 3 });

    const events = [];
    pool.on('bg-task-event', (e) => events.push(e));

    const task = createTask('1', 'Background work');
    const factory = mockAgentFactory('bg-done', 20);

    const taskId = await pool.dispatchBackground(task, {}, { agentFactory: factory });

    // Wait for completion
    await new Promise((r) => setTimeout(r, 100));

    const started = events.find((e) => e.type === 'started' && e.taskId === taskId);
    const completed = events.find((e) => e.type === 'completed' && e.taskId === taskId);
    assert.ok(started, 'Should emit started event');
    assert.ok(completed, 'Should emit completed event');
  });

  it('handles background task failure', async () => {
    const pool = new AgentPool({ maxConcurrency: 3, defaultTimeout: 5000 });
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [], timeout: 5000, maxConcurrent: 3 });

    const task = createTask('1', 'Failing background work');
    const failFactory = () => {
      return async () => { throw new Error('bg-fail'); };
    };

    const taskId = await pool.dispatchBackground(task, {}, { agentFactory: failFactory });

    // Wait for failure
    await new Promise((r) => setTimeout(r, 100));

    const bgTasks = pool.getBackgroundTasks();
    const bt = bgTasks.find((t) => t.id === taskId);
    assert.ok(bt);
    assert.equal(bt.status, 'failed');
    assert.ok(bt.output.includes('bg-fail'));
  });
});

// --- Additional tests ---

describe('AgentPool - concurrency and query methods', () => {
  it('getRunningTasks returns empty when no tasks running', () => {
    const pool = new AgentPool();
    assert.deepEqual(pool.getRunningTasks(), []);
  });

  it('getBackgroundTasks returns empty when no background tasks', () => {
    const pool = new AgentPool();
    assert.deepEqual(pool.getBackgroundTasks(), []);
  });

  it('shutdown cancels all background tasks', async () => {
    const pool = new AgentPool({ maxConcurrency: 3, defaultTimeout: 5000 });
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [], timeout: 5000, maxConcurrent: 3 });

    const task = createTask('1', 'Long task');
    const factory = mockAgentFactory('result', 5000);

    await pool.dispatchBackground(task, {}, { agentFactory: factory });
    await pool.dispatchBackground(createTask('2', 'Another long task'), {}, { agentFactory: factory });

    await pool.shutdown();

    const bgTasks = pool.getBackgroundTasks();
    for (const bt of bgTasks) {
      assert.equal(bt.status, 'cancelled');
    }
  });

  it('enforces concurrency limit with semaphore', async () => {
    const pool = new AgentPool({ maxConcurrency: 2, defaultTimeout: 5000 });
    pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [], timeout: 5000, maxConcurrent: 2 });

    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const trackingFactory = () => {
      return async () => {
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
        await new Promise((r) => setTimeout(r, 50));
        currentConcurrent--;
        return 'done';
      };
    };

    // Dispatch 5 tasks concurrently
    const tasks = Array.from({ length: 5 }, (_, i) => createTask(String(i + 1), 'Task'));
    const promises = tasks.map((t) => pool.dispatch(t, {}, { agentFactory: trackingFactory }));

    await Promise.all(promises);

    assert.ok(maxConcurrent <= 2, `Max concurrent was ${maxConcurrent}, expected <= 2`);
  });
});
