'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSteeringDoc, printSteeringDoc, formatSteeringForPrompt } = require('../steering-loader.js');

// --- parseSteeringDoc unit tests ---

describe('parseSteeringDoc', () => {
  // **Validates: Requirements 6.1, 6.2, 6.3**
  it('parses valid YAML front matter with all fields and body', () => {
    const content = [
      '---',
      'name: project-overview',
      'description: Auto-generated project overview',
      'auto_generated: true',
      '---',
      '## Tech Stack',
      '',
      '- Node.js with Electron',
    ].join('\n');

    const { frontMatter, body } = parseSteeringDoc(content);
    assert.equal(frontMatter.name, 'project-overview');
    assert.equal(frontMatter.description, 'Auto-generated project overview');
    assert.equal(frontMatter.auto_generated, true);
    assert.ok(body.includes('## Tech Stack'));
    assert.ok(body.includes('Node.js with Electron'));
  });

  // **Validates: Requirements 6.1**
  it('defaults description to empty string when missing', () => {
    const content = [
      '---',
      'name: tooling',
      'auto_generated: false',
      '---',
      'Body content here',
    ].join('\n');

    const { frontMatter } = parseSteeringDoc(content);
    assert.equal(frontMatter.name, 'tooling');
    assert.equal(frontMatter.description, '');
    assert.equal(frontMatter.auto_generated, false);
  });

  // **Validates: Requirements 6.1**
  it('returns empty frontMatter and full content as body when no --- delimiters', () => {
    const content = 'Just some markdown\n\nNo front matter here.';
    const { frontMatter, body } = parseSteeringDoc(content);
    assert.equal(frontMatter.name, '');
    assert.equal(frontMatter.description, '');
    assert.equal(frontMatter.auto_generated, false);
    assert.equal(body, content);
  });

  // **Validates: Requirements 6.1**
  it('returns empty frontMatter and empty body for empty string', () => {
    const { frontMatter, body } = parseSteeringDoc('');
    assert.equal(frontMatter.name, '');
    assert.equal(frontMatter.description, '');
    assert.equal(frontMatter.auto_generated, false);
    assert.equal(body, '');
  });

  // **Validates: Requirements 6.3**
  it('parses auto_generated: true as boolean true', () => {
    const content = '---\nname: test\nauto_generated: true\n---\n';
    const { frontMatter } = parseSteeringDoc(content);
    assert.equal(frontMatter.auto_generated, true);
  });

  // **Validates: Requirements 6.3**
  it('parses auto_generated: false as boolean false', () => {
    const content = '---\nname: test\nauto_generated: false\n---\n';
    const { frontMatter } = parseSteeringDoc(content);
    assert.equal(frontMatter.auto_generated, false);
  });
});

// --- printSteeringDoc unit tests ---

describe('printSteeringDoc', () => {
  // **Validates: Requirements 6.1, 6.4**
  it('serializes frontMatter and body with --- delimiters', () => {
    const fm = { name: 'overview', description: 'Project overview', auto_generated: true };
    const body = '## Heading\n\nSome content';
    const result = printSteeringDoc(fm, body);

    assert.ok(result.startsWith('---\n'));
    assert.ok(result.includes('name: overview'));
    assert.ok(result.includes('description: Project overview'));
    assert.ok(result.includes('auto_generated: true'));
    assert.ok(result.includes('---\n## Heading'));
    assert.ok(result.includes('Some content'));
  });

  // **Validates: Requirements 6.4**
  it('serializes with empty body producing front matter only', () => {
    const fm = { name: 'empty', description: 'No body', auto_generated: false };
    const result = printSteeringDoc(fm, '');

    assert.ok(result.includes('name: empty'));
    assert.ok(result.includes('auto_generated: false'));
    // Should end with closing --- and newline, no body content after
    assert.ok(result.endsWith('---\n'));
  });

  // **Validates: Requirements 6.4**
  it('serializes with null frontMatter using defaults', () => {
    const result = printSteeringDoc(null, 'Some body');

    assert.ok(result.includes('name: '));
    assert.ok(result.includes('description: '));
    assert.ok(result.includes('auto_generated: false'));
    assert.ok(result.includes('Some body'));
  });
});

// --- formatSteeringForPrompt unit tests ---

describe('formatSteeringForPrompt', () => {
  // **Validates: Requirements 7.3**
  it('returns empty string for empty array', () => {
    assert.equal(formatSteeringForPrompt([]), '');
  });

  // **Validates: Requirements 7.1, 7.2**
  it('formats single doc with Project Context header and name sub-header', () => {
    const docs = [{ name: 'project-overview', body: 'Node.js app with Electron' }];
    const result = formatSteeringForPrompt(docs);

    assert.ok(result.includes('## Project Context'));
    assert.ok(result.includes('### project-overview'));
    assert.ok(result.includes('Node.js app with Electron'));
  });

  // **Validates: Requirements 7.1, 7.2**
  it('formats multiple docs with all names and bodies', () => {
    const docs = [
      { name: 'overview', body: 'Project overview content' },
      { name: 'tooling', body: 'ESLint and Prettier configured' },
      { name: 'framework', body: 'Uses Express.js' },
    ];
    const result = formatSteeringForPrompt(docs);

    assert.ok(result.includes('## Project Context'));
    for (const doc of docs) {
      assert.ok(result.includes(`### ${doc.name}`), `Should contain ### ${doc.name}`);
      assert.ok(result.includes(doc.body), `Should contain body for ${doc.name}`);
    }
  });

  // **Validates: Requirements 7.3**
  it('returns empty string for null input', () => {
    assert.equal(formatSteeringForPrompt(null), '');
  });

  // **Validates: Requirements 7.3**
  it('returns empty string for undefined input', () => {
    assert.equal(formatSteeringForPrompt(undefined), '');
  });
});


