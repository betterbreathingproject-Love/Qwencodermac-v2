'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTaskNode,
  createTaskGraph,
  createParseError,
  parseTaskGraph,
  printTaskGraph,
  validateTaskGraph,
  updateNodeStatus,
  getNextExecutableNodes,
} = require('../task-graph.js');

// --- 1.6.1 Test parsing known Tasks.md fixtures ---

describe('parseTaskGraph', () => {
  it('parses a linear task list', () => {
    const md = [
      '- [ ] 1 First task',
      '- [ ] 2 Second task',
      '- [ ] 3 Third task',
    ].join('\n');

    const graph = parseTaskGraph(md);
    assert.equal(graph.nodes.size, 3);
    assert.equal(graph.nodes.get('1').title, 'First task');
    assert.equal(graph.nodes.get('2').title, 'Second task');
    assert.equal(graph.nodes.get('3').title, 'Third task');

    // Sequential deps
    assert.deepEqual(graph.nodes.get('1').dependencies, []);
    assert.deepEqual(graph.nodes.get('2').dependencies, ['1']);
    assert.deepEqual(graph.nodes.get('3').dependencies, ['2']);
  });

  it('parses nested tasks with parent-child relationships', () => {
    const md = [
      '- [ ] 1 Parent task',
      '  - [ ] 1.1 Child one',
      '  - [ ] 1.2 Child two',
      '- [ ] 2 Another parent',
    ].join('\n');

    const graph = parseTaskGraph(md);
    assert.equal(graph.nodes.size, 4);

    const parent = graph.nodes.get('1');
    assert.deepEqual(parent.children, ['1.1', '1.2']);
    assert.equal(parent.parent, null);
    assert.equal(parent.depth, 0);

    const child1 = graph.nodes.get('1.1');
    assert.equal(child1.parent, '1');
    assert.equal(child1.depth, 1);
    assert.deepEqual(child1.dependencies, []);

    const child2 = graph.nodes.get('1.2');
    assert.equal(child2.parent, '1');
    assert.deepEqual(child2.dependencies, ['1.1']);
  });

  it('parses all status markers', () => {
    const md = [
      '- [ ] 1 Not started',
      '- [x] 2 Completed',
      '- [-] 3 In progress',
      '- [!] 4 Failed',
      '- [~] 5 Skipped',
    ].join('\n');

    const graph = parseTaskGraph(md);
    assert.equal(graph.nodes.get('1').status, 'not_started');
    assert.equal(graph.nodes.get('2').status, 'completed');
    assert.equal(graph.nodes.get('3').status, 'in_progress');
    assert.equal(graph.nodes.get('4').status, 'failed');
    assert.equal(graph.nodes.get('5').status, 'skipped');
  });

  it('parses all special markers', () => {
    const md = [
      '- [^] 1 Start node',
      '- [?branch:hasTests] 2 Branch node',
      '- [$] 3 Terminal node',
      '- [~loop:1#5] 4 Loop node',
    ].join('\n');

    const graph = parseTaskGraph(md);

    assert.equal(graph.nodes.get('1').markers.start, true);
    assert.equal(graph.startNodeId, '1');

    assert.equal(graph.nodes.get('2').markers.branch, 'hasTests');

    assert.equal(graph.nodes.get('3').markers.terminal, true);

    assert.deepEqual(graph.nodes.get('4').markers.loop, { target: '1', maxIterations: 5 });
  });

  // --- 1.6.2 Test edge cases ---

  it('handles empty file', () => {
    const graph = parseTaskGraph('');
    assert.equal(graph.nodes.size, 0);
    assert.equal(graph.startNodeId, null);
    assert.deepEqual(graph.errors, []);
  });

  it('handles null/undefined input', () => {
    const graph = parseTaskGraph(null);
    assert.equal(graph.nodes.size, 0);
  });

  it('handles single node', () => {
    const graph = parseTaskGraph('- [ ] 1 Only task');
    assert.equal(graph.nodes.size, 1);
    assert.equal(graph.nodes.get('1').title, 'Only task');
    assert.deepEqual(graph.nodes.get('1').dependencies, []);
  });

  it('handles deeply nested tasks (10+ levels)', () => {
    const lines = [];
    for (let i = 0; i <= 12; i++) {
      const indent = '  '.repeat(i);
      const id = i === 0 ? '1' : `1.${'1.'.repeat(i - 1)}1`.replace(/\.$/, '');
      // Simpler: use dotted IDs
      const simpleId = Array.from({ length: i + 1 }, () => '1').join('.');
      lines.push(`${indent}- [ ] ${simpleId} Level ${i} task`);
    }
    const md = lines.join('\n');
    const graph = parseTaskGraph(md);

    assert.equal(graph.nodes.size, 13);
    // Check deepest node
    const deepId = Array.from({ length: 13 }, () => '1').join('.');
    const deepNode = graph.nodes.get(deepId);
    assert.equal(deepNode.depth, 12);
  });

  // --- 1.6.3 Test syntax error reporting ---

  it('reports syntax errors for malformed lines', () => {
    const md = [
      '- [ ] 1 Good task',
      '- [invalid_marker_content] 2 Bad marker',
      '- [ ] 3 Another good task',
    ].join('\n');

    const graph = parseTaskGraph(md);
    assert.equal(graph.nodes.size, 3);
    // The "invalid_marker_content" should produce an error
    const errors = graph.errors.filter((e) => e.message.includes('Unrecognized bracket'));
    assert.ok(errors.length > 0, 'Should have at least one error for bad marker');
    assert.equal(errors[0].line, 2);
  });

  it('reports error for completely malformed task line', () => {
    const md = [
      '- [ ] 1 Good task',
      '- [] broken',
      '- [ ] 2 Another good task',
    ].join('\n');

    const graph = parseTaskGraph(md);
    const errors = graph.errors.filter((e) => e.message.includes('Malformed'));
    assert.ok(errors.length > 0);
  });

  it('skips non-task lines (headers, blank lines)', () => {
    const md = [
      '# Tasks',
      '',
      '## Section 1',
      '',
      '- [ ] 1 A task',
      '',
      'Some text',
      '',
      '- [ ] 2 Another task',
    ].join('\n');

    const graph = parseTaskGraph(md);
    assert.equal(graph.nodes.size, 2);
    assert.deepEqual(graph.errors, []);
  });
});

