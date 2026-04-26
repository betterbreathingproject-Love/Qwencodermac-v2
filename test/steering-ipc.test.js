'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// --- Helpers ---

/** Create a temp directory for a mock project */
function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'steering-ipc-test-'));
}

/** Remove a directory recursively */
function cleanUp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/** Write a package.json into a project directory */
function writePackageJson(projectDir, pkg) {
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
}

/**
 * Build a mock ipcMain that captures registered handlers.
 * Call handlers via mockIpc.invoke(channel, ...args).
 */
function createMockIpc() {
  const handlers = {};
  return {
    handle(channel, fn) { handlers[channel] = fn; },
    async invoke(channel, ...args) {
      const fn = handlers[channel];
      if (!fn) throw new Error(`No handler for channel: ${channel}`);
      // First arg to handler is the IPC event object (unused), rest are the args
      return fn({}, ...args);
    },
  };
}

/**
 * Build a mock mainWindow that captures webContents.send() calls.
 */
function createMockWindow() {
  const sent = [];
  return {
    sent,
    webContents: {
      send(channel, data) { sent.push({ channel, data }); },
    },
  };
}

/** Mock agentPool that returns canned output */
function createMockPool() {
  return {
    async dispatch(_task, _context) {
      return { output: 'Mock agent analysis output', duration: 100, agentType: 'explore' };
    },
  };
}

// --- Tests ---

// **Validates: Requirements 8.2, 8.3, 8.4**
describe('steering-generate IPC handler', () => {
  let projectDir;
  let mockIpc;
  let mockWindow;
  let mockPool;

  beforeEach(() => {
    projectDir = makeTempProject();
    writePackageJson(projectDir, {
      name: 'ipc-test-app',
      description: 'Test app for IPC',
      main: 'index.js',
      dependencies: { express: '^4.18.0' },
      scripts: { start: 'node index.js', test: 'node --test' },
    });

    mockIpc = createMockIpc();
    mockWindow = createMockWindow();
    mockPool = createMockPool();

    const { register } = require('../main/ipc-tasks.js');
    register(mockIpc, {
      getMainWindow: () => mockWindow,
      getCurrentProject: () => projectDir,
      getAgentPool: () => mockPool,
      findPython: () => 'python3',
    });
  });

  afterEach(() => cleanUp(projectDir));

  it('returns { ok: true, docsGenerated: [...] } for valid projectDir', async () => {
    const result = await mockIpc.invoke('steering-generate', { projectDir });

    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.docsGenerated));
    assert.ok(result.docsGenerated.includes('project-overview.md'));
  });

  it('returns error when projectDir is missing', async () => {
    const result = await mockIpc.invoke('steering-generate', {});

    assert.ok(result.error);
    assert.equal(result.error, 'projectDir is required');
  });

  it('returns error when called with no arguments', async () => {
    const result = await mockIpc.invoke('steering-generate');

    assert.ok(result.error);
    assert.equal(result.error, 'projectDir is required');
  });

  it('emits steering-progress events during generation', async () => {
    await mockIpc.invoke('steering-generate', { projectDir });

    const progressEvents = mockWindow.sent.filter(e => e.channel === 'steering-progress');
    assert.ok(progressEvents.length >= 3, `Expected at least 3 progress events, got ${progressEvents.length}`);

    const stages = progressEvents.map(e => e.data.stage);
    assert.ok(stages.includes('starting'), 'Should emit starting stage');
    assert.ok(stages.includes('analyzing'), 'Should emit analyzing stage');
    assert.ok(stages.includes('complete'), 'Should emit complete stage');
  });

  it('emits progress events in correct order: starting → analyzing → complete', async () => {
    await mockIpc.invoke('steering-generate', { projectDir });

    const progressEvents = mockWindow.sent.filter(e => e.channel === 'steering-progress');
    const stages = progressEvents.map(e => e.data.stage);

    const startIdx = stages.indexOf('starting');
    const analyzeIdx = stages.indexOf('analyzing');
    const completeIdx = stages.indexOf('complete');

    assert.ok(startIdx < analyzeIdx, 'starting should come before analyzing');
    assert.ok(analyzeIdx < completeIdx, 'analyzing should come before complete');
  });

  it('writes steering docs to .maccoder/steering/ directory', async () => {
    await mockIpc.invoke('steering-generate', { projectDir });

    const steeringDir = path.join(projectDir, '.maccoder', 'steering');
    assert.ok(fs.existsSync(steeringDir), '.maccoder/steering/ should exist');

    const overviewPath = path.join(steeringDir, 'project-overview.md');
    assert.ok(fs.existsSync(overviewPath), 'project-overview.md should exist');
  });
});

