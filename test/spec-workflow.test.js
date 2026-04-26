'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  PHASE_ORDER,
  initSpec,
  getSpecPhase,
  advancePhase,
  getSpecArtifacts,
  generateTaskGraphFromDesign,
  listSpecs,
  deleteSpec,
} = require('../spec-workflow.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-workflow-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- 5.2.1 Test initSpec creates directory and config file ---

describe('initSpec', () => {
  it('creates spec directory and .config.maccoder file', () => {
    const result = initSpec('my-feature', tmpDir);

    assert.ok(fs.existsSync(result.specDir));
    const configPath = path.join(result.specDir, '.config.maccoder');
    assert.ok(fs.existsSync(configPath));

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(config.currentPhase, 'requirements');
    assert.equal(config.workflowType, 'requirements-first');
    assert.equal(config.specType, 'feature');
    assert.ok(config.specId);
    assert.ok(config.created);
    assert.ok(config.lastModified);
  });

  it('normalizes feature name to lowercase with dashes', () => {
    const result = initSpec('My Cool Feature', tmpDir);
    assert.equal(result.featureName, 'my-cool-feature');
    assert.ok(result.specDir.endsWith('my-cool-feature'));
  });

  it('returns correct initial phase', () => {
    const result = initSpec('test-feat', tmpDir);
    assert.equal(result.currentPhase, 'requirements');
  });

  it('throws on empty featureName', () => {
    assert.throws(() => initSpec('', tmpDir), /featureName is required/);
  });

  it('throws on missing projectDir', () => {
    assert.throws(() => initSpec('feat', ''), /projectDir is required/);
  });
});

// --- 5.2.2 Test phase transitions follow correct order ---

describe('getSpecPhase and advancePhase', () => {
  it('reads initial phase as requirements', () => {
    const { specDir } = initSpec('phase-test', tmpDir);
    assert.equal(getSpecPhase(specDir), 'requirements');
  });

  it('advances through all phases in order', () => {
    const { specDir } = initSpec('advance-test', tmpDir);

    assert.equal(getSpecPhase(specDir), 'requirements');

    const phase2 = advancePhase(specDir);
    assert.equal(phase2, 'design');
    assert.equal(getSpecPhase(specDir), 'design');

    const phase3 = advancePhase(specDir);
    assert.equal(phase3, 'tasks');
    assert.equal(getSpecPhase(specDir), 'tasks');

    const phase4 = advancePhase(specDir);
    assert.equal(phase4, 'implementation');
    assert.equal(getSpecPhase(specDir), 'implementation');
  });

  // --- 5.2.3 Test advancePhase from implementation does not change phase ---

  it('does not advance past implementation', () => {
    const { specDir } = initSpec('no-advance-test', tmpDir);

    // Advance to implementation
    advancePhase(specDir); // → design
    advancePhase(specDir); // → tasks
    advancePhase(specDir); // → implementation

    // Try to advance again — should stay at implementation
    const phase = advancePhase(specDir);
    assert.equal(phase, 'implementation');
    assert.equal(getSpecPhase(specDir), 'implementation');
  });

  it('throws when config file is missing', () => {
    assert.throws(
      () => getSpecPhase('/nonexistent/path'),
      /Config file not found/
    );
  });
});

// --- 5.2.4 Test getSpecArtifacts returns existing files ---

describe('getSpecArtifacts', () => {
  it('returns empty object when no artifacts exist', () => {
    const { specDir } = initSpec('no-artifacts', tmpDir);
    const artifacts = getSpecArtifacts(specDir);
    assert.deepEqual(artifacts, {});
  });

  it('returns requirements when file exists', () => {
    const { specDir } = initSpec('with-req', tmpDir);
    fs.writeFileSync(path.join(specDir, 'requirements.md'), '# Requirements\n', 'utf-8');

    const artifacts = getSpecArtifacts(specDir);
    assert.equal(artifacts.requirements, '# Requirements\n');
    assert.equal(artifacts.design, undefined);
    assert.equal(artifacts.tasks, undefined);
  });

  it('returns all artifacts when all files exist', () => {
    const { specDir } = initSpec('all-artifacts', tmpDir);
    fs.writeFileSync(path.join(specDir, 'requirements.md'), '# Req\n', 'utf-8');
    fs.writeFileSync(path.join(specDir, 'design.md'), '# Design\n', 'utf-8');
    fs.writeFileSync(path.join(specDir, 'tasks.md'), '# Tasks\n', 'utf-8');

    const artifacts = getSpecArtifacts(specDir);
    assert.equal(artifacts.requirements, '# Req\n');
    assert.equal(artifacts.design, '# Design\n');
    assert.equal(artifacts.tasks, '# Tasks\n');
  });
});

// --- generateTaskGraphFromDesign ---

describe('generateTaskGraphFromDesign', () => {
  it('returns header only for empty input', () => {
    assert.equal(generateTaskGraphFromDesign(''), '# Tasks\n');
    assert.equal(generateTaskGraphFromDesign(null), '# Tasks\n');
  });

  it('extracts tasks from design headings and list items', () => {
    const design = [
      '## Component A',
      '- Implement feature X',
      '- Implement feature Y',
      '## Component B',
      '- Implement feature Z',
    ].join('\n');

    const result = generateTaskGraphFromDesign(design);
    assert.ok(result.includes('- [ ] 1 Component A'));
    assert.ok(result.includes('  - [ ] 1.1 Implement feature X'));
    assert.ok(result.includes('  - [ ] 1.2 Implement feature Y'));
    assert.ok(result.includes('- [ ] 2 Component B'));
    assert.ok(result.includes('  - [ ] 2.1 Implement feature Z'));
  });

  it('skips generic headings like Overview and Architecture', () => {
    const design = [
      '## Overview',
      '- Some overview item',
      '## Architecture',
      '- Some arch item',
      '## Real Component',
      '- Real task',
    ].join('\n');

    const result = generateTaskGraphFromDesign(design);
    assert.ok(!result.includes('Overview'));
    assert.ok(!result.includes('Architecture'));
    assert.ok(result.includes('Real Component'));
  });
});

// --- listSpecs ---

describe('listSpecs', () => {
  it('returns empty array when no specs directory exists', () => {
    const result = listSpecs(tmpDir);
    assert.deepEqual(result, []);
  });

  it('returns empty array when specs directory is empty', () => {
    fs.mkdirSync(path.join(tmpDir, '.maccoder', 'specs'), { recursive: true });
    const result = listSpecs(tmpDir);
    assert.deepEqual(result, []);
  });

  it('lists a single spec with config', () => {
    initSpec('alpha', tmpDir);
    const result = listSpecs(tmpDir);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'alpha');
    assert.equal(result[0].currentPhase, 'requirements');
    assert.ok(result[0].specDir.endsWith('alpha'));
    assert.ok(result[0].config);
  });

  it('lists multiple specs sorted by lastModified descending', () => {
    const a = initSpec('aaa', tmpDir);
    const b = initSpec('bbb', tmpDir);
    // Manually bump bbb's lastModified to be older
    const configPath = path.join(b.specDir, '.config.maccoder');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config.lastModified = 1000;
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8');

    const result = listSpecs(tmpDir);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'aaa'); // newer
    assert.equal(result[1].name, 'bbb'); // older
  });

  it('lists specs even when config is missing', () => {
    initSpec('has-config', tmpDir);
    // Create a spec dir without config
    const noConfigDir = path.join(tmpDir, '.maccoder', 'specs', 'no-config');
    fs.mkdirSync(noConfigDir, { recursive: true });

    const result = listSpecs(tmpDir);
    assert.equal(result.length, 2);
    const noConfig = result.find(s => s.name === 'no-config');
    assert.ok(noConfig);
    assert.equal(noConfig.currentPhase, 'requirements');
    assert.equal(noConfig.config, null);
  });

  it('throws on missing projectDir', () => {
    assert.throws(() => listSpecs(''), /projectDir is required/);
  });
});

