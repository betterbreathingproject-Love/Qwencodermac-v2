'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

// --- Constants ---

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_TIMEOUT = 300000; // 5 minutes

/**
 * Category keywords used to match task titles/metadata to subagent types.
 * Each key is a subagent type name, value is an array of keywords.
 */
const CATEGORY_KEYWORDS = {
  'code-search': ['search', 'find', 'grep', 'locate', 'lookup', 'ast', 'query'],
  'requirements': ['requirement', 'requirements', 'spec', 'specification', 'user story', 'acceptance'],
  'design': ['design', 'architecture', 'diagram', 'interface', 'schema', 'model'],
  'implementation': ['implement', 'code', 'build', 'create', 'write', 'develop', 'refactor', 'fix', 'bug'],
};

// --- AgentPool ---

class AgentPool extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} [options.maxConcurrency=3]
   * @param {number} [options.defaultTimeout=300000]
   * @param {function} [options.agentFactory] - Optional factory for creating agents (for DI/testing)
   */
  constructor(options = {}) {
    super();
    this._maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this._defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT;
    this._agentFactory = options.agentFactory || null;

    // Subagent type registry: Map<name, SubagentType>
    this._types = new Map();

    // Semaphore-based concurrency control
    this._activeCount = 0;
    this._waitQueue = []; // Array of { resolve } for queued dispatches

    // Running foreground tasks: Map<taskId, { task, startTime, abortController }>
    this._runningTasks = new Map();

    // Background tasks: Map<taskId, BackgroundTask>
    this._backgroundTasks = new Map();
  }

  // --- Type Registry ---

  /**
   * Register a SubagentType config.
   * @param {object} type - { name, systemPrompt, allowedTools, timeout, maxConcurrent }
   */
  registerType(type) {
    if (!type || !type.name) {
      throw new Error('SubagentType must have a name');
    }
    this._types.set(type.name, {
      name: type.name,
      systemPrompt: type.systemPrompt || '',
      allowedTools: type.allowedTools || [],
      timeout: type.timeout ?? this._defaultTimeout,
      maxConcurrent: type.maxConcurrent ?? this._maxConcurrency,
    });
  }

  // --- Type Selection ---

  /**
   * Select the best subagent type for a task based on category keywords in title/metadata.
   * @param {object} task - TaskNode
   * @returns {object|null} SubagentType config or null
   */
  selectType(task) {
    if (!task) return this._types.get('general') || null;

    // Check explicit metadata category first
    const explicitCategory = task.metadata?.category || task.metadata?.agentType;
    if (explicitCategory && this._types.has(explicitCategory)) {
      return this._types.get(explicitCategory);
    }

    // Match keywords in title
    const titleLower = (task.title || '').toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const [typeName, typeConfig] of this._types) {
      const keywords = CATEGORY_KEYWORDS[typeName];
      if (!keywords) continue;

      let score = 0;
      for (const kw of keywords) {
        if (titleLower.includes(kw)) {
          score++;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = typeConfig;
      }
    }

    // Fall back to 'general' type if no keyword match
    if (!bestMatch) {
      bestMatch = this._types.get('general') || null;
    }

    return bestMatch;
  }

  // --- Semaphore ---

  /**
   * Acquire a semaphore slot. Resolves when a slot is available.
   * @returns {Promise<void>}
   */
  async _acquireSlot() {
    if (this._activeCount < this._maxConcurrency) {
      this._activeCount++;
      return;
    }
    // Wait for a slot to open
    return new Promise((resolve) => {
      this._waitQueue.push({ resolve });
    });
  }

  /**
   * Release a semaphore slot. Wakes up the next queued dispatch if any.
   */
  _releaseSlot() {
    if (this._waitQueue.length > 0) {
      const next = this._waitQueue.shift();
      // Don't decrement — the slot transfers to the next waiter
      next.resolve();
    } else {
      this._activeCount--;
    }
  }

  // --- Dispatch (foreground) ---

  /**
   * Dispatch a task to a subagent. Acquires a semaphore slot, runs the agent,
   * and returns the TaskResult.
   * @param {object} task - TaskNode
   * @param {object} context - TaskContext
   * @param {object} [options] - { agentFactory } for DI override
   * @returns {Promise<object>} TaskResult
   */
  async dispatch(task, context, options = {}) {
    const agentType = this.selectType(task);
    const timeout = agentType?.timeout ?? this._defaultTimeout;
    const taskId = task.id || crypto.randomUUID();

    await this._acquireSlot();

    const abortController = new AbortController();
    this._runningTasks.set(taskId, {
      task,
      startTime: Date.now(),
      abortController,
      agentType: agentType?.name || 'general',
    });

    try {
      const result = await this._runAgent(task, context, agentType, timeout, abortController, options);
      return result;
    } finally {
      this._runningTasks.delete(taskId);
      this._releaseSlot();
    }
  }

  /**
   * Run an agent with timeout handling.
   */
  async _runAgent(task, context, agentType, timeout, abortController, options = {}) {
    const factory = options.agentFactory || this._agentFactory;
    const startTime = Date.now();

    // Create the agent via factory or default
    const agent = factory
      ? factory(task, agentType, context)
      : this._createDefaultAgent(task, agentType, context);

    // Race between agent execution and timeout
    const timeoutPromise = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Task ${task.id} timed out after ${timeout}ms`));
      }, timeout);

      // Clean up timer if abort is signaled
      abortController.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

      // Store timer ref for cleanup
      abortController._timer = timer;
    });

    try {
      const result = await Promise.race([
        this._executeAgent(agent, task, agentType, startTime),
        timeoutPromise,
      ]);
      // Clear timeout timer
      if (abortController._timer) clearTimeout(abortController._timer);
      return result;
    } catch (err) {
      if (abortController._timer) clearTimeout(abortController._timer);

      // Terminate agent on timeout or error
      if (agent && typeof agent.interrupt === 'function') {
        try { await agent.interrupt(); } catch (_) { /* ignore */ }
      }

      if (err.message && err.message.includes('timed out')) {
        return {
          nodeId: task.id,
          output: '',
          duration: Date.now() - startTime,
          agentType: agentType?.name || 'general',
          error: err.message,
        };
      }
      throw err;
    }
  }

  /**
   * Execute an agent and collect results, forwarding streaming events.
   */
  async _executeAgent(agent, task, agentType, startTime) {
    // If agent is a simple function (mock), call it directly
    if (typeof agent === 'function') {
      const output = await agent();
      return {
        nodeId: task.id,
        output: output || '',
        duration: Date.now() - startTime,
        agentType: agentType?.name || 'general',
      };
    }

    // If agent has a run method (QwenBridge-like)
    if (agent && typeof agent.run === 'function') {
      // Set up event forwarding
      if (agent.on) {
        agent.on('event', (evt) => {
          this.emit('agent-event', {
            taskId: task.id,
            ...evt,
          });
        });
      }

      const result = await agent.run({
        prompt: task.title,
        cwd: task.cwd || process.cwd(),
      });

      return {
        nodeId: task.id,
        output: result?.output || result || '',
        duration: Date.now() - startTime,
        agentType: agentType?.name || 'general',
      };
    }

    // If agent is a promise (simplest mock pattern)
    if (agent && typeof agent.then === 'function') {
      const output = await agent;
      return {
        nodeId: task.id,
        output: output || '',
        duration: Date.now() - startTime,
        agentType: agentType?.name || 'general',
      };
    }

    return {
      nodeId: task.id,
      output: '',
      duration: Date.now() - startTime,
      agentType: agentType?.name || 'general',
    };
  }

  /**
   * Default agent creation (placeholder — real impl would use QwenBridge).
   */
  _createDefaultAgent(task, agentType, context) {
    // In production, this would create a QwenBridge with CallbackSink
    return async () => `Executed: ${task.title}`;
  }

  // --- Background Dispatch ---

  /**
   * Dispatch a task to run in the background.
   * Returns the task ID immediately. The task runs asynchronously.
   * @param {object} task - TaskNode
   * @param {object} context - TaskContext
   * @param {object} [options] - { agentFactory } for DI override
   * @returns {Promise<string>} taskId
   */
  async dispatchBackground(task, context, options = {}) {
    const taskId = `bg-${crypto.randomUUID()}`;
    const agentType = this.selectType(task);

    const bgTask = {
      id: taskId,
      taskNode: task,
      status: 'running',
      startTime: Date.now(),
      endTime: undefined,
      output: undefined,
      events: [],
      _abortController: new AbortController(),
    };

    this._backgroundTasks.set(taskId, bgTask);
    this.emit('bg-task-event', { taskId, type: 'started', task });

    // Run in background (don't await)
    this._runBackgroundTask(taskId, task, context, agentType, options).catch((err) => {
      const bt = this._backgroundTasks.get(taskId);
      if (bt && bt.status === 'running') {
        bt.status = 'failed';
        bt.endTime = Date.now();
        bt.output = err.message || String(err);
        this.emit('bg-task-event', { taskId, type: 'failed', error: bt.output });
      }
    });

    return taskId;
  }

  /**
   * Internal: run a background task.
   */
  async _runBackgroundTask(taskId, task, context, agentType, options = {}) {
    const bgTask = this._backgroundTasks.get(taskId);
    if (!bgTask) return;

    const factory = options.agentFactory || this._agentFactory;
    const startTime = bgTask.startTime;

    try {
      const agent = factory
        ? factory(task, agentType, context)
        : this._createDefaultAgent(task, agentType, context);

      // Buffer events
      const eventHandler = (evt) => {
        bgTask.events.push(evt);
        this.emit('bg-task-event', { taskId, type: 'event', event: evt });
      };

      if (agent && typeof agent.on === 'function') {
        agent.on('event', eventHandler);
      }

      let output;
      if (typeof agent === 'function') {
        output = await agent();
      } else if (agent && typeof agent.run === 'function') {
        const result = await agent.run({ prompt: task.title, cwd: task.cwd || process.cwd() });
        output = result?.output || result || '';
      } else if (agent && typeof agent.then === 'function') {
        output = await agent;
      } else {
        output = '';
      }

      // Check if cancelled while running
      if (bgTask.status === 'cancelled') return;

      bgTask.status = 'completed';
      bgTask.endTime = Date.now();
      bgTask.output = output || '';
      this.emit('bg-task-event', { taskId, type: 'completed', output: bgTask.output });
    } catch (err) {
      if (bgTask.status === 'cancelled') return;
      bgTask.status = 'failed';
      bgTask.endTime = Date.now();
      bgTask.output = err.message || String(err);
      this.emit('bg-task-event', { taskId, type: 'failed', error: bgTask.output });
    }
  }

  // --- Cancel ---

  /**
   * Cancel a background task.
   * @param {string} taskId
   */
  async cancel(taskId) {
    const bgTask = this._backgroundTasks.get(taskId);
    if (!bgTask || bgTask.status !== 'running') return;

    bgTask.status = 'cancelled';
    bgTask.endTime = Date.now();

    if (bgTask._abortController) {
      bgTask._abortController.abort();
    }

    this.emit('bg-task-event', { taskId, type: 'cancelled' });
  }

  // --- Query Methods ---

  /**
   * Get all currently running foreground tasks.
   * @returns {object[]}
   */
  getRunningTasks() {
    const result = [];
    for (const [taskId, info] of this._runningTasks) {
      result.push({
        taskId,
        task: info.task,
        startTime: info.startTime,
        agentType: info.agentType,
      });
    }
    return result;
  }

  /**
   * Get all background tasks.
   * @returns {object[]}
   */
  getBackgroundTasks() {
    const result = [];
    for (const [, bt] of this._backgroundTasks) {
      result.push({
        id: bt.id,
        taskNode: bt.taskNode,
        status: bt.status,
        startTime: bt.startTime,
        endTime: bt.endTime,
        output: bt.output,
        events: bt.events,
      });
    }
    return result;
  }

  /**
   * Shut down the agent pool. Cancel all background tasks and release resources.
   */
  async shutdown() {
    // Cancel all running background tasks
    for (const [taskId, bt] of this._backgroundTasks) {
      if (bt.status === 'running') {
        await this.cancel(taskId);
      }
    }

    // Abort all running foreground tasks
    for (const [, info] of this._runningTasks) {
      if (info.abortController) {
        info.abortController.abort();
      }
    }

    // Clear wait queue
    for (const waiter of this._waitQueue) {
      // Reject waiters? No — just resolve them so they can exit gracefully
      waiter.resolve();
    }
    this._waitQueue = [];
    this._activeCount = 0;
  }
}

// --- Exports ---

module.exports = {
  AgentPool,
  CATEGORY_KEYWORDS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_TIMEOUT,
};
