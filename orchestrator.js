'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const {
  updateNodeStatus,
  getNextExecutableNodes,
  printTaskGraph,
} = require('./task-graph.js');

// Valid states and transitions
const STATES = ['idle', 'running', 'paused', 'completed', 'aborted'];

class Orchestrator extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.taskGraph - TaskGraph object
   * @param {object} options.agentPool - AgentPool with dispatch(task, context) method
   * @param {string} options.tasksFilePath - Path to Tasks.md for persistence
   * @param {function} [options.onStatusChange] - Callback(nodeId, status)
   * @param {function} [options.onError] - Callback(nodeId, error)
   * @param {function} [options.onComplete] - Callback()
   */
  constructor(options = {}) {
    super();
    this._graph = options.taskGraph;
    this._agentPool = options.agentPool;
    this._tasksFilePath = options.tasksFilePath || null;
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

  _updateNodeStatus(nodeId, status) {
    this._graph = updateNodeStatus(this._graph, nodeId, status);
    this.emit('task-status-event', { nodeId, status });
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
    } catch (_err) {
      // Persistence failure: log and continue (per design doc error handling)
    }
  }

  // --- Execution ---

  /**
   * Start executing the task graph.
   */
  async start() {
    if (this._state !== 'idle' && this._state !== 'paused') return;

    this._setState('running');

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
    this._updateNodeStatus(node.id, 'in_progress');

    try {
      const startTime = Date.now();
      const result = await this._agentPool.dispatch(
        { ...node, status: 'in_progress' },
        this._context
      );
      const duration = Date.now() - startTime;

      const taskResult = {
        nodeId: node.id,
        output: result?.output ?? '',
        duration: result?.duration ?? duration,
        agentType: result?.agentType ?? 'general',
        ...(result?.error ? { error: result.error } : {}),
      };

      if (taskResult.error) {
        this._results.set(node.id, taskResult);
        this._handleFailure(node.id, new Error(taskResult.error));
        return;
      }

      this._results.set(node.id, taskResult);
      // Store output in context for branch evaluation
      this._context[node.id] = taskResult.output;
      this._updateNodeStatus(node.id, 'completed');
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
        { ...node },
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
      this._updateNodeStatus(nodeId, 'completed');
    } catch (err) {
      this._handleFailure(nodeId, err);
    }
  }

  _handleFailure(nodeId, error) {
    this._updateNodeStatus(nodeId, 'failed');
    if (this._onError) this._onError(nodeId, error);
    this.emit('task-error', { nodeId, error: error.message || String(error) });
    // Pause execution on failure
    this._setState('paused');
  }

  // --- Branch evaluation ---

  async _handleBranch(node) {
    this._updateNodeStatus(node.id, 'in_progress');

    try {
      const condition = node.markers.branch;
      const result = this._evaluateCondition(condition);

      if (result) {
        // Branch condition met — mark as completed and continue
        this._updateNodeStatus(node.id, 'completed');
        this._context[node.id] = 'true';
      } else {
        // No match — treat as failure
        this._handleFailure(node.id, new Error(`Branch condition not met: ${condition}`));
      }
    } catch (err) {
      this._handleFailure(node.id, err);
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

module.exports = { Orchestrator };
