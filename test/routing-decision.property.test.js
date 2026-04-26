'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { parseRoutingDecision, validateRoutingDecision } = require('../orchestrator');

// --- Generators ---

/**
 * Generate a non-empty alphanumeric string suitable for a task ID.
 */
function arbitraryTaskId() {
  return fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,19}$/);
}

/**
 * Generate surrounding text that won't accidentally form valid JSON with a `route` key.
 * Uses simple words and whitespace.
 */
function arbitrarySurroundingText() {
  return fc.array(
    fc.constantFrom(
      'The agent said', 'Here is the result:', 'Based on analysis,',
      'I recommend', 'Output follows.', 'Done.\n', 'Step complete.',
      'Processing...', 'Note:', 'Summary below.', '\n', ' ', ''
    ),
    { minLength: 0, maxLength: 5 }
  ).map(parts => parts.join(' '));
}

/**
 * Generate a reason string that avoids curly braces (which break the
 * regex-based JSON extraction in parseRoutingDecision).
 */
function arbitraryReasonText() {
  return fc.stringMatching(/^[a-zA-Z0-9 .,!?:;\-_]+$/, { minLength: 1, maxLength: 50 });
}

// --- Property Tests ---

describe('Property-based tests for routing decision parsing', () => {
  // Property 1: Routing decision extraction from embedded text
  // **Validates: Requirements 1.1, 1.2, 4.1**
  it('Property 1: extracts single string route from embedded text', () => {
    fc.assert(
      fc.property(
        arbitraryTaskId(),
        arbitrarySurroundingText(),
        arbitrarySurroundingText(),
        (route, prefix, suffix) => {
          const json = JSON.stringify({ route });
          const agentOutput = `${prefix}${json}${suffix}`;

          const result = parseRoutingDecision(agentOutput);

          assert.notEqual(result, null, 'Should extract a routing decision');
          assert.equal(result.route, route, 'Extracted route should match embedded route');
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 1.1, 1.2, 4.1**
  it('Property 1: extracts array route from embedded text', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryTaskId(), { minLength: 1, maxLength: 5 }),
        arbitrarySurroundingText(),
        arbitrarySurroundingText(),
        (route, prefix, suffix) => {
          const json = JSON.stringify({ route });
          const agentOutput = `${prefix}${json}${suffix}`;

          const result = parseRoutingDecision(agentOutput);

          assert.notEqual(result, null, 'Should extract a routing decision');
          assert.deepStrictEqual(result.route, route, 'Extracted route array should match');
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 1.1, 1.2, 4.1**
  it('Property 1: extracts route with optional reason field', () => {
    fc.assert(
      fc.property(
        arbitraryTaskId(),
        arbitraryReasonText(),
        arbitrarySurroundingText(),
        arbitrarySurroundingText(),
        (route, reason, prefix, suffix) => {
          const json = JSON.stringify({ route, reason });
          const agentOutput = `${prefix}${json}${suffix}`;

          const result = parseRoutingDecision(agentOutput);

          assert.notEqual(result, null, 'Should extract a routing decision');
          assert.equal(result.route, route, 'Extracted route should match');
          assert.equal(result.reason, reason, 'Extracted reason should match');
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 1.1, 1.2, 4.1**
  it('Property 1: extracts array route with optional reason field', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryTaskId(), { minLength: 1, maxLength: 5 }),
        arbitraryReasonText(),
        arbitrarySurroundingText(),
        arbitrarySurroundingText(),
        (route, reason, prefix, suffix) => {
          const json = JSON.stringify({ route, reason });
          const agentOutput = `${prefix}${json}${suffix}`;

          const result = parseRoutingDecision(agentOutput);

          assert.notEqual(result, null, 'Should extract a routing decision');
          assert.deepStrictEqual(result.route, route, 'Extracted route array should match');
          assert.equal(result.reason, reason, 'Extracted reason should match');
        }
      ),
      { numRuns: 150 }
    );
  });
});

// --- Property 2: Invalid input yields null ---

describe('Property 2: Invalid input yields null', () => {
  // **Validates: Requirements 1.4, 4.5**
  it('returns null for random strings without valid JSON route objects', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        (input) => {
          // Skip inputs that accidentally contain a valid JSON object with a route key
          try {
            const jsonPattern = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
            let m;
            while ((m = jsonPattern.exec(input)) !== null) {
              const parsed = JSON.parse(m[0]);
              if (parsed && typeof parsed === 'object' && 'route' in parsed) {
                const r = parsed.route;
                if (typeof r === 'string' && r.length > 0) return; // skip — valid input
                if (Array.isArray(r) && r.length > 0 && r.every(x => typeof x === 'string' && x.length > 0)) return;
              }
            }
          } catch (_) {
            // parse failed — input is definitely invalid, continue
          }

          const result = parseRoutingDecision(input);
          assert.equal(result, null, `Expected null for input: ${JSON.stringify(input)}`);
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 1.4, 4.5**
  it('returns null for JSON objects without a route key', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 20 }),
          value: fc.oneof(fc.integer(), fc.string(), fc.boolean()),
        }),
        (obj) => {
          // Ensure no 'route' key
          delete obj.route;
          const input = JSON.stringify(obj);
          const result = parseRoutingDecision(input);
          assert.equal(result, null, `Expected null for JSON without route: ${input}`);
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 1.4, 4.5**
  it('returns null for malformed JSON strings (no extractable route)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // JSON missing closing brace entirely (remove all closing braces)
          fc.record({
            route: fc.string({ minLength: 1, maxLength: 20 }),
          }).map(obj => JSON.stringify(obj).replace(/\}/g, '')),
          // Just an opening brace with the key but no valid JSON structure
          fc.stringMatching(/^[a-zA-Z0-9 ]{1,20}$/).map(s => `{ "route": ${s} }`),
          // Truncated to just the opening portion (before the value)
          fc.record({
            route: fc.string({ minLength: 1, maxLength: 20 }),
          }).map(obj => {
            const s = JSON.stringify(obj);
            // Cut before the colon so no valid JSON can be extracted
            const colonIdx = s.indexOf(':');
            return colonIdx > 0 ? s.slice(0, colonIdx) : s.slice(0, 1);
          })
        ),
        (malformed) => {
          const result = parseRoutingDecision(malformed);
          assert.equal(result, null, `Expected null for malformed JSON: ${malformed}`);
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 1.4, 4.5**
  it('returns null for empty string input', () => {
    const result = parseRoutingDecision('');
    assert.equal(result, null, 'Expected null for empty string');
  });

  // **Validates: Requirements 1.4, 4.5**
  it('returns null for non-string inputs (null, undefined, numbers)', () => {
    assert.equal(parseRoutingDecision(null), null, 'Expected null for null input');
    assert.equal(parseRoutingDecision(undefined), null, 'Expected null for undefined input');
    assert.equal(parseRoutingDecision(42), null, 'Expected null for number input');
    assert.equal(parseRoutingDecision(true), null, 'Expected null for boolean input');
    assert.equal(parseRoutingDecision({}), null, 'Expected null for object input');
    assert.equal(parseRoutingDecision([]), null, 'Expected null for array input');
  });

  // **Validates: Requirements 1.4, 4.5**
  it('returns null for JSON with empty string route', () => {
    fc.assert(
      fc.property(
        arbitrarySurroundingText(),
        arbitrarySurroundingText(),
        (prefix, suffix) => {
          const json = JSON.stringify({ route: '' });
          const input = `${prefix}${json}${suffix}`;
          const result = parseRoutingDecision(input);
          assert.equal(result, null, `Expected null for empty route: ${input}`);
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 1.4, 4.5**
  it('returns null for JSON with empty array route', () => {
    fc.assert(
      fc.property(
        arbitrarySurroundingText(),
        arbitrarySurroundingText(),
        (prefix, suffix) => {
          const json = JSON.stringify({ route: [] });
          const input = `${prefix}${json}${suffix}`;
          const result = parseRoutingDecision(input);
          assert.equal(result, null, `Expected null for empty array route: ${input}`);
        }
      ),
      { numRuns: 150 }
    );
  });
});


// --- Property 3: Route validation accepts existing IDs and rejects missing IDs ---

describe('Property 3: Route validation accepts existing IDs and rejects missing IDs', () => {
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

  // **Validates: Requirements 2.3, 4.2, 4.3, 4.4**
  it('single string route with existing ID is valid', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbitraryTaskId(), { minLength: 1, maxLength: 10 }),
        (taskIds) => {
          const graph = buildGraph(taskIds);
          // Pick one existing ID as the route
          const route = taskIds[0];
          const decision = { route };

          const result = validateRoutingDecision(decision, graph);

          assert.equal(result.valid, true, `Expected valid for existing ID '${route}'`);
          assert.deepStrictEqual(result.errors, []);
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 2.3, 4.2, 4.3, 4.4**
  it('array route where all IDs exist is valid', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbitraryTaskId(), { minLength: 1, maxLength: 10 }),
        (taskIds) => {
          const graph = buildGraph(taskIds);
          // Use all IDs as the route (fan-out)
          const decision = { route: [...taskIds] };

          const result = validateRoutingDecision(decision, graph);

          assert.equal(result.valid, true, `Expected valid for all existing IDs`);
          assert.deepStrictEqual(result.errors, []);
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 2.3, 4.2, 4.3, 4.4**
  it('single string route with missing ID is invalid', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbitraryTaskId(), { minLength: 1, maxLength: 10 }),
        arbitraryTaskId(),
        (taskIds, missingId) => {
          // Ensure missingId is not in the graph
          const filteredIds = taskIds.filter(id => id !== missingId);
          if (filteredIds.length === 0) return; // skip degenerate case
          const graph = buildGraph(filteredIds);
          const decision = { route: missingId };

          const result = validateRoutingDecision(decision, graph);

          assert.equal(result.valid, false, `Expected invalid for missing ID '${missingId}'`);
          assert.ok(result.errors.length > 0, 'Expected at least one error');
          assert.ok(
            result.errors.some(e => e.includes(missingId)),
            `Expected error to mention missing ID '${missingId}'`
          );
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 2.3, 4.2, 4.3, 4.4**
  it('array route where some IDs are missing is invalid', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbitraryTaskId(), { minLength: 1, maxLength: 5 }),
        fc.uniqueArray(arbitraryTaskId(), { minLength: 1, maxLength: 5 }),
        (existingIds, candidateMissingIds) => {
          // Filter out any overlap so missingIds are truly absent
          const missingIds = candidateMissingIds.filter(id => !existingIds.includes(id));
          if (missingIds.length === 0) return; // skip if no truly missing IDs

          const graph = buildGraph(existingIds);
          // Mix existing and missing IDs in the route
          const route = [...existingIds.slice(0, 1), ...missingIds];
          const decision = { route };

          const result = validateRoutingDecision(decision, graph);

          assert.equal(result.valid, false, 'Expected invalid when some IDs are missing');
          assert.ok(result.errors.length > 0, 'Expected at least one error');
          // Each missing ID should appear in an error
          for (const id of missingIds) {
            assert.ok(
              result.errors.some(e => e.includes(id)),
              `Expected error to mention missing ID '${id}'`
            );
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 2.3, 4.2, 4.3, 4.4**
  it('empty string route is invalid', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbitraryTaskId(), { minLength: 0, maxLength: 5 }),
        (taskIds) => {
          const graph = buildGraph(taskIds);
          const decision = { route: '' };

          const result = validateRoutingDecision(decision, graph);

          assert.equal(result.valid, false, 'Expected invalid for empty string route');
          assert.ok(result.errors.length > 0, 'Expected at least one error');
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 2.3, 4.2, 4.3, 4.4**
  it('empty array route is invalid', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbitraryTaskId(), { minLength: 0, maxLength: 5 }),
        (taskIds) => {
          const graph = buildGraph(taskIds);
          const decision = { route: [] };

          const result = validateRoutingDecision(decision, graph);

          assert.equal(result.valid, false, 'Expected invalid for empty array route');
          assert.ok(result.errors.length > 0, 'Expected at least one error');
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 2.3, 4.2, 4.3, 4.4**
  it('null or undefined decision is invalid', () => {
    const graph = buildGraph(['task-1', 'task-2']);

    const nullResult = validateRoutingDecision(null, graph);
    assert.equal(nullResult.valid, false, 'Expected invalid for null decision');
    assert.ok(nullResult.errors.length > 0);

    const undefinedResult = validateRoutingDecision(undefined, graph);
    assert.equal(undefinedResult.valid, false, 'Expected invalid for undefined decision');
    assert.ok(undefinedResult.errors.length > 0);
  });
});


// --- Property 4: Route application activates all target tasks ---

describe('Property 4: Route application activates all target tasks', () => {
  const { Orchestrator } = require('../orchestrator');
  const { createTaskNode, createTaskGraph } = require('../task-graph');

  /**
   * Generate a set of unique sibling task IDs (at least 3).
   */
  function arbitrarySiblingIds() {
    return fc.uniqueArray(
      fc.stringMatching(/^[a-z][a-z0-9]{1,9}$/),
      { minLength: 3, maxLength: 8 }
    );
  }

  /**
   * Build a mock graph with a branch node and sibling tasks at the same depth/parent.
   * Returns { graph, branchNode, siblingIds }.
   */
  function buildBranchGraph(siblingIds) {
    const graph = createTaskGraph();
    const orderedIds = [];

    // Branch node
    const branchNode = createTaskNode({
      id: 'branch',
      title: 'Branch point',
      depth: 0,
      parent: null,
      markers: { start: false, branch: 'condition', terminal: false, loop: null },
    });
    graph.nodes.set('branch', branchNode);
    orderedIds.push('branch');

    // Sibling tasks (same parent=null, same depth=0, after branch in order)
    for (const id of siblingIds) {
      const node = createTaskNode({
        id,
        title: `Task ${id}`,
        depth: 0,
        parent: null,
        status: 'not_started',
      });
      graph.nodes.set(id, node);
      orderedIds.push(id);
    }

    graph._orderedIds = orderedIds;
    return { graph, branchNode };
  }

  /**
   * Create a minimal mock pool (never actually called in these tests).
   */
  function createNoopPool() {
    return { async dispatch() { return { output: '', duration: 0, agentType: 'general' }; } };
  }

  // **Validates: Requirements 2.1, 2.2, 2.4**
  it('single string route sets target to not_started', () => {
    fc.assert(
      fc.property(
        arbitrarySiblingIds(),
        (siblingIds) => {
          const { graph, branchNode } = buildBranchGraph(siblingIds);
          const pool = createNoopPool();
          const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

          // Pick one sibling as the route target
          const target = siblingIds[0];
          const decision = { route: target };

          orch._applyRoutingDecision(branchNode, decision);

          const updatedGraph = orch.getStatus().graph;
          assert.equal(
            updatedGraph.nodes.get(target).status,
            'not_started',
            `Target '${target}' should be not_started after route application`
          );
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 2.1, 2.2, 2.4**
  it('array route sets all targets to not_started', () => {
    fc.assert(
      fc.property(
        arbitrarySiblingIds(),
        fc.integer({ min: 1 }),
        (siblingIds, seed) => {
          const { graph, branchNode } = buildBranchGraph(siblingIds);
          const pool = createNoopPool();
          const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

          // Select a non-empty subset of siblings as route targets
          const subsetSize = (seed % siblingIds.length) + 1;
          const targets = siblingIds.slice(0, subsetSize);
          const decision = { route: targets };

          orch._applyRoutingDecision(branchNode, decision);

          const updatedGraph = orch.getStatus().graph;
          for (const targetId of targets) {
            assert.equal(
              updatedGraph.nodes.get(targetId).status,
              'not_started',
              `Target '${targetId}' should be not_started after fan-out route application`
            );
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 2.1, 2.2, 2.4**
  it('route application resets completed tasks to not_started (retry)', () => {
    fc.assert(
      fc.property(
        arbitrarySiblingIds(),
        (siblingIds) => {
          const { graph, branchNode } = buildBranchGraph(siblingIds);

          // Set some siblings to 'completed' before applying the route
          for (const id of siblingIds) {
            graph.nodes.get(id).status = 'completed';
          }

          const pool = createNoopPool();
          const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

          // Route to all siblings (all were completed, should be reset)
          const decision = { route: [...siblingIds] };

          orch._applyRoutingDecision(branchNode, decision);

          const updatedGraph = orch.getStatus().graph;
          for (const targetId of siblingIds) {
            assert.equal(
              updatedGraph.nodes.get(targetId).status,
              'not_started',
              `Previously completed target '${targetId}' should be reset to not_started`
            );
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 2.1, 2.2, 2.4**
  it('route application resets mixed-status tasks to not_started', () => {
    const statuses = ['not_started', 'completed', 'skipped', 'failed', 'in_progress'];

    fc.assert(
      fc.property(
        arbitrarySiblingIds(),
        fc.array(fc.constantFrom(...statuses), { minLength: 3, maxLength: 8 }),
        (siblingIds, randomStatuses) => {
          const { graph, branchNode } = buildBranchGraph(siblingIds);

          // Assign random statuses to siblings
          for (let i = 0; i < siblingIds.length; i++) {
            graph.nodes.get(siblingIds[i]).status = randomStatuses[i % randomStatuses.length];
          }

          const pool = createNoopPool();
          const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

          // Route to all siblings regardless of their current status
          const decision = { route: [...siblingIds] };

          orch._applyRoutingDecision(branchNode, decision);

          const updatedGraph = orch.getStatus().graph;
          for (const targetId of siblingIds) {
            assert.equal(
              updatedGraph.nodes.get(targetId).status,
              'not_started',
              `Target '${targetId}' should be not_started regardless of previous status`
            );
          }
        }
      ),
      { numRuns: 150 }
    );
  });
});


// --- Property 5: Non-selected siblings are skipped ---

describe('Property 5: Non-selected siblings are skipped', () => {
  const { Orchestrator } = require('../orchestrator');
  const { createTaskNode, createTaskGraph } = require('../task-graph');

  /**
   * Generate a set of unique sibling task IDs (at least 3).
   */
  function arbitrarySiblingIds() {
    return fc.uniqueArray(
      fc.stringMatching(/^[a-z][a-z0-9]{1,9}$/),
      { minLength: 3, maxLength: 8 }
    );
  }

  /**
   * Build a mock graph with a branch node and sibling tasks at the same depth/parent.
   * Returns { graph, branchNode, siblingIds }.
   */
  function buildBranchGraph(siblingIds) {
    const graph = createTaskGraph();
    const orderedIds = [];

    // Branch node
    const branchNode = createTaskNode({
      id: 'branch',
      title: 'Branch point',
      depth: 0,
      parent: null,
      markers: { start: false, branch: 'condition', terminal: false, loop: null },
    });
    graph.nodes.set('branch', branchNode);
    orderedIds.push('branch');

    // Sibling tasks (same parent=null, same depth=0, after branch in order)
    for (const id of siblingIds) {
      const node = createTaskNode({
        id,
        title: `Task ${id}`,
        depth: 0,
        parent: null,
        status: 'not_started',
      });
      graph.nodes.set(id, node);
      orderedIds.push(id);
    }

    graph._orderedIds = orderedIds;
    return { graph, branchNode };
  }

  /**
   * Create a minimal mock pool (never actually called in these tests).
   */
  function createNoopPool() {
    return { async dispatch() { return { output: '', duration: 0, agentType: 'general' }; } };
  }

  // **Validates: Requirements 2.5**
  it('siblings not in a single-string route are marked as skipped', () => {
    fc.assert(
      fc.property(
        arbitrarySiblingIds(),
        (siblingIds) => {
          const { graph, branchNode } = buildBranchGraph(siblingIds);
          const pool = createNoopPool();
          const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

          // Select only the first sibling — the rest should be skipped
          const selected = siblingIds[0];
          const decision = { route: selected };

          orch._applyRoutingDecision(branchNode, decision);

          const updatedGraph = orch.getStatus().graph;
          for (const id of siblingIds) {
            if (id === selected) {
              assert.equal(
                updatedGraph.nodes.get(id).status,
                'not_started',
                `Selected sibling '${id}' should be not_started`
              );
            } else {
              assert.equal(
                updatedGraph.nodes.get(id).status,
                'skipped',
                `Non-selected sibling '${id}' should be skipped`
              );
            }
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 2.5**
  it('siblings not in an array route (strict subset) are marked as skipped', () => {
    fc.assert(
      fc.property(
        arbitrarySiblingIds(),
        fc.integer({ min: 1 }),
        (siblingIds, seed) => {
          const { graph, branchNode } = buildBranchGraph(siblingIds);
          const pool = createNoopPool();
          const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

          // Select a strict subset (at least 1, fewer than all)
          const subsetSize = (Math.abs(seed) % (siblingIds.length - 1)) + 1;
          const selected = siblingIds.slice(0, subsetSize);
          const selectedSet = new Set(selected);
          const decision = { route: selected };

          orch._applyRoutingDecision(branchNode, decision);

          const updatedGraph = orch.getStatus().graph;
          for (const id of siblingIds) {
            if (selectedSet.has(id)) {
              assert.equal(
                updatedGraph.nodes.get(id).status,
                'not_started',
                `Selected sibling '${id}' should be not_started`
              );
            } else {
              assert.equal(
                updatedGraph.nodes.get(id).status,
                'skipped',
                `Non-selected sibling '${id}' should be skipped`
              );
            }
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 2.5**
  it('skipping applies regardless of siblings previous status', () => {
    const statuses = ['not_started', 'completed', 'in_progress', 'failed', 'skipped'];

    fc.assert(
      fc.property(
        arbitrarySiblingIds(),
        fc.array(fc.constantFrom(...statuses), { minLength: 3, maxLength: 8 }),
        (siblingIds, randomStatuses) => {
          const { graph, branchNode } = buildBranchGraph(siblingIds);

          // Assign random statuses to siblings before routing
          for (let i = 0; i < siblingIds.length; i++) {
            graph.nodes.get(siblingIds[i]).status = randomStatuses[i % randomStatuses.length];
          }

          const pool = createNoopPool();
          const orch = new Orchestrator({ taskGraph: graph, agentPool: pool });

          // Select only the first sibling
          const selected = siblingIds[0];
          const decision = { route: selected };

          orch._applyRoutingDecision(branchNode, decision);

          const updatedGraph = orch.getStatus().graph;
          for (const id of siblingIds) {
            if (id === selected) {
              assert.equal(
                updatedGraph.nodes.get(id).status,
                'not_started',
                `Selected sibling '${id}' should be not_started`
              );
            } else {
              assert.equal(
                updatedGraph.nodes.get(id).status,
                'skipped',
                `Non-selected sibling '${id}' should be skipped regardless of previous status`
              );
            }
          }
        }
      ),
      { numRuns: 150 }
    );
  });
});


// --- Property 6: Routing instructions contain all routable task IDs ---

describe('Property 6: Routing instructions contain all routable task IDs', () => {
  // main.js requires Electron at top level, so we inject a mock into the
  // require cache before loading it.  This lets us test the pure
  // buildRoutingInstructions function without an Electron runtime.
  const Module = require('node:module');
  const path = require('node:path');

  let buildRoutingInstructions;

  // Provide a minimal Electron mock so main.js can load
  const electronMock = {
    app: { whenReady: () => ({ then: () => {} }), on: () => {}, quit: () => {} },
    BrowserWindow: class {},
    ipcMain: { handle: () => {}, on: () => {} },
    nativeTheme: { themeSource: 'dark' },
  };

  const mainPath = path.resolve(__dirname, '..', 'main.js');

  // Stash and restore require cache to avoid polluting other tests
  const cachedElectron = require.cache[require.resolve('electron')] ?? null;
  const cachedMain = require.cache[mainPath] ?? null;

  // Install mock
  require.cache[require.resolve('electron')] = {
    id: require.resolve('electron'),
    filename: require.resolve('electron'),
    loaded: true,
    exports: electronMock,
  };
  // Clear main.js from cache so it re-evaluates with the mock
  delete require.cache[mainPath];

  try {
    buildRoutingInstructions = require(mainPath).buildRoutingInstructions;
  } finally {
    // Restore original cache entries
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

  /**
   * Generate a routable task object with a unique ID and title.
   */
  function arbitraryRoutableTask() {
    return fc.record({
      id: fc.stringMatching(/^[a-z][a-z0-9_-]{0,14}$/),
      title: fc.stringMatching(/^[a-zA-Z0-9 ]{1,30}$/),
    });
  }

  // **Validates: Requirements 3.2**
  it('routing instructions string contains every task ID from routable tasks', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryRoutableTask(), { minLength: 1, maxLength: 10 }),
        (routableTasks) => {
          const result = buildRoutingInstructions(routableTasks);

          assert.equal(typeof result, 'string', 'Result should be a string');
          assert.ok(result.length > 0, 'Result should be non-empty for non-empty input');

          for (const task of routableTasks) {
            assert.ok(
              result.includes(task.id),
              `Routing instructions should contain task ID '${task.id}'`
            );
          }
        }
      ),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 3.2**
  it('returns empty string for empty or null routable tasks', () => {
    assert.equal(buildRoutingInstructions([]), '', 'Empty array should return empty string');
    assert.equal(buildRoutingInstructions(null), '', 'null should return empty string');
    assert.equal(buildRoutingInstructions(undefined), '', 'undefined should return empty string');
  });
});