// --- deleteSpec ---

describe('deleteSpec', () => {
  it('deletes an existing spec directory', () => {
    const { specDir } = initSpec('to-delete', tmpDir);
    assert.ok(fs.existsSync(specDir));

    const result = deleteSpec('to-delete', tmpDir);
    assert.equal(result.deleted, true);
    assert.ok(!fs.existsSync(specDir));
  });

  it('deletes spec with artifacts', () => {
    const { specDir } = initSpec('with-files', tmpDir);
    fs.writeFileSync(path.join(specDir, 'requirements.md'), '# Req', 'utf-8');
    fs.writeFileSync(path.join(specDir, 'design.md'), '# Design', 'utf-8');

    deleteSpec('with-files', tmpDir);
    assert.ok(!fs.existsSync(specDir));
  });

  it('normalizes spec name before deleting', () => {
    initSpec('My Feature', tmpDir);
    const result = deleteSpec('My Feature', tmpDir);
    assert.equal(result.deleted, true);
  });

  it('throws when spec does not exist', () => {
    assert.throws(() => deleteSpec('nonexistent', tmpDir), /Spec not found/);
  });

  it('throws on empty specName', () => {
    assert.throws(() => deleteSpec('', tmpDir), /specName is required/);
  });

  it('throws on missing projectDir', () => {
    assert.throws(() => deleteSpec('foo', ''), /projectDir is required/);
  });

  it('does not affect other specs', () => {
    initSpec('keep-me', tmpDir);
    initSpec('delete-me', tmpDir);

    deleteSpec('delete-me', tmpDir);

    const remaining = listSpecs(tmpDir);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].name, 'keep-me');
  });
});
