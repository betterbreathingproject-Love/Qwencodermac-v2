'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  generateSteeringDocs,
  readPackageJson,
  findToolConfigs,
  detectFrameworks,
  generateProjectOverview,
  generateFrameworkDoc,
  generateToolingDoc,
} = require('../steering-generator.js');

// --- Helpers ---

/** Create a temp directory for a mock project */
function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'steering-gen-test-'));
}

/** Remove a directory recursively */
function cleanUp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) {
    // ignore cleanup errors
  }
}

/** Mock agentPool that returns canned output */
const mockPool = {
  async dispatch(_task, _context) {
    return { output: 'Mock agent analysis output', duration: 100, agentType: 'explore' };
  },
};

/** Write a package.json into a project directory */
function writePackageJson(projectDir, pkg) {
  fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
}

/** Read a generated steering doc from .maccoder/steering/ */
function readSteeringFile(projectDir, filename) {
  return fs.readFileSync(path.join(projectDir, '.maccoder', 'steering', filename), 'utf8');
}

// --- Tests ---

// **Validates: Requirements 5.1, 5.2, 5.3**
describe('generateSteeringDocs — project with package.json', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = makeTempProject();
    writePackageJson(projectDir, {
      name: 'test-app',
      description: 'A test application',
      main: 'index.js',
      dependencies: { express: '^4.18.0' },
      devDependencies: { jest: '^29.0.0' },
      scripts: { start: 'node index.js', test: 'jest' },
    });
  });

  afterEach(() => cleanUp(projectDir));

  it('creates project-overview.md in .maccoder/steering/', async () => {
    const result = await generateSteeringDocs(projectDir, mockPool);

    assert.ok(result.docsGenerated.includes('project-overview.md'));
    const content = readSteeringFile(projectDir, 'project-overview.md');
    assert.ok(content.includes('name: project-overview'));
    assert.ok(content.includes('auto_generated: true'));
    assert.ok(content.includes('## Tech Stack'));
    assert.ok(content.includes('express'));
  });

  it('returns projectDir and docsGenerated in result', async () => {
    const result = await generateSteeringDocs(projectDir, mockPool);

    assert.equal(result.projectDir, projectDir);
    assert.ok(Array.isArray(result.docsGenerated));
    assert.ok(result.docsGenerated.length >= 1);
    assert.ok(Array.isArray(result.errors));
  });
});

// **Validates: Requirements 5.4**
describe('generateSteeringDocs — Electron project', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = makeTempProject();
    writePackageJson(projectDir, {
      name: 'electron-app',
      description: 'An Electron desktop app',
      main: 'main.js',
      dependencies: { electron: '^28.0.0' },
      devDependencies: { 'electron-builder': '^24.0.0' },
    });
  });

  afterEach(() => cleanUp(projectDir));

  it('creates electron.md framework doc', async () => {
    const result = await generateSteeringDocs(projectDir, mockPool);

    assert.ok(result.docsGenerated.includes('electron.md'));
    const content = readSteeringFile(projectDir, 'electron.md');
    assert.ok(content.includes('name: electron'));
    assert.ok(content.includes('auto_generated: true'));
    assert.ok(content.includes('Electron'));
    assert.ok(content.includes('IPC'));
  });
});

// **Validates: Requirements 5.5**
describe('generateSteeringDocs — project with ESLint config', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = makeTempProject();
    writePackageJson(projectDir, {
      name: 'lint-project',
      dependencies: {},
      devDependencies: { eslint: '^8.0.0' },
    });
    // Create an .eslintrc.json config file
    fs.writeFileSync(path.join(projectDir, '.eslintrc.json'), '{ "extends": "eslint:recommended" }', 'utf8');
  });

  afterEach(() => cleanUp(projectDir));

  it('creates tooling.md steering doc', async () => {
    const result = await generateSteeringDocs(projectDir, mockPool);

    assert.ok(result.docsGenerated.includes('tooling.md'));
    const content = readSteeringFile(projectDir, 'tooling.md');
    assert.ok(content.includes('name: tooling'));
    assert.ok(content.includes('auto_generated: true'));
    assert.ok(content.includes('.eslintrc.json'));
    assert.ok(content.includes('Linting'));
  });
});

// **Validates: Requirements 5.6**
describe('generateSteeringDocs — regeneration overwrites existing docs', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = makeTempProject();
    writePackageJson(projectDir, {
      name: 'regen-project',
      description: 'First run',
      dependencies: {},
    });
  });

  afterEach(() => cleanUp(projectDir));

  it('second run overwrites project-overview.md with updated content', async () => {
    // First generation
    await generateSteeringDocs(projectDir, mockPool);
    const firstContent = readSteeringFile(projectDir, 'project-overview.md');
    assert.ok(firstContent.includes('regen-project'));

    // Update package.json and regenerate
    writePackageJson(projectDir, {
      name: 'regen-project-v2',
      description: 'Second run',
      dependencies: { react: '^18.0.0' },
    });

    const result = await generateSteeringDocs(projectDir, mockPool);
    assert.ok(result.docsGenerated.includes('project-overview.md'));

    const secondContent = readSteeringFile(projectDir, 'project-overview.md');
    assert.ok(secondContent.includes('regen-project-v2'));
    // Content should differ from first run
    assert.notEqual(firstContent, secondContent);
  });
});

// **Validates: Requirements 5.1 (error handling)**
describe('generateSteeringDocs — non-existent projectDir', () => {
  it('throws an error for a non-existent directory', async () => {
    const badDir = path.join(os.tmpdir(), 'does-not-exist-' + Date.now());
    await assert.rejects(
      () => generateSteeringDocs(badDir, mockPool),
      (err) => {
        assert.ok(err.message.includes('does not exist'));
        return true;
      }
    );
  });
});

// **Validates: Requirements 5.1, 5.2**
describe('generateSteeringDocs — agent dispatch failure', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = makeTempProject();
    writePackageJson(projectDir, {
      name: 'fail-project',
      dependencies: {},
    });
  });

  afterEach(() => cleanUp(projectDir));

  it('records error but still generates project-overview.md', async () => {
    const failingPool = {
      async dispatch() {
        throw new Error('Agent pool unavailable');
      },
    };

    const result = await generateSteeringDocs(projectDir, failingPool);

    // Error should be recorded
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some((e) => e.includes('Agent dispatch failed')));

    // project-overview.md should still be generated from local analysis
    assert.ok(result.docsGenerated.includes('project-overview.md'));
    const content = readSteeringFile(projectDir, 'project-overview.md');
    assert.ok(content.includes('name: project-overview'));
  });
});
