'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Valid spec phases in order.
 */
const PHASE_ORDER = ['requirements', 'design', 'tasks', 'implementation'];

/**
 * Create a default SpecConfig object.
 */
function createSpecConfig(opts = {}) {
  return {
    specId: opts.specId || crypto.randomUUID(),
    workflowType: opts.workflowType || 'requirements-first',
    specType: opts.specType || 'feature',
    currentPhase: opts.currentPhase || 'requirements',
    created: opts.created || Date.now(),
    lastModified: opts.lastModified || Date.now(),
  };
}

/**
 * Initialize a new spec workflow.
 * Creates .maccoder/specs/{featureName}/ directory with a .config.maccoder file.
 *
 * @param {string} featureName - Name of the feature (used as directory name)
 * @param {string} projectDir - Root project directory
 * @returns {{ featureName: string, specDir: string, currentPhase: string, config: object }}
 */
function initSpec(featureName, projectDir) {
  if (!featureName || typeof featureName !== 'string') {
    throw new Error('featureName is required and must be a non-empty string');
  }
  if (!projectDir || typeof projectDir !== 'string') {
    throw new Error('projectDir is required and must be a non-empty string');
  }

  const safeName = featureName.replace(/\s+/g, '-').toLowerCase();
  const specDir = path.join(projectDir, '.maccoder', 'specs', safeName);

  fs.mkdirSync(specDir, { recursive: true });

  const config = createSpecConfig();
  const configPath = path.join(specDir, '.config.maccoder');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  return {
    featureName: safeName,
    specDir,
    currentPhase: config.currentPhase,
    config,
  };
}


/**
 * Read the spec config and return the current phase.
 *
 * @param {string} specDir - Path to the spec directory
 * @returns {string} Current phase
 */
function getSpecPhase(specDir) {
  const configPath = path.join(specDir, '.config.maccoder');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw);
  return config.currentPhase || 'requirements';
}

/**
 * Advance to the next phase in the sequence.
 * Phase order: requirements → design → tasks → implementation.
 * From implementation, no change.
 *
 * @param {string} specDir - Path to the spec directory
 * @returns {string} The new current phase
 */
function advancePhase(specDir) {
  const configPath = path.join(specDir, '.config.maccoder');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw);

  const currentIndex = PHASE_ORDER.indexOf(config.currentPhase);
  if (currentIndex === -1) {
    throw new Error(`Unknown phase: ${config.currentPhase}`);
  }

  // If already at implementation (last phase), don't change
  if (currentIndex < PHASE_ORDER.length - 1) {
    config.currentPhase = PHASE_ORDER[currentIndex + 1];
    config.lastModified = Date.now();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  return config.currentPhase;
}

/**
 * Read and return all existing spec artifact files.
 *
 * @param {string} specDir - Path to the spec directory
 * @returns {{ requirements?: string, design?: string, tasks?: string }}
 */
function getSpecArtifacts(specDir) {
  const artifacts = {};
  const files = {
    requirements: 'requirements.md',
    design: 'design.md',
    tasks: 'tasks.md',
  };

  for (const [key, filename] of Object.entries(files)) {
    const filePath = path.join(specDir, filename);
    if (fs.existsSync(filePath)) {
      artifacts[key] = fs.readFileSync(filePath, 'utf-8');
    }
  }

  return artifacts;
}

/**
 * Extract tasks from a design document and produce Tasks.md formatted content.
 * Looks for markdown headings and list items that describe implementation steps.
 *
 * @param {string} designMd - Design document markdown content
 * @returns {string} Tasks.md formatted content
 */
function generateTaskGraphFromDesign(designMd) {
  if (!designMd || typeof designMd !== 'string') {
    return '# Tasks\n';
  }

  const lines = designMd.split('\n');
  const tasks = [];
  let taskCounter = 0;
  let currentSection = null;
  let subTaskCounter = 0;

  for (const line of lines) {
    // Match component/section headings (## or ### level)
    const headingMatch = line.match(/^#{2,3}\s+(?:\d+\.\s+)?(.+)/);
    if (headingMatch) {
      const title = headingMatch[1].trim();
      // Skip generic headings
      if (/^(overview|architecture|error handling|testing|data models|correctness)/i.test(title)) {
        currentSection = null;
        continue;
      }
      taskCounter++;
      subTaskCounter = 0;
      currentSection = taskCounter;
      tasks.push({ id: String(taskCounter), title, depth: 0 });
      continue;
    }

    // Match list items under a section as sub-tasks
    if (currentSection !== null) {
      const listMatch = line.match(/^[-*]\s+(?:\*\*)?(.+?)(?:\*\*)?$/);
      if (listMatch) {
        subTaskCounter++;
        const subTitle = listMatch[1].replace(/\*\*/g, '').trim();
        tasks.push({
          id: `${currentSection}.${subTaskCounter}`,
          title: subTitle,
          depth: 1,
        });
      }
    }
  }

  if (tasks.length === 0) {
    return '# Tasks\n';
  }

  const taskLines = ['# Tasks', ''];
  for (const task of tasks) {
    const indent = '  '.repeat(task.depth);
    taskLines.push(`${indent}- [ ] ${task.id} ${task.title}`);
  }

  return taskLines.join('\n') + '\n';
}

module.exports = {
  PHASE_ORDER,
  createSpecConfig,
  initSpec,
  getSpecPhase,
  advancePhase,
  getSpecArtifacts,
  generateTaskGraphFromDesign,
};