// --- 1.6.4 Test print output ---

describe('printTaskGraph', () => {
  it('prints a simple graph back to markdown', () => {
    const md = [
      '- [ ] 1 First task',
      '- [ ] 2 Second task',
    ].join('\n');

    const graph = parseTaskGraph(md);
    const output = printTaskGraph(graph);
    assert.equal(output, md);
  });

  it('preserves indentation for nested tasks', () => {
    const md = [
      '- [ ] 1 Parent',
      '  - [ ] 1.1 Child',
      '    - [ ] 1.1.1 Grandchild',
    ].join('\n');

    const graph = parseTaskGraph(md);
    const output = printTaskGraph(graph);
    assert.equal(output, md);
  });

  it('preserves status markers', () => {
    const md = [
      '- [x] 1 Done',
      '- [-] 2 Working',
      '- [!] 3 Broken',
      '- [~] 4 Skipped',
    ].join('\n');

    const graph = parseTaskGraph(md);
    const output = printTaskGraph(graph);
    assert.equal(output, md);
  });

  it('preserves special markers', () => {
    const md = [
      '- [^] 1 Start',
      '- [?branch:cond] 2 Branch',
      '- [$] 3 Terminal',
      '- [~loop:1#3] 4 Loop',
    ].join('\n');

    const graph = parseTaskGraph(md);
    const output = printTaskGraph(graph);
    assert.equal(output, md);
  });

  it('returns empty string for empty graph', () => {
    const graph = createTaskGraph();
    assert.equal(printTaskGraph(graph), '');
  });
});

// --- validateTaskGraph tests ---

