'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const {
  updateNodeStatus,
  getNextExecutableNodes,
  printTaskGraph,
} = require('./task-graph.js');

// Memory client — gracefully degrades if memory backend is unavailable
let memoryClient = null
try {
  memoryClient = require('./memory-client.js')
} catch (_) {
  // memory-client.js not available — memory features disabled
}

// Valid states and transitions
const STATES = ['idle', 'running', 'paused', 'completed', 'aborted'];

// Safe-edit workflow instructions injected into implementation agent prompts
// when LSP is ready (Requirements 7.1, 7.2, 7.3)
const SAFE_EDIT_INSTRUCTIONS = `
## LSP Safe-Edit Workflow
Before modifying exported symbols:
1. Check blast radius: call lsp_get_change_impact to see affected files
2. Preview changes: call lsp_simulate_edit_atomic before writing
3. Verify after writing: call lsp_get_diagnostics to check for errors
Follow this workflow for every file modification.`;

class Orchestrator extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.taskGraph - TaskGraph object
   * @param {object} options.agentPool - AgentPool with dispatch(task, context) method
   * @param {string} options.tasksFilePath - Path to Tasks.md for persistence
   * @param {object} [options.lspManager] - LspManager instance for LSP-powered safe-edit injection
   * @param {function} [options.onStatusChange] - Callback(nodeId, status)
   * @param {function} [options.onError] - Callback(nodeId, error)
   * @param {function} [options.onComplete] - Callback()
   */
  constructor(options = {}) {
    super();
    this._graph = options.taskGraph;
    this._agentPool = options.agentPool;
    this._tasksFilePath = options.tasksFilePath || null;
    this._specContext = options.specContext || '';
    this._lspManager = options.lspManager || null;
    this._onStatusChange = options.onStatusChange || null;
    this._onError = options.onError || null;
    this._onComplete = options.onComplete || null;

    this._state = 'idle';
    this._results = new Map(); // nodeId → TaskResult
    this._loopIterations = new Map(); // nodeId → current iteration count
    this._context = {}; // execution context for branch evaluation
  }

  // --- State management ---

  _setState(newState) {
    this._state = newState;
  }

  _updateNodeStatus(nodeId, status, extra = {}) {
    this._graph = updateNodeStatus(this._graph, nodeId, status);
    this.emit('task-status-event', { nodeId, status, ...extra });
    if (this._onStatusChange) {
      this._onStatusChange(nodeId, status);
    }
    this._persist();
  }

  _persist() {
    if (!this._tasksFilePath) return;
    try {
      const md = printTaskGraph(this._graph);
      fs.writeFileSync(this._tasksFilePath, md, 'utf8');
    } catch (err) {
      // Log persistence failure and emit event so renderer can be notified
      console.error('[orchestrator] Persist failed:', err.message);
      this.emit('task-error', { nodeId: '_persist', error: `Failed to save tasks.md: ${err.message}` });
    }
  }

  // --- Execution ---

  /**
   * Start executing the task graph.
   */
  async start() {
    if (this._state !== 'idle' && this._state !== 'paused') return;

    this._setState('running');

    // Reset stale in_progress nodes from a previous interrupted session.
    // When the graph is loaded from a persisted tasks.md, nodes marked [-]
    // come in as 'in_progress' but no agent is actually running them.
    // Without this reset, _runLoop sees _hasInProgressNodes() === true,
    // assumes they're being handled by active dispatches, and breaks out
    // — causing the orchestrator to hang silently.
    this._resetStaleInProgressNodes();

    // ── Memory: archive workflow start ────────────────────────────────────
    if (memoryClient) {
      const graphSummary = {
        nodeCount: this._graph.nodes.size,
        nodes: [...this._graph.nodes.values()].map(n => ({
          id: n.id,
          title: n.title || n.text || n.id,
          status: n.status,
        })),
      }
      memoryClient.archiveRecord('workflow_start', graphSummary, `Workflow started with ${this._graph.nodes.size} tasks`).catch(() => {})
    }

    // Find start node: ^start marker or first root node
    if (this._state === 'running' && !this._hasInProgressNodes()) {
      const startNodeId = this._findStartNodeId();
      if (startNodeId) {
        const startNode = this._graph.nodes.get(startNodeId);
        if (startNode && startNode.status === 'not_started') {
          this._updateNodeStatus(startNodeId, 'in_progress');
          await this._executeNode(startNodeId);
        }
      }
    }

    // Main execution loop
    await this._runLoop();
  }

  /**
   * Reset any in_progress nodes back to not_started.
   * Called on start() to recover from a previous interrupted session where
   * the tasks.md was persisted with [-] nodes that have no active dispatch.
   */
  _resetStaleInProgressNodes() {
    for (const [id, node] of this._graph.nodes) {
      if (node.status === 'in_progress') {
        this._updateNodeStatus(id, 'not_started');
      }
    }
  }

  _findStartNodeId() {
    // Prefer ^start marker
    if (this._graph.startNodeId) return this._graph.startNodeId;
    // Otherwise first root node
    for (const [id, node] of this._graph.nodes) {
      if (node.parent === null) return id;
    }
    return null;
  }

  _hasInProgressNodes() {
    for (const [, node] of this._graph.nodes) {
      if (node.status === 'in_progress') return true;
    }
    return false;
  }

  async _runLoop() {
    while (this._state === 'running') {
      const nextNodes = getNextExecutableNodes(this._graph);

      if (nextNodes.length === 0) {
        // Check if there are in-progress nodes (waiting for completion)
        if (this._hasInProgressNodes()) break;
        // All done
        this._setState('completed');
        if (this._onComplete) this._onComplete();
        this.emit('completed');
        break;
      }

      // Handle special node types and dispatch
      const dispatchable = [];
      for (const node of nextNodes) {
        if (node.markers.branch) {
          await this._handleBranch(node);
        } else if (node.markers.loop) {
          await this._handleLoop(node);
        } else {
          dispatchable.push(node);
        }
      }

      if (this._state !== 'running') break;

      if (dispatchable.length === 0) continue;

      // Dispatch all eligible nodes concurrently
      const promises = dispatchable.map((node) => this._dispatchNode(node));
      await Promise.all(promises);

      if (this._state !== 'running') break;
    }
  }

  async _dispatchNode(node) {
    // Pre-select agent type so the very first in_progress event carries it
    const preSelectedType = this._agentPool?.selectType?.(node);
    const preAgentType = preSelectedType?.name || 'general';
    this._updateNodeStatus(node.id, 'in_progress', { agentType: preAgentType });

    try {
      const startTime = Date.now();

      // ── Memory: pre-dispatch retrieval ───────────────────────────────────
      let specContextWithMemory = this._specContext
      if (memoryClient) {
        try {
          const taskQuery = `${node.title || node.text || node.id} ${node.description || ''}`.trim()
          const memResult = await memoryClient.retrieve(taskQuery, { mode: 'fast', topK: 5 })
          if (memResult && memResult.results && memResult.results.length > 0) {
            const memLines = memResult.results.map(r => `[${r.source}] ${r.content}`).join('\n')
            specContextWithMemory = this._specContext
              ? `${this._specContext}\n\n[Memory Context]\n${memLines}`
              : `[Memory Context]\n${memLines}`
          }
        } catch (_) {
          // Memory retrieval failed — dispatch without memory augmentation
        }
      }

      const task = { ...node, status: 'in_progress', specContext: specContextWithMemory };

      // Inject safe-edit workflow instructions for implementation agents when LSP is ready
      const selectedType = this._agentPool?.selectType?.(node);
      if (selectedType?.name === 'implementation' && this._lspManager?.getStatus().status === 'ready') {
        task.systemPromptSuffix = SAFE_EDIT_INSTRUCTIONS;
      }

      const result = await this._agentPool.dispatch(
        task,
        this._context
      );
      const duration = Date.now() - startTime;
      const agentType = result?.agentType ?? 'general';

      // Attach agent type to the graph node so the renderer can display it
      // (don't re-emit in_progress — that was already emitted by _updateNodeStatus above)
      if (this._graph.nodes.get(node.id)) {
        this._graph.nodes.get(node.id).agentType = agentType;
      }

      const taskResult = {
        nodeId: node.id,
        output: result?.output ?? '',
        duration: result?.duration ?? duration,
        agentType,
        ...(result?.error ? { error: result.error } : {}),
      };

      if (taskResult.error) {
        this._results.set(node.id, taskResult);
        this._handleFailure(node.id, new Error(taskResult.error));
        return;
      }

      this._results.set(node.id, taskResult);
      // ── Memory: archive task completion ──────────────────────────────────
      if (memoryClient) {
        memoryClient.archiveRecord('task_completion', {
          nodeId: node.id,
          title: node.title || node.text || node.id,
          output: (taskResult.output || '').slice(0, 500),
          duration: taskResult.duration,
          agentType: taskResult.agentType,
        }, `Task completed: ${node.title || node.id}`).catch(() => {})
      }
      // Store output in context for branch evaluation
      this._context[node.id] = taskResult.output;
      this._updateNodeStatus(node.id, 'completed', { agentType });
    } catch (err) {
      this._handleFailure(node.id, err);
    }
  }

  async _executeNode(nodeId) {
    const node = this._graph.nodes.get(nodeId);
    if (!node) return;

    try {
      const startTime = Date.now();
      const result = await this._agentPool.dispatch(
        { ...node, specContext: this._specContext },
        this._context
      );
      const duration = Date.now() - startTime;

      const taskResult = {
        nodeId,
        output: result?.output ?? '',
        duration: result?.duration ?? duration,
        agentType: result?.agentType ?? 'general',
        ...(result?.error ? { error: result.error } : {}),
      };

      if (taskResult.error) {
        this._results.set(nodeId, taskResult);
        this._handleFailure(nodeId, new Error(taskResult.error));
        return;
      }

      this._results.set(nodeId, taskResult);
      this._context[nodeId] = taskResult.output;
      this._updateNodeStatus(nodeId, 'completed', { agentType: taskResult.agentType });
    } catch (err) {
      this._handleFailure(nodeId, err);
    }
  }

  _handleFailure(nodeId, error) {
    const errMsg = error.message || String(error);
    const isTransient = /ECONNRESET|ECONNREFUSED|EPIPE|Server not available|server crash|HTTP (500|502|503)|Server returned HTTP|SSE error|server_error/i.test(errMsg);

    // Auto-retry transient errors (server crash, timeout) up to 2 times
    const retryCount = this._retryCount || new Map();
    this._retryCount = retryCount;
    const attempts = retryCount.get(nodeId) || 0;

    if (isTransient && attempts < 2) {
      retryCount.set(nodeId, attempts + 1);
      this.emit('task-error', { nodeId, error: `${errMsg} (retrying ${attempts + 1}/2 after 5s...)` });
      // Wait for server to restart, then retry
      setTimeout(async () => {
        if (this._state !== 'running') return;
        this._updateNodeStatus(nodeId, 'not_started');
        // Re-enter the run loop which will pick up this node
        await this._runLoop();
      }, 5000);
      return;
    }

    this._updateNodeStatus(nodeId, 'failed');
    if (this._onError) this._onError(nodeId, error);
    this.emit('task-error', { nodeId, error: errMsg });
    // Pause execution on failure
    this._setState('paused');
  }

  // --- Branch evaluation ---

  async _handleBranch(node) {
    this._updateNodeStatus(node.id, 'in_progress');

    try {
      // 1. Compute routable tasks and attach to dispatched task for prompt augmentation
      const routableIds = this._getRoutableSiblings(node);
      const routableTasks = routableIds.map(id => {
        const n = this._graph.nodes.get(id);
        return { id, title: n ? n.title : id };
      });

      // 2. Dispatch branch node to agent pool for routing decision
      const result = await this._agentPool.dispatch(
        { ...node, status: 'in_progress', specContext: this._specContext, _routableTasks: routableTasks },
        this._context
      );

      const agentOutput = result?.output ?? '';
      const branchAgentType = result?.agentType ?? 'general';

      // Emit agent type so the renderer can show which agent is working
      this.emit('task-status-event', { nodeId: node.id, status: 'in_progress', agentType: branchAgentType });

      // 3. Parse agent output for a RoutingDecision
      const decision = parseRoutingDecision(agentOutput);

      if (decision) {
        // 3. Validate the routing decision against the task graph
        const validation = validateRoutingDecision(decision, this._graph);

        if (validation.valid) {
          // 4a. Store reason in context if present
          if (decision.reason) {
            this._context[`${node.id}_reason`] = decision.reason;
          }

          // 4b. Apply routing decision (activate targets, skip non-selected siblings)
          this._applyRoutingDecision(node, decision);

          // 4c. Store output in context and mark branch as completed
          this._context[node.id] = agentOutput;
          this._updateNodeStatus(node.id, 'completed');
          return;
        }
      }

      // 5. Invalid/missing routing decision — fall back to _evaluateCondition
      const condition = node.markers.branch;
      const conditionResult = this._evaluateCondition(condition);

      if (conditionResult) {
        this._updateNodeStatus(node.id, 'completed');
        this._context[node.id] = 'true';
      } else {
        this._handleFailure(node.id, new Error(`Branch condition not met: ${condition}`));
      }
    } catch (err) {
      // Dispatch failure — mark branch as failed and pause orchestrator
      this._updateNodeStatus(node.id, 'failed');
      if (this._onError) this._onError(node.id, err);
      this.emit('task-error', { nodeId: node.id, error: err.message || String(err) });
      this._setState('paused');
    }
  }

  /**
   * Evaluate a condition string against the current context.
   * Supports simple truthy checks: if the condition key exists in context and is truthy, returns true.
   */
  _evaluateCondition(condition) {
    if (!condition) return false;
    // Check if the condition is a key in context
    if (condition in this._context) {
      return !!this._context[condition];
    }
    // Try evaluating as a simple boolean expression
    // Support "true"/"false" literals
    if (condition === 'true') return true;
    if (condition === 'false') return false;
    return false;
  }

  // --- Routable siblings ---

  /**
   * Return the list of task IDs that a branch point can route to.
   * These are sibling tasks (same parent, same depth) that come after
   * the branch node in document order, plus direct children of the branch node.
   *
   * @param {object} branchNode - TaskNode with a branch marker
   * @returns {string[]} array of routable task IDs
   */
  _getRoutableSiblings(branchNode) {
    const result = [];
    const orderedIds = this._graph._orderedIds || [...this._graph.nodes.keys()];
    const branchIndex = orderedIds.indexOf(branchNode.id);

    // Collect siblings (same parent, same depth) that come after the branch node
    for (let i = branchIndex + 1; i < orderedIds.length; i++) {
      const node = this._graph.nodes.get(orderedIds[i]);
      if (!node) continue;
      if (node.parent === branchNode.parent && node.depth === branchNode.depth) {
        result.push(node.id);
      }
    }

    // Add direct children of the branch node
    for (const childId of branchNode.children) {
      result.push(childId);
    }

    return result;
  }

  // --- Route application ---

  /**
   * Apply a validated routing decision at a branch point.
   * - Normalizes route to an array
   * - Sets all routed targets to not_started (handles retry of completed tasks too)
   * - Skips all routable siblings not in the route
   *
   * @param {object} branchNode - The branch TaskNode
   * @param {object} decision - Validated RoutingDecision { route: string|string[] }
   */
  _applyRoutingDecision(branchNode, decision) {
    const route = Array.isArray(decision.route) ? decision.route : [decision.route];
    const routeSet = new Set(route);
    const siblings = this._getRoutableSiblings(branchNode);

    // Activate all routed targets (reset to not_started regardless of current status)
    for (const targetId of route) {
      this._updateNodeStatus(targetId, 'not_started');
    }

    // Skip siblings not in the route
    for (const siblingId of siblings) {
      if (!routeSet.has(siblingId)) {
        this._updateNodeStatus(siblingId, 'skipped');
      }
    }
  }

  // --- Loop handling ---

  async _handleLoop(node) {
    const loopConfig = node.markers.loop;
    if (!loopConfig) return;

    const { target, maxIterations } = loopConfig;

    // Mark loop node as in_progress
    this._updateNodeStatus(node.id, 'in_progress');

    // Initialize iteration count if not set
    if (!this._loopIterations.has(node.id)) {
      this._loopIterations.set(node.id, 0);
    }

    // Execute the loop iterations inline
    while (this._state === 'running') {
      const currentIter = this._loopIterations.get(node.id);
      if (currentIter >= maxIterations) break;

      this._loopIterations.set(node.id, currentIter + 1);

      // Reset target node to not_started and re-execute it
      this._updateNodeStatus(target, 'not_started');

      const targetNode = this._graph.nodes.get(target);
      if (targetNode) {
        await this._dispatchNode({ ...targetNode, status: 'not_started' });
      }

      if (this._state !== 'running') return;
    }

    // Max iterations reached — advance past the loop
    this._updateNodeStatus(node.id, 'completed');
  }

  // --- Control methods ---

  async pause() {
    if (this._state === 'running') {
      this._setState('paused');
    }
  }

  async resume() {
    if (this._state === 'paused') {
      this._setState('running');
      await this._runLoop();
    }
  }

  async retry(nodeId) {
    const node = this._graph.nodes.get(nodeId);
    if (!node || node.status !== 'failed') return;

    this._updateNodeStatus(nodeId, 'not_started');
    if (this._state === 'paused') {
      this._setState('running');
      await this._runLoop();
    }
  }

  async skip(nodeId) {
    const node = this._graph.nodes.get(nodeId);
    if (!node || node.status !== 'failed') return;

    this._updateNodeStatus(nodeId, 'completed');
    if (this._state === 'paused') {
      this._setState('running');
      await this._runLoop();
    }
  }

  async abort() {
    this._setState('aborted');
  }

  // --- Query methods ---

  getStatus() {
    return {
      state: this._state,
      graph: this._graph,
    };
  }

  getNodeResult(nodeId) {
    return this._results.get(nodeId) || null;
  }
}

