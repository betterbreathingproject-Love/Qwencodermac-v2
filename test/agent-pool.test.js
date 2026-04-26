'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { AgentPool, CATEGORY_KEYWORDS, LSP_TOOL_SETS } = require('../agent-pool.js');

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

// --- 7.3 LSP tool merging in AgentPool ---

describe('AgentPool - LSP tool merging', () => {
  /** Helper: create a pool with all standard types and a given LSP status getter */
  function createPoolWithLsp(getLspStatus) {
    const pool = new AgentPool({ maxConcurrency: 3, defaultTimeout: 5000, getLspStatus });
    // Register types that mirror the real roles with base (non-LSP) tools
    pool.registerType({ name: 'explore', systemPrompt: 'Explore.', allowedTools: ['read_file', 'list_dir'], timeout: 10000 });
    pool.registerType({ name: 'context-gather', systemPrompt: 'Gather context.', allowedTools: ['read_file', 'search_files'], timeout: 10000 });
    pool.registerType({ name: 'code-search', systemPrompt: 'Search code.', allowedTools: ['ast-search', 'search_files'], timeout: 10000 });
    pool.registerType({ name: 'implementation', systemPrompt: 'Implement.', allowedTools: ['write_file', 'edit_file', 'bash'], timeout: 60000 });
    pool.registerType({ name: 'general', systemPrompt: 'General agent.', allowedTools: ['read_file', 'write_file', 'bash'], timeout: 30000 });
    pool.registerType({ name: 'requirements', systemPrompt: 'Requirements.', allowedTools: ['read_file'], timeout: 30000 });
    pool.registerType({ name: 'design', systemPrompt: 'Design.', allowedTools: ['read_file'], timeout: 30000 });
    return pool;
  }

  // --- LSP ready: each role gets its correct LSP tools merged ---

  describe('when LSP is ready', () => {
    let pool;
    beforeEach(() => {
      pool = createPoolWithLsp(() => 'ready');
    });

    it('explore role includes correct LSP tools (Req 3.1)', () => {
      const task = createTask('t1', 'Explore the project structure');
      const selected = pool.selectType(task);
      assert.equal(selected.name, 'explore');
      for (const tool of LSP_TOOL_SETS['explore']) {
        assert.ok(selected.allowedTools.includes(tool), `Missing LSP tool: ${tool}`);
      }
    });

    it('context-gather role includes correct LSP tools (Req 3.2)', () => {
      const task = createTask('t2', 'Gather context for related files', { category: 'context-gather' });
      const selected = pool.selectType(task);
      assert.equal(selected.name, 'context-gather');
      for (const tool of LSP_TOOL_SETS['context-gather']) {
        assert.ok(selected.allowedTools.includes(tool), `Missing LSP tool: ${tool}`);
      }
    });

    it('code-search role includes correct LSP tools (Req 3.3)', () => {
      const task = createTask('t3', 'Search for all usages of createPool');
      const selected = pool.selectType(task);
      assert.equal(selected.name, 'code-search');
      for (const tool of LSP_TOOL_SETS['code-search']) {
        assert.ok(selected.allowedTools.includes(tool), `Missing LSP tool: ${tool}`);
      }
    });

    it('implementation role includes correct LSP tools (Req 3.4)', () => {
      const task = createTask('t4', 'Implement the authentication module');
      const selected = pool.selectType(task);
      assert.equal(selected.name, 'implementation');
      for (const tool of LSP_TOOL_SETS['implementation']) {
        assert.ok(selected.allowedTools.includes(tool), `Missing LSP tool: ${tool}`);
      }
    });

    it('general role includes same LSP tools as implementation (Req 3.5)', () => {
      const task = createTask('t5', 'Do something unrecognized');
      const selected = pool.selectType(task);
      assert.equal(selected.name, 'general');
      for (const tool of LSP_TOOL_SETS['general']) {
        assert.ok(selected.allowedTools.includes(tool), `Missing LSP tool: ${tool}`);
      }
      // Verify general and implementation have the same LSP tool set
      assert.deepEqual(LSP_TOOL_SETS['general'], LSP_TOOL_SETS['implementation']);
    });
  });

  // --- LSP not ready: no LSP tools for any role ---

  describe('when LSP is not ready', () => {
    const nonReadyStatuses = ['stopped', 'starting', 'error', 'degraded'];

    for (const status of nonReadyStatuses) {
      it(`excludes LSP tools when LSP status is "${status}" (Req 3.6)`, () => {
        const pool = createPoolWithLsp(() => status);
        pool.registerType({ name: 'implementation', systemPrompt: 'Impl.', allowedTools: ['write_file', 'bash'], timeout: 60000 });
        pool.registerType({ name: 'general', systemPrompt: 'General.', allowedTools: ['read_file'], timeout: 30000 });

        const task = createTask('t1', 'Implement feature X');
        const selected = pool.selectType(task);
        assert.equal(selected.name, 'implementation');

        // No lsp_ tools should be present
        const lspTools = selected.allowedTools.filter(t => t.startsWith('lsp_'));
        assert.equal(lspTools.length, 0, `Expected no LSP tools when status is "${status}", got: ${lspTools}`);
      });
    }

    it('excludes LSP tools when getLspStatus is null', () => {
      const pool = new AgentPool({ maxConcurrency: 1, defaultTimeout: 5000 });
      pool.registerType({ name: 'implementation', systemPrompt: 'Impl.', allowedTools: ['write_file'], timeout: 60000 });
      pool.registerType({ name: 'general', systemPrompt: 'General.', allowedTools: ['read_file'], timeout: 30000 });

      const task = createTask('t1', 'Implement something');
      const selected = pool.selectType(task);
      const lspTools = selected.allowedTools.filter(t => t.startsWith('lsp_'));
      assert.equal(lspTools.length, 0);
    });
  });

  // --- Unknown roles get no LSP tools ---

  describe('unknown roles get no LSP tools', () => {
    it('role not in LSP_TOOL_SETS gets no LSP tools even when LSP is ready', () => {
      const pool = createPoolWithLsp(() => 'ready');
      // requirements and design are registered but have no LSP_TOOL_SETS entry
      const task = createTask('t1', 'Gather requirements for login', { category: 'requirements' });
      const selected = pool.selectType(task);
      assert.equal(selected.name, 'requirements');

      const lspTools = selected.allowedTools.filter(t => t.startsWith('lsp_'));
      assert.equal(lspTools.length, 0, 'Requirements role should have no LSP tools');
    });

    it('design role gets no LSP tools even when LSP is ready', () => {
      const pool = createPoolWithLsp(() => 'ready');
      const task = createTask('t1', 'Design the database schema', { category: 'design' });
      const selected = pool.selectType(task);
      assert.equal(selected.name, 'design');

      const lspTools = selected.allowedTools.filter(t => t.startsWith('lsp_'));
      assert.equal(lspTools.length, 0, 'Design role should have no LSP tools');
    });
  });

  // --- Base tools always present ---

  describe('base allowed tools always present', () => {
    it('base tools preserved when LSP is ready', () => {
      const pool = createPoolWithLsp(() => 'ready');
      const task = createTask('t1', 'Implement the auth module');
      const selected = pool.selectType(task);
      assert.equal(selected.name, 'implementation');

      // Base tools for implementation: write_file, edit_file, bash
      assert.ok(selected.allowedTools.includes('write_file'));
      assert.ok(selected.allowedTools.includes('edit_file'));
      assert.ok(selected.allowedTools.includes('bash'));
    });

    it('base tools preserved when LSP is not ready', () => {
      const pool = createPoolWithLsp(() => 'stopped');
      const task = createTask('t1', 'Implement the auth module');
      const selected = pool.selectType(task);
      assert.equal(selected.name, 'implementation');

      assert.ok(selected.allowedTools.includes('write_file'));
      assert.ok(selected.allowedTools.includes('edit_file'));
      assert.ok(selected.allowedTools.includes('bash'));
    });

    it('explore base tools preserved regardless of LSP status', () => {
      const poolReady = createPoolWithLsp(() => 'ready');
      const poolStopped = createPoolWithLsp(() => 'stopped');

      const task = createTask('t1', 'Explore the project architecture');
      const readyResult = poolReady.selectType(task);
      const stoppedResult = poolStopped.selectType(task);

      // Both should have the base tools
      assert.ok(readyResult.allowedTools.includes('read_file'));
      assert.ok(readyResult.allowedTools.includes('list_dir'));
      assert.ok(stoppedResult.allowedTools.includes('read_file'));
      assert.ok(stoppedResult.allowedTools.includes('list_dir'));

      // Ready should have more tools (base + LSP), stopped should have only base
      assert.ok(readyResult.allowedTools.length > stoppedResult.allowedTools.length);
    });
  });

  // --- setLspStatusGetter ---

  describe('setLspStatusGetter', () => {
    it('dynamically switches LSP tool inclusion when status getter changes', () => {
      let status = 'stopped';
      const pool = new AgentPool({ maxConcurrency: 1, defaultTimeout: 5000, getLspStatus: () => status });
      pool.registerType({ name: 'implementation', systemPrompt: 'Impl.', allowedTools: ['write_file'], timeout: 60000 });
      pool.registerType({ name: 'general', systemPrompt: 'General.', allowedTools: ['read_file'], timeout: 30000 });

      const task = createTask('t1', 'Implement feature');

      // Initially stopped — no LSP tools
      let selected = pool.selectType(task);
      let lspTools = selected.allowedTools.filter(t => t.startsWith('lsp_'));
      assert.equal(lspTools.length, 0);

      // Switch to ready — LSP tools appear
      status = 'ready';
      selected = pool.selectType(task);
      lspTools = selected.allowedTools.filter(t => t.startsWith('lsp_'));
      assert.ok(lspTools.length > 0, 'LSP tools should appear when status becomes ready');

      // Switch back to error — LSP tools disappear
      status = 'error';
      selected = pool.selectType(task);
      lspTools = selected.allowedTools.filter(t => t.startsWith('lsp_'));
      assert.equal(lspTools.length, 0);
    });

    it('setLspStatusGetter replaces the getter', () => {
      const pool = new AgentPool({ maxConcurrency: 1, defaultTimeout: 5000 });
      pool.registerType({ name: 'explore', systemPrompt: 'Explore.', allowedTools: ['read_file'], timeout: 10000 });
      pool.registerType({ name: 'general', systemPrompt: 'General.', allowedTools: ['read_file'], timeout: 30000 });

      const task = createTask('t1', 'Explore the codebase');

      // No getter — no LSP tools
      let selected = pool.selectType(task);
      let lspTools = selected.allowedTools.filter(t => t.startsWith('lsp_'));
      assert.equal(lspTools.length, 0);

      // Set getter to ready
      pool.setLspStatusGetter(() => 'ready');
      selected = pool.selectType(task);
      lspTools = selected.allowedTools.filter(t => t.startsWith('lsp_'));
      assert.ok(lspTools.length > 0);

      // Set getter to non-function resets it
      pool.setLspStatusGetter(null);
      selected = pool.selectType(task);
      lspTools = selected.allowedTools.filter(t => t.startsWith('lsp_'));
      assert.equal(lspTools.length, 0);
    });
  });
});
