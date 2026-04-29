'use strict';

// --- Data Structure Factories ---

/**
 * Create a TaskNode object.
 * @param {object} opts
 * @returns {object} TaskNode
 */
function createTaskNode(opts = {}) {
  return {
    id: opts.id ?? '',
    title: opts.title ?? '',
    status: opts.status ?? 'not_started',
    depth: opts.depth ?? 0,
    dependencies: opts.dependencies ?? [],
    children: opts.children ?? [],
    parent: opts.parent ?? null,
    markers: {
      start: opts.markers?.start ?? false,
      branch: opts.markers?.branch ?? null,
      terminal: opts.markers?.terminal ?? false,
      loop: opts.markers?.loop ?? null,
    },
    parallel: opts.parallel ?? false,
    metadata: opts.metadata ?? {},
  };
}

/**
 * Create a TaskGraph object.
 * @param {object} opts
 * @returns {object} TaskGraph
 */
function createTaskGraph(opts = {}) {
  return {
    nodes: opts.nodes ?? new Map(),
    startNodeId: opts.startNodeId ?? null,
    errors: opts.errors ?? [],
  };
}

/**
 * Create a ParseError object.
 * @param {number} line
 * @param {string} message
 * @param {'error'|'warning'} severity
 * @returns {object} ParseError
 */
function createParseError(line, message, severity = 'error') {
  return { line, message, severity };
}

// --- Status & Marker Constants ---

const STATUS_MAP = {
  ' ': 'not_started',
  'x': 'completed',
  '-': 'in_progress',
  '!': 'failed',
  '~': 'skipped',
};

const STATUS_REVERSE = {};
for (const [k, v] of Object.entries(STATUS_MAP)) {
  STATUS_REVERSE[v] = k;
}

// Regex for a task line:
//   optional leading whitespace, then `- [<status_or_marker>] <id> <title>`
// Status/marker inside brackets can be:
//   single char status: ' ', 'x', '-', '!', '~'
//   start marker: '^'
//   terminal marker: '$'
//   branch marker: '?branch:<condition>'
//   loop marker: '~loop:<targetId>#<maxIter>'
const TASK_LINE_RE = /^(\s*)- \[([^\]]*)\]\s+(\S+)\s+(.*?)\s*$/;

// --- parseTaskGraph ---

/**
 * Parse a Tasks.md markdown string into a TaskGraph.
 * @param {string} markdown
 * @returns {object} TaskGraph
 */
