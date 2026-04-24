'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const {
  createTaskNode,
  createTaskGraph,
  parseTaskGraph,
  printTaskGraph,
  getNextExecutableNodes,
  updateNodeStatus,
} = require('../task-graph.js');

// --- Generators ---

/**
 * Generate a valid task ID like "1", "2.1", "3.2.1"
 */
function arbitraryTaskId(maxDepth = 0) {
  if (maxDepth === 0) {
    return fc.integer({ min: 1, max: 99 }).map(String);
  }
  const parts = [fc.integer({ min: 1, max: 99 })];
  for (let i = 0; i < maxDepth; i++) {
    parts.push(fc.integer({ min: 1, max: 99 }));
  }
  return fc.tuple(...parts).map((nums) => nums.join('.'));
}

/**
 * Generate a safe title string (no newlines, no brackets, non-empty, single word-like tokens).
 */
function arbitraryTitle() {
  return fc
    .stringMatching(/^[a-z][a-z0-9_]{0,19}$/)
    .filter((s) => s.length > 0);
}

/**
 * Generate a valid status.
 */
function arbitraryStatus() {
  return fc.constantFrom('not_started', 'completed', 'in_progress', 'failed', 'skipped');
}

/**
 * Generate a valid markers object (only one marker active at a time, or none).
 */
function arbitraryMarkers() {
  return fc.oneof(
    // No markers
    fc.constant({ start: false, branch: null, terminal: false, loop: null }),
    // Start marker
    fc.constant({ start: true, branch: null, terminal: false, loop: null }),
    // Terminal marker
    fc.constant({ start: false, branch: null, terminal: true, loop: null }),
    // Branch marker
    arbitraryTitle().map((cond) => ({
      start: false,
      branch: cond,
      terminal: false,
      loop: null,
    })),
    // Loop marker
    fc
      .tuple(fc.integer({ min: 1, max: 99 }).map(String), fc.integer({ min: 1, max: 100 }))
      .map(([target, maxIter]) => ({
        start: false,
        branch: null,
        terminal: false,
        loop: { target, maxIterations: maxIter },
      }))
  );
}

/**
 * Generate a valid TaskGraph as a markdown string that can be parsed and round-tripped.
 * Produces a tree structure with unique IDs.
 */
function arbitraryTaskGraphMd() {
  // Generate a flat or nested structure
  return fc
    .tuple(
      fc.integer({ min: 1, max: 8 }), // number of top-level nodes
      fc.integer({ min: 0, max: 3 })  // max children per node
    )
    .chain(([numRoots, maxChildren]) => {
      // Build a deterministic tree structure as markdown lines
      return fc
        .tuple(
          fc.array(arbitraryTitle(), { minLength: numRoots, maxLength: numRoots }),
          fc.array(
            fc.tuple(arbitraryStatus(), arbitraryMarkers()),
            { minLength: numRoots, maxLength: numRoots }
          ),
          fc.array(
            fc.integer({ min: 0, max: maxChildren }),
            { minLength: numRoots, maxLength: numRoots }
          ),
          fc.array(arbitraryTitle(), { minLength: 0, maxLength: numRoots * maxChildren }),
          fc.array(arbitraryStatus(), { minLength: 0, maxLength: numRoots * maxChildren })
        )
        .map(([titles, statusMarkers, childCounts, childTitles, childStatuses]) => {
          const lines = [];
          let childIdx = 0;
          let startAssigned = false;

          for (let i = 0; i < numRoots; i++) {
            const id = String(i + 1);
            let [status, markers] = statusMarkers[i];

            // Only allow one start marker in the whole graph
            if (markers.start && startAssigned) {
              markers = { start: false, branch: null, terminal: false, loop: null };
            }
            if (markers.start) startAssigned = true;

            // For nodes with special markers, status is determined by the marker
            const bracket = formatBracketForGen(status, markers);
            lines.push(`- [${bracket}] ${id} ${titles[i]}`);

            // Add children
            const numChildren = childCounts[i];
            for (let j = 0; j < numChildren && childIdx < childTitles.length; j++) {
              const childId = `${id}.${j + 1}`;
              const childStatus = childStatuses[childIdx] || 'not_started';
              const childBracket = formatStatusBracket(childStatus);
              const childTitle = childTitles[childIdx] || 'child';
              lines.push(`  - [${childBracket}] ${childId} ${childTitle}`);
              childIdx++;
            }
          }

          return lines.join('\n');
        });
    });
}

function formatBracketForGen(status, markers) {
  if (markers.start) return '^';
  if (markers.terminal) return '$';
  if (markers.branch) return `?branch:${markers.branch}`;
  if (markers.loop) return `~loop:${markers.loop.target}#${markers.loop.maxIterations}`;
  return formatStatusBracket(status);
}