describe('validateTaskGraph', () => {
  it('detects circular dependencies', () => {
    const graph = createTaskGraph();
    const nodeA = createTaskNode({ id: 'A', title: 'A', dependencies: ['B'] });
    const nodeB = createTaskNode({ id: 'B', title: 'B', dependencies: ['A'] });
    graph.nodes.set('A', nodeA);
    graph.nodes.set('B', nodeB);

    const errors = validateTaskGraph(graph);
    const circularErrors = errors.filter((e) => e.message.includes('Circular'));
    assert.ok(circularErrors.length > 0);
  });

  it('warns about missing start node with multiple roots', () => {
    const md = [
      '- [ ] 1 Root one',
      '- [ ] 2 Root two',
    ].join('\n');
    const graph = parseTaskGraph(md);
    const errors = validateTaskGraph(graph);
    const warnings = errors.filter((e) => e.severity === 'warning' && e.message.includes('start'));
    assert.ok(warnings.length > 0);
  });

  it('no warning for single root without start marker', () => {
    const md = '- [ ] 1 Only root';
    const graph = parseTaskGraph(md);
    const errors = validateTaskGraph(graph);
    const warnings = errors.filter((e) => e.severity === 'warning');
    assert.equal(warnings.length, 0);
  });

  it('no warning when start marker is present', () => {
    const md = [
      '- [^] 1 Start',
      '- [ ] 2 Other root',
    ].join('\n');
    const graph = parseTaskGraph(md);
    const errors = validateTaskGraph(graph);
    const warnings = errors.filter((e) => e.severity === 'warning' && e.message.includes('start'));
    assert.equal(warnings.length, 0);
  });
});

// --- updateNodeStatus tests ---

describe('updateNodeStatus', () => {
  it('returns a new graph with updated status', () => {
    const md = '- [ ] 1 Task';
    const graph = parseTaskGraph(md);
    const updated = updateNodeStatus(graph, '1', 'in_progress');

    assert.equal(updated.nodes.get('1').status, 'in_progress');
    // Original unchanged
    assert.equal(graph.nodes.get('1').status, 'not_started');
  });

  it('preserves other nodes', () => {
    const md = [
      '- [ ] 1 First',
      '- [ ] 2 Second',
    ].join('\n');
    const graph = parseTaskGraph(md);
    const updated = updateNodeStatus(graph, '1', 'completed');

    assert.equal(updated.nodes.get('1').status, 'completed');
    assert.equal(updated.nodes.get('2').status, 'not_started');
  });
});

// --- getNextExecutableNodes tests ---

describe('getNextExecutableNodes', () => {
  it('returns nodes with all deps completed and status not_started', () => {
    const md = [
      '- [ ] 1 First',
      '- [ ] 2 Second',
      '- [ ] 3 Third',
    ].join('\n');
    let graph = parseTaskGraph(md);

    // Initially only node 1 is executable (no deps)
    let next = getNextExecutableNodes(graph);
    assert.equal(next.length, 1);
    assert.equal(next[0].id, '1');

    // Complete node 1
    graph = updateNodeStatus(graph, '1', 'completed');
    next = getNextExecutableNodes(graph);
    assert.equal(next.length, 1);
    assert.equal(next[0].id, '2');

    // Complete node 2
    graph = updateNodeStatus(graph, '2', 'completed');
    next = getNextExecutableNodes(graph);
    assert.equal(next.length, 1);
    assert.equal(next[0].id, '3');
  });

  it('returns empty when all nodes are completed', () => {
    const md = '- [x] 1 Done';
    const graph = parseTaskGraph(md);
    const next = getNextExecutableNodes(graph);
    assert.equal(next.length, 0);
  });

  it('returns empty when deps are not completed', () => {
    const md = [
      '- [-] 1 In progress',
      '- [ ] 2 Waiting',
    ].join('\n');
    const graph = parseTaskGraph(md);
    const next = getNextExecutableNodes(graph);
    // Node 1 is in_progress (not not_started), node 2 depends on 1 which isn't completed
    assert.equal(next.length, 0);
  });
});