/**
 * Parse a RoutingDecision JSON object from agent output text.
 * Searches for JSON-like blocks containing a `route` key.
 * Returns the first valid RoutingDecision or null.
 *
 * @param {string} agentOutput - Raw agent output text
 * @returns {{ route: string | string[], reason?: string } | null}
 */
function parseRoutingDecision(agentOutput) {
  if (!agentOutput || typeof agentOutput !== 'string') return null;

  // Match JSON-like blocks: { ... }
  const jsonPattern = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
  let match;

  while ((match = jsonPattern.exec(agentOutput)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed !== null && typeof parsed === 'object' && 'route' in parsed) {
        const route = parsed.route;
        // Validate route is a non-empty string or non-empty array of strings
        if (typeof route === 'string' && route.length > 0) {
          const result = { route };
          if (typeof parsed.reason === 'string') {
            result.reason = parsed.reason;
          }
          return result;
        }
        if (Array.isArray(route) && route.length > 0 && route.every(r => typeof r === 'string' && r.length > 0)) {
          const result = { route };
          if (typeof parsed.reason === 'string') {
            result.reason = parsed.reason;
          }
          return result;
        }
      }
    } catch (_err) {
      // JSON.parse failed — try next candidate
    }
  }

  return null;
}

/**
 * Validate a RoutingDecision against a task graph.
 * Checks that the route is non-empty and all task IDs exist in graph.nodes.
 *
 * @param {object|null|undefined} decision - RoutingDecision object
 * @param {object} graph - TaskGraph with a `nodes` Map
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateRoutingDecision(decision, graph) {
  const errors = [];

  if (!decision || typeof decision !== 'object') {
    return { valid: false, errors: ['Routing decision is null or undefined'] };
  }

  const { route } = decision;

  if (typeof route === 'string') {
    if (route === '') {
      errors.push('Route is an empty string');
    } else if (!graph.nodes.has(route)) {
      errors.push(`Task ID '${route}' not found in graph`);
    }
  } else if (Array.isArray(route)) {
    if (route.length === 0) {
      errors.push('Route is an empty array');
    } else {
      for (const id of route) {
        if (!graph.nodes.has(id)) {
          errors.push(`Task ID '${id}' not found in graph`);
        }
      }
    }
  } else {
    errors.push('Route must be a string or array of strings');
  }

  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}

module.exports = { Orchestrator, parseRoutingDecision, validateRoutingDecision, SAFE_EDIT_INSTRUCTIONS };