function formatStatusBracket(status) {
  const map = {
    not_started: ' ',
    completed: 'x',
    in_progress: '-',
    failed: '!',
    skipped: '~',
  };
  return map[status] || ' ';
}

/**
 * Generate invalid markdown with known error lines.
 */
function arbitraryInvalidTasksMd() {
  return fc
    .tuple(
      fc.integer({ min: 1, max: 5 }), // number of good lines before error
      fc.constantFrom(
        '- [???] bad1 Invalid marker',
        '- [abc] bad2 Multi char status',
        '- [>>] bad3 Weird bracket',
        '- [~loop:bad] bad4 Malformed loop',
        '- [?] bad5 Incomplete branch',
      ),
      fc.integer({ min: 0, max: 3 }) // number of good lines after error
    )
    .map(([goodBefore, badLine, goodAfter]) => {
      const lines = [];
      for (let i = 1; i <= goodBefore; i++) {
        lines.push(`- [ ] ${i} Good task ${i}`);
      }
      lines.push(badLine);
      for (let i = 0; i < goodAfter; i++) {
        const id = goodBefore + 2 + i;
        lines.push(`- [ ] ${id} Good task after`);
      }
      return { md: lines.join('\n'), errorLine: goodBefore + 1 };
    });
}

// --- Property Tests ---

describe('Property-based tests for task-graph.js', () => {
  // 1.7.3 Property 1: Round-trip (print → parse → compare)
  // **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6, 1.8, 1.9**
  it('Property 1: round-trip preservation (print → parse → compare)', () => {
    fc.assert(
      fc.property(arbitraryTaskGraphMd(), (md) => {
        const graph1 = parseTaskGraph(md);
        const printed = printTaskGraph(graph1);
        const graph2 = parseTaskGraph(printed);

        // Same number of nodes
        assert.equal(graph2.nodes.size, graph1.nodes.size);

        // Same node IDs
        for (const [id, node1] of graph1.nodes) {
          const node2 = graph2.nodes.get(id);
          assert.ok(node2, `Node ${id} should exist after round-trip`);

          // Same title
          assert.equal(node2.title, node1.title);

          // Same depth
          assert.equal(node2.depth, node1.depth);

          // Same parent
          assert.equal(node2.parent, node1.parent);

          // Same children
          assert.deepEqual(node2.children, node1.children);

          // Same dependencies
          assert.deepEqual(node2.dependencies, node1.dependencies);

          // Same markers
          assert.deepEqual(node2.markers, node1.markers);

          // Same status (for non-marker nodes)
          // Marker nodes may have their status set by the marker
          if (
            !node1.markers.start &&
            !node1.markers.terminal &&
            !node1.markers.branch &&
            !node1.markers.loop
          ) {
            assert.equal(node2.status, node1.status);
          }
        }

        // Same start node
        assert.equal(graph2.startNodeId, graph1.startNodeId);
      }),
      { numRuns: 150 }
    );
  });

  // 1.7.4 Property 2: Parallel sibling detection invariant
  // **Validates: Requirements 1.5**
  it('Property 2: parallel sibling detection invariant', () => {
    fc.assert(
      fc.property(arbitraryTaskGraphMd(), (md) => {
        const graph = parseTaskGraph(md);

        for (const [, node] of graph.nodes) {
          if (node.dependencies.length > 0) {
            // Node with dependencies on a sibling should NOT be parallel
            const hasSiblingDep = node.dependencies.some((depId) => {
              const dep = graph.nodes.get(depId);
              return dep && dep.parent === node.parent;
            });
            if (hasSiblingDep) {
              assert.equal(
                node.parallel,
                false,
                `Node ${node.id} has sibling dependency, should not be parallel`
              );
            }
          }
        }
      }),
      { numRuns: 150 }
    );
  });

  // 1.7.5 Property 3: Syntax error reporting for invalid markdown
  // **Validates: Requirements 1.7**
  it('Property 3: syntax error reporting for generated invalid markdown', () => {
    fc.assert(
      fc.property(arbitraryInvalidTasksMd(), ({ md, errorLine }) => {
        const graph = parseTaskGraph(md);

        // Should have at least one error
        assert.ok(graph.errors.length > 0, 'Should report at least one error for invalid markdown');

        // At least one error should be on the expected line
        const errorOnLine = graph.errors.some((e) => e.line === errorLine);
        assert.ok(
          errorOnLine,
          `Expected error on line ${errorLine}, got errors on lines: ${graph.errors.map((e) => e.line).join(', ')}`
        );

        // All errors should have non-empty messages
        for (const err of graph.errors) {
          assert.ok(err.message.length > 0, 'Error message should be non-empty');
        }
      }),
      { numRuns: 150 }
    );
  });
});