// --- Steering doc injection into agent system prompts ---
// **Validates: Requirements 7.1, 7.2, 7.3, 7.4**

describe('steering doc injection order in agent system prompt', () => {
  const path = require('node:path');

  // main.js requires Electron at top level — inject a mock before loading it
  // (same pattern as test/routing-decision.test.js)
  let buildRoutingInstructions;

  const electronMock = {
    app: { whenReady: () => ({ then: () => {} }), on: () => {}, quit: () => {} },
    BrowserWindow: class {},
    ipcMain: { handle: () => {}, on: () => {} },
    nativeTheme: { themeSource: 'dark' },
  };

  const mainPath = path.resolve(__dirname, '..', 'main.js');

  const cachedElectron = require.cache[require.resolve('electron')] ?? null;
  const cachedMain = require.cache[mainPath] ?? null;

  require.cache[require.resolve('electron')] = {
    id: require.resolve('electron'),
    filename: require.resolve('electron'),
    loaded: true,
    exports: electronMock,
  };
  delete require.cache[mainPath];

  try {
    buildRoutingInstructions = require(mainPath).buildRoutingInstructions;
  } finally {
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

  // **Validates: Requirements 7.1, 7.2, 7.4**
  it('steering docs appear after base prompt and before routing instructions', () => {
    // Simulate the agent factory assembly order from main.js:
    //   systemOverride = basePrompt
    //   systemOverride += steeringContent   (if any)
    //   systemOverride += routingInstructions (if branch)
    const basePrompt = 'You are a general-purpose coding agent.';

    const steeringDocs = [
      { name: 'project-overview', body: 'Node.js app with Electron' },
    ];
    const steeringContent = formatSteeringForPrompt(steeringDocs);

    const routableTasks = [
      { id: 'task-a', title: 'Option A' },
      { id: 'task-b', title: 'Option B' },
    ];
    const routingInstructions = buildRoutingInstructions(routableTasks);

    // Assemble in the same order as the agent factory
    const systemPrompt = basePrompt + '\n\n' + steeringContent + routingInstructions;

    // Base prompt comes first
    const baseIdx = systemPrompt.indexOf(basePrompt);
    assert.ok(baseIdx >= 0, 'Base prompt should be present');

    // Steering section comes after base prompt
    const steeringIdx = systemPrompt.indexOf('## Project Context');
    assert.ok(steeringIdx > baseIdx, '## Project Context should appear after base prompt');

    // Routing section comes after steering
    const routingIdx = systemPrompt.indexOf('## Routing Instructions');
    assert.ok(routingIdx > steeringIdx, '## Routing Instructions should appear after ## Project Context');
  });

  // **Validates: Requirements 7.3**
  it('no injection when no steering docs exist — no Project Context section', () => {
    const basePrompt = 'You are a general-purpose coding agent.';

    // Empty docs → formatSteeringForPrompt returns ''
    const steeringContent = formatSteeringForPrompt([]);
    assert.equal(steeringContent, '', 'Empty docs should produce empty string');

    // Assemble prompt without steering (mirrors agent factory: skip if empty)
    let systemPrompt = basePrompt;
    if (steeringContent) {
      systemPrompt += '\n\n' + steeringContent;
    }

    assert.ok(!systemPrompt.includes('## Project Context'),
      'System prompt should NOT contain ## Project Context when no docs exist');
  });

  // **Validates: Requirements 7.1, 7.2**
  it('multiple steering docs each get a sub-header in the prompt', () => {
    const docs = [
      { name: 'project-overview', body: 'Electron desktop app' },
      { name: 'tooling', body: 'ESLint and Prettier configured' },
    ];
    const steeringContent = formatSteeringForPrompt(docs);

    assert.ok(steeringContent.includes('## Project Context'));
    assert.ok(steeringContent.includes('### project-overview'));
    assert.ok(steeringContent.includes('### tooling'));
    assert.ok(steeringContent.includes('Electron desktop app'));
    assert.ok(steeringContent.includes('ESLint and Prettier configured'));
  });

  // **Validates: Requirements 7.3, 7.4**
  it('null and undefined docs produce no injection', () => {
    assert.equal(formatSteeringForPrompt(null), '');
    assert.equal(formatSteeringForPrompt(undefined), '');
  });
});