function parseTaskGraph(markdown) {
  const graph = createTaskGraph();
  if (!markdown || !markdown.trim()) return graph;

  const lines = markdown.split('\n');
  // Ordered list of parsed node IDs to preserve insertion order
  const orderedIds = [];
  // Stack to track parent context: [{id, depth}]
  const parentStack = [];
  // Track siblings at each depth for dependency computation
  // Map<depth, string[]> — list of node IDs at that depth under the same parent
  const siblingGroups = new Map(); // key = parentId||depth, value = [nodeId, ...]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip blank lines and non-task lines (headers, comments, etc.)
    if (!line.trim() || !line.trim().startsWith('- [')) continue;

    const match = TASK_LINE_RE.exec(line);
    if (!match) {
      // Line looks like it should be a task but doesn't match
      if (line.trim().startsWith('- [')) {
        graph.errors.push(createParseError(lineNum, `Malformed task line: "${line.trim()}"`, 'error'));
      }
      continue;
    }

    const [, indent, bracketContent, rawId, rawTitle] = match;
    const depth = Math.floor(indent.length / 2);

    // Strip markdown bold/italic markers (**text**, *text*, __text__, _text_)
    // so that tasks.md files with formatted titles parse correctly.
    const id = rawId.replace(/^\*{1,2}|^\_{1,2}|\*{1,2}$|\_{1,2}$/g, '');
    const title = rawTitle.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1').replace(/\_{1,2}([^_]+)\_{1,2}/g, '$1');

    // Parse status and markers from bracket content
    const node = createTaskNode({ id, title, depth });

    parseBracketContent(bracketContent, node, graph, lineNum);

    // Duplicate ID check — skip duplicates to prevent graph corruption.
    // A corrupted tasks.md with repeated sections would otherwise cause
    // the graph to grow on every persist cycle.
    if (graph.nodes.has(id)) {
      graph.errors.push(createParseError(lineNum, `Duplicate node ID: "${id}" — skipping`, 'error'));
      continue;  // skip this node entirely
    }

    // Build parent-child relationships using the parent stack
    // Pop stack entries that are at the same or deeper depth
    while (parentStack.length > 0 && parentStack[parentStack.length - 1].depth >= depth) {
      parentStack.pop();
    }

    if (parentStack.length > 0) {
      const parentEntry = parentStack[parentStack.length - 1];
      node.parent = parentEntry.id;
      const parentNode = graph.nodes.get(parentEntry.id);
      if (parentNode) {
        parentNode.children.push(id);
      }
    }

    parentStack.push({ id, depth });
    graph.nodes.set(id, node);
    orderedIds.push(id);

    // Track sibling group for dependency computation
    const groupKey = `${node.parent || '__root__'}||${depth}`;
    if (!siblingGroups.has(groupKey)) {
      siblingGroups.set(groupKey, []);
    }
    siblingGroups.get(groupKey).push(id);
  }

  // Compute dependencies: sequential siblings depend on prior sibling
  for (const [, siblings] of siblingGroups) {
    if (siblings.length <= 1) {
      // Single node — no sibling dependency, not parallel
      continue;
    }
    // By default, sequential siblings: each depends on the previous
    for (let i = 1; i < siblings.length; i++) {
      const node = graph.nodes.get(siblings[i]);
      if (node) {
        node.dependencies.push(siblings[i - 1]);
      }
    }
  }

  // Detect parallelizable siblings:
  // Siblings at same depth with no explicit dependency are parallel.
  // In our model, sequential siblings DO have dependencies, so only the first
  // sibling in a group (which has no dependency on a prior sibling) could be
  // considered parallel with other first-siblings. But per the spec:
  // "same depth, no explicit dependency" — since we add sequential deps,
  // only nodes without dependencies on siblings are parallel.
  // Actually, re-reading the spec: "sequential siblings depend on prior sibling"
  // means they are NOT parallel. Parallel detection is for siblings that
  // genuinely have no ordering constraint. In the current model, all siblings
  // are sequential by default, so parallel = false for all.
  // However, the spec says "Detect parallelizable siblings (same depth, no explicit dependency)"
  // This seems contradictory with "sequential siblings depend on prior sibling".
  // Resolution: siblings are sequential (have deps), so parallel = false.
  // The parallel flag would be true only if siblings had no dependency,
  // which doesn't happen in the default parsing. This is consistent with
  // Property 2: "siblings with no explicit dependency → parallel: true" and
  // "sibling with explicit dependency → NOT parallel".
  // Since all siblings get sequential deps, none are parallel by default.

  // Find start node
  for (const [id, node] of graph.nodes) {
    if (node.markers.start) {
      graph.startNodeId = id;
      break;
    }
  }

  // Store insertion order as metadata on the graph for printing
  graph._orderedIds = orderedIds;

  return graph;
}

/**
 * Parse bracket content into node status and markers.
 */
function parseBracketContent(content, node, graph, lineNum) {
  // Single-char status (check raw content first — space is a valid status)
  if (content.length === 1 && STATUS_MAP[content] !== undefined) {
    node.status = STATUS_MAP[content];
    return;
  }

  const trimmed = content.trim();

  // Start marker: ^
  if (trimmed === '^') {
    node.markers.start = true;
    node.status = 'not_started';
    return;
  }

  // Terminal marker: $
  if (trimmed === '$') {
    node.markers.terminal = true;
    node.status = 'not_started';
    return;
  }

  // Branch marker: ?branch:<condition>
  const branchMatch = /^\?branch:(.+)$/.exec(trimmed);
  if (branchMatch) {
    node.markers.branch = branchMatch[1];
    node.status = 'not_started';
    return;
  }

  // Loop marker: ~loop:<targetId>#<maxIter>
  const loopMatch = /^~loop:([^#]+)#(\d+)$/.exec(trimmed);
  if (loopMatch) {
    node.markers.loop = {
      target: loopMatch[1],
      maxIterations: parseInt(loopMatch[2], 10),
    };
    node.status = 'skipped'; // loop nodes use ~ which maps to skipped
    return;
  }

  // If we get here, it's an unrecognized bracket content
  graph.errors.push(
    createParseError(lineNum, `Unrecognized bracket content: "[${content}]"`, 'error')
  );
  node.status = 'not_started';
}

// --- printTaskGraph ---

/**
 * Serialize a TaskGraph back to Tasks.md markdown format.
 * @param {object} graph - TaskGraph
 * @returns {string} markdown
 */
function printTaskGraph(graph) {
  if (!graph || !graph.nodes || graph.nodes.size === 0) return '';

  // Use stored insertion order if available, otherwise sort by ID
  const orderedIds = graph._orderedIds || sortNodeIds([...graph.nodes.keys()]);
  const lines = [];

  for (const id of orderedIds) {
    const node = graph.nodes.get(id);
    if (!node) continue;

    const indent = '  '.repeat(node.depth);
    const bracket = formatBracket(node);
    lines.push(`${indent}- [${bracket}] ${node.id} ${node.title}`);
  }

  return lines.join('\n');
}

/**
 * Format the bracket content for a node.
 */
function formatBracket(node) {
  // Special markers take precedence
  if (node.markers.start) return '^';
  if (node.markers.terminal) return '$';
  if (node.markers.branch) return `?branch:${node.markers.branch}`;
  if (node.markers.loop) {
    return `~loop:${node.markers.loop.target}#${node.markers.loop.maxIterations}`;
  }
  // Regular status
  return STATUS_REVERSE[node.status] ?? ' ';
}

/**
 * Sort node IDs by their numeric components.
 * e.g., "1" < "1.1" < "1.2" < "2" < "10"
 */
function sortNodeIds(ids) {
  return ids.sort((a, b) => {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] ?? -1;
      const bVal = bParts[i] ?? -1;
      if (aVal !== bVal) return aVal - bVal;
    }
    return 0;
  });
}