// **Validates: Requirements 8.3**
describe('steering-status IPC handler', () => {
  let projectDir;
  let mockIpc;
  let mockWindow;
  let mockPool;

  beforeEach(() => {
    projectDir = makeTempProject();
    mockIpc = createMockIpc();
    mockWindow = createMockWindow();
    mockPool = createMockPool();

    const { register } = require('../main/ipc-tasks.js');
    register(mockIpc, {
      getMainWindow: () => mockWindow,
      getCurrentProject: () => projectDir,
      getAgentPool: () => mockPool,
      findPython: () => 'python3',
    });
  });

  afterEach(() => cleanUp(projectDir));

  it('returns { exists: false, docCount: 0 } when no .maccoder/steering/ exists', async () => {
    const result = await mockIpc.invoke('steering-status', { projectDir });

    assert.equal(result.exists, false);
    assert.equal(result.docCount, 0);
  });

  it('returns { exists: true, docCount: N } when .maccoder/steering/ has .md files', async () => {
    // Create steering dir with some docs
    const steeringDir = path.join(projectDir, '.maccoder', 'steering');
    fs.mkdirSync(steeringDir, { recursive: true });
    fs.writeFileSync(path.join(steeringDir, 'project-overview.md'), '---\nname: project-overview\n---\n# Overview', 'utf8');
    fs.writeFileSync(path.join(steeringDir, 'tooling.md'), '---\nname: tooling\n---\n# Tooling', 'utf8');

    const result = await mockIpc.invoke('steering-status', { projectDir });

    assert.equal(result.exists, true);
    assert.equal(result.docCount, 2);
  });

  it('uses getCurrentProject when projectDir is not provided', async () => {
    // Create steering dir in the current project
    const steeringDir = path.join(projectDir, '.maccoder', 'steering');
    fs.mkdirSync(steeringDir, { recursive: true });
    fs.writeFileSync(path.join(steeringDir, 'overview.md'), '# Overview', 'utf8');

    const result = await mockIpc.invoke('steering-status', {});

    assert.equal(result.exists, true);
    assert.equal(result.docCount, 1);
  });
});

// **Validates: Requirements 8.1**
describe('steering-prompt on project open', () => {
  let projectDir;
  let mockWindow;

  beforeEach(() => {
    projectDir = makeTempProject();
    mockWindow = createMockWindow();
  });

  afterEach(() => cleanUp(projectDir));

  it('emits steering-prompt when project has no .maccoder/steering/ directory', () => {
    const { checkSteeringPrompt } = require('../main/ipc-projects.js');
    checkSteeringPrompt(projectDir, () => mockWindow);

    const promptEvents = mockWindow.sent.filter(e => e.channel === 'steering-prompt');
    assert.equal(promptEvents.length, 1);
    assert.equal(promptEvents[0].data.projectDir, projectDir);
    assert.ok(promptEvents[0].data.message);
  });

  it('does not emit steering-prompt when .maccoder/steering/ exists', () => {
    const steeringDir = path.join(projectDir, '.maccoder', 'steering');
    fs.mkdirSync(steeringDir, { recursive: true });

    const { checkSteeringPrompt } = require('../main/ipc-projects.js');
    checkSteeringPrompt(projectDir, () => mockWindow);

    const promptEvents = mockWindow.sent.filter(e => e.channel === 'steering-prompt');
    assert.equal(promptEvents.length, 0);
  });
});