// --- validateTaskGraph ---

/**
 * Validate a TaskGraph for structural issues.
 * @param {object} graph - TaskGraph
 * @returns {object[]} ParseError[]
 */
function validateTaskGraph(graph) {
  const errors = [];

  // 1. Check for duplicate node IDs (already caught during parsing, but validate again)
  const seenIds = new Set();
  for (const [id] of graph.nodes) {
    if (seenIds.has(id)) {
      errors.push(createParseError(0, `Duplicate node ID: "${id}"`, 'error'));
    }
    seenIds.add(id);
  }

  // 2. Check for circular dependencies via DFS
  const visited = new Set();
  const inStack = new Set();

  function dfs(nodeId) {
    if (inStack.has(nodeId)) {
      errors.push(createParseError(0, `Circular dependency detected involving node "${nodeId}"`, 'error'));
      return;
    }
    if (visited.has(nodeId)) return;

    visited.add(nodeId);
    inStack.add(nodeId);

    const node = graph.nodes.get(nodeId);
    if (node) {
      for (const depId of node.dependencies) {
        dfs(depId);
      }
    }

    inStack.delete(nodeId);
  }

  for (const [id] of graph.nodes) {
    dfs(id);
  }

  // 3. Check for missing start node
  const rootNodes = [];
  for (const [id, node] of graph.nodes) {
    if (node.parent === null) {
      rootNodes.push(id);
    }
  }

  if (rootNodes.length > 1 && !graph.startNodeId) {
    errors.push(
      createParseError(0, 'Multiple root nodes found but no ^start marker designated', 'warning')
    );
  }

  return errors;
}

// --- Utility Functions ---

/**
 * Return a new TaskGraph with the specified node's status changed.
 * @param {object} graph - TaskGraph
 * @param {string} nodeId
 * @param {string} status
 * @returns {object} new TaskGraph
 */
function updateNodeStatus(graph, nodeId, status) {
  const newNodes = new Map();
  for (const [id, node] of graph.nodes) {
    if (id === nodeId) {
      newNodes.set(id, { ...node, status });
    } else {
      newNodes.set(id, node);
    }
  }
  return {
    ...graph,
    nodes: newNodes,
  };
}

/**
 * Return all nodes whose dependencies are all completed and whose own status is not_started.
 * @param {object} graph - TaskGraph
 * @returns {object[]} TaskNode[]
 */
function getNextExecutableNodes(graph) {
  const result = [];
  for (const [, node] of graph.nodes) {
    if (node.status !== 'not_started') continue;

    const allDepsResolved = node.dependencies.every((depId) => {
      const dep = graph.nodes.get(depId);
      // A dependency is resolved if it completed, was skipped, or failed —
      // failed deps should not permanently block their dependents.
      return dep && (dep.status === 'completed' || dep.status === 'skipped' || dep.status === 'failed');
    });

    if (allDepsResolved) {
      result.push(node);
    }
  }
  return result;
}

// --- Exports ---

module.exports = {
  createTaskNode,
  createTaskGraph,
  createParseError,
  parseTaskGraph,
  printTaskGraph,
  validateTaskGraph,
  updateNodeStatus,
  getNextExecutableNodes,
  // Expose for testing
  sortNodeIds,
  formatBracket,
};
