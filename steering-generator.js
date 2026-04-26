'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { printSteeringDoc } = require('./steering-loader');

// --- Constants ---

/** Config file patterns to detect tooling */
const TOOL_CONFIG_PATTERNS = [
  '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
  '.prettierrc', '.prettierrc.js', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml',
  'prettier.config.js', 'prettier.config.mjs', 'prettier.config.cjs',
  'tsconfig.json', 'tsconfig.build.json',
  'jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs',
  'vitest.config.js', 'vitest.config.ts', 'vitest.config.mjs',
  '.babelrc', 'babel.config.js', 'babel.config.json',
  'webpack.config.js', 'rollup.config.js', 'vite.config.js', 'vite.config.ts',
  '.stylelintrc', '.stylelintrc.json',
];

/** Framework detection from package.json dependencies */
const FRAMEWORK_DETECTORS = {
  electron: (deps) => 'electron' in deps,
  react: (deps) => 'react' in deps,
  'next': (deps) => 'next' in deps,
  vue: (deps) => 'vue' in deps,
  nuxt: (deps) => 'nuxt' in deps,
  angular: (deps) => '@angular/core' in deps,
  express: (deps) => 'express' in deps,
  fastify: (deps) => 'fastify' in deps,
  svelte: (deps) => 'svelte' in deps,
};

// --- Helpers ---

/**
 * Read package.json from a project directory. Returns null if not found.
 * @param {string} projectDir
 * @returns {object|null}
 */
function readPackageJson(projectDir) {
  try {
    const content = fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8');
    return JSON.parse(content);
  } catch (_err) {
    return null;
  }
}

/**
 * Find which tool config files exist in the project directory.
 * @param {string} projectDir
 * @returns {string[]} list of found config filenames
 */
function findToolConfigs(projectDir) {
  const found = [];
  for (const pattern of TOOL_CONFIG_PATTERNS) {
    try {
      fs.accessSync(path.join(projectDir, pattern));
      found.push(pattern);
    } catch (_err) {
      // not found, skip
    }
  }
  return found;
}

/**
 * Detect frameworks from package.json dependencies.
 * @param {object} pkg - parsed package.json
 * @returns {string[]} detected framework names
 */
function detectFrameworks(pkg) {
  if (!pkg) return [];
  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  const detected = [];
  for (const [name, detector] of Object.entries(FRAMEWORK_DETECTORS)) {
    if (detector(allDeps)) {
      detected.push(name);
    }
  }
  return detected;
}

/**
 * Get a list of top-level directories in the project.
 * @param {string} projectDir
 * @returns {string[]}
 */
function getTopLevelDirs(projectDir) {
  try {
    const entries = fs.readdirSync(projectDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name);
  } catch (_err) {
    return [];
  }
}

/**
 * Get a list of top-level files in the project (non-hidden, non-lock).
 * @param {string} projectDir
 * @returns {string[]}
 */
function getTopLevelFiles(projectDir) {
  try {
    const entries = fs.readdirSync(projectDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith('.') && !e.name.includes('lock'))
      .map((e) => e.name);
  } catch (_err) {
    return [];
  }
}

// --- Agent Dispatch ---

/**
 * Build the explore task for the agent pool.
 * @param {string} projectDir
 * @returns {object} task object for agentPool.dispatch
 */
function buildExploreTask(projectDir) {
  return {
    id: 'steering-explore',
    title: 'Analyze project for steering doc generation',
    type: 'explore',
    cwd: projectDir,
    metadata: { category: 'explore' },
  };
}

/**
 * Build context for the explore agent dispatch.
 * @param {string} projectDir
 * @param {object|null} pkg - parsed package.json
 * @param {string[]} toolConfigs - found tool config filenames
 * @param {string[]} dirs - top-level directories
 * @param {string[]} files - top-level files
 * @returns {object}
 */
function buildExploreContext(projectDir, pkg, toolConfigs, dirs, files) {
  return {
    projectDir,
    packageJson: pkg,
    toolConfigs,
    directories: dirs,
    files,
  };
}

// --- Doc Generation ---

/**
 * Generate the project-overview.md content.
 * @param {object|null} pkg - parsed package.json
 * @param {string[]} frameworks - detected framework names
 * @param {string[]} dirs - top-level directories
 * @param {string[]} files - top-level files
 * @param {string} agentOutput - raw agent output (may contain extra insights)
 * @returns {{ frontMatter: object, body: string }}
 */
function generateProjectOverview(pkg, frameworks, dirs, files, agentOutput) {
  const name = pkg?.name || 'unknown';
  const description = pkg?.description || '';

  let body = '';

  // Tech stack section
  body += '## Tech Stack\n\n';
  if (frameworks.length > 0) {
    body += `- Frameworks: ${frameworks.join(', ')}\n`;
  }
  if (pkg?.dependencies) {
    const depNames = Object.keys(pkg.dependencies).slice(0, 15);
    if (depNames.length > 0) {
      body += `- Key dependencies: ${depNames.join(', ')}\n`;
    }
  }
  if (pkg?.devDependencies) {
    const devDepNames = Object.keys(pkg.devDependencies).slice(0, 10);
    if (devDepNames.length > 0) {
      body += `- Dev dependencies: ${devDepNames.join(', ')}\n`;
    }
  }
  body += '\n';

  // Project structure section
  body += '## Project Structure\n\n';
  if (dirs.length > 0) {
    body += `- Directories: ${dirs.join(', ')}\n`;
  }
  if (files.length > 0) {
    body += `- Top-level files: ${files.join(', ')}\n`;
  }
  body += '\n';

  // Entry points section
  body += '## Entry Points\n\n';
  if (pkg?.main) {
    body += `- Main: \`${pkg.main}\`\n`;
  }
  if (pkg?.scripts) {
    const scriptNames = Object.keys(pkg.scripts).slice(0, 10);
    if (scriptNames.length > 0) {
      body += `- Scripts: ${scriptNames.join(', ')}\n`;
    }
  }
  body += '\n';

  // Description
  if (description) {
    body += `## Description\n\n${description}\n`;
  }

  const frontMatter = {
    name: 'project-overview',
    description: `Auto-generated project overview for ${name}`,
    auto_generated: true,
  };

  return { frontMatter, body };
}

/**
 * Generate a framework-specific steering doc.
 * @param {string} framework - framework name (e.g. 'react', 'electron')
 * @param {object|null} pkg - parsed package.json
 * @returns {{ frontMatter: object, body: string }}
 */
function generateFrameworkDoc(framework, pkg) {
  let body = `## ${framework.charAt(0).toUpperCase() + framework.slice(1)} Project\n\n`;
  body += `This project uses ${framework}.\n\n`;

  // Add framework-specific guidance
  const guidance = getFrameworkGuidance(framework);
  if (guidance) {
    body += '## Conventions\n\n';
    body += guidance + '\n';
  }

  // Add relevant dependencies
  const allDeps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const relatedDeps = Object.keys(allDeps).filter((dep) => dep.includes(framework) || isRelatedDep(framework, dep));
  if (relatedDeps.length > 0) {
    body += `\n## Related Dependencies\n\n`;
    body += relatedDeps.map((d) => `- ${d}: ${allDeps[d]}`).join('\n') + '\n';
  }

  const frontMatter = {
    name: framework,
    description: `Auto-generated ${framework} framework conventions and patterns`,
    auto_generated: true,
  };

  return { frontMatter, body };
}

/**
 * Get framework-specific guidance text.
 * @param {string} framework
 * @returns {string}
 */
function getFrameworkGuidance(framework) {
  const guidance = {
    electron: '- Main process and renderer process separation\n- Use IPC for cross-process communication\n- Preload scripts for secure context bridging',
    react: '- Component-based architecture\n- Use hooks for state management\n- Follow JSX conventions',
    next: '- File-based routing in pages/ or app/ directory\n- Server-side rendering and static generation\n- API routes in pages/api/ or app/api/',
    vue: '- Single-file components (.vue)\n- Composition API or Options API\n- Reactive data binding',
    nuxt: '- File-based routing\n- Server-side rendering\n- Auto-imports for composables and components',
    angular: '- Module-based architecture\n- Dependency injection\n- TypeScript required',
    express: '- Middleware-based request handling\n- Router for route organization\n- Error handling middleware pattern',
    fastify: '- Plugin-based architecture\n- Schema-based validation\n- Hooks for request lifecycle',
    svelte: '- Compiler-based framework\n- Reactive declarations\n- Scoped styles by default',
  };
  return guidance[framework] || '';
}

/**
 * Check if a dependency is related to a framework.
 * @param {string} framework
 * @param {string} dep
 * @returns {boolean}
 */
function isRelatedDep(framework, dep) {
  const relatedPatterns = {
    electron: ['electron-'],
    react: ['react-', '@react-', 'redux', 'zustand', 'recoil'],
    next: ['next-', '@next/'],
    vue: ['vue-', '@vue/', 'vuex', 'pinia'],
    nuxt: ['nuxt-', '@nuxt/'],
    angular: ['@angular/', 'rxjs', 'zone.js'],
    express: ['express-', 'body-parser', 'cors', 'helmet', 'morgan'],
    fastify: ['fastify-', '@fastify/'],
    svelte: ['svelte-', '@sveltejs/'],
  };
  const patterns = relatedPatterns[framework] || [];
  return patterns.some((p) => dep.startsWith(p) || dep === p);
}

/**
 * Generate the tooling.md steering doc.
 * @param {string[]} toolConfigs - found config filenames
 * @param {object|null} pkg - parsed package.json
 * @returns {{ frontMatter: object, body: string }}
 */
function generateToolingDoc(toolConfigs, pkg) {
  let body = '## Configured Tools\n\n';

  // Group configs by tool category
  const categories = categorizeToolConfigs(toolConfigs);

  for (const [category, configs] of Object.entries(categories)) {
    body += `### ${category}\n\n`;
    body += configs.map((c) => `- \`${c}\``).join('\n') + '\n\n';
  }

  // Add test runner info from scripts
  if (pkg?.scripts) {
    const testScript = pkg.scripts.test;
    if (testScript) {
      body += '### Testing\n\n';
      body += `- Test command: \`${testScript}\`\n\n`;
    }
  }

  body += '## Agent Guidelines\n\n';
  body += '- Respect existing linting and formatting configurations\n';
  body += '- Follow the TypeScript configuration if tsconfig.json is present\n';
  body += '- Run tests using the configured test runner\n';

  const frontMatter = {
    name: 'tooling',
    description: 'Auto-generated tooling configuration summary',
    auto_generated: true,
  };

  return { frontMatter, body };
}

/**
 * Categorize tool config files by tool type.
 * @param {string[]} configs
 * @returns {Object<string, string[]>}
 */
function categorizeToolConfigs(configs) {
  const categories = {};
  for (const config of configs) {
    let category = 'Other';
    if (config.includes('eslint')) category = 'Linting';
    else if (config.includes('prettier') || config.includes('stylelint')) category = 'Formatting';
    else if (config.includes('tsconfig')) category = 'TypeScript';
    else if (config.includes('jest') || config.includes('vitest')) category = 'Testing';
    else if (config.includes('babel')) category = 'Transpilation';
    else if (config.includes('webpack') || config.includes('rollup') || config.includes('vite')) category = 'Bundling';

    if (!categories[category]) categories[category] = [];
    categories[category].push(config);
  }
  return categories;
}

// --- Main Generator ---

/**
 * Generate steering docs for a project by dispatching an explore agent and
 * analyzing the project structure.
 *
 * @param {string} projectDir - Absolute path to the project root
 * @param {object} agentPool - AgentPool instance for dispatching explore agent
 * @returns {Promise<{ projectDir: string, docsGenerated: string[], errors: string[] }>}
 */
async function generateSteeringDocs(projectDir, agentPool) {
  // Validate projectDir exists
  if (!projectDir || typeof projectDir !== 'string') {
    throw new Error('projectDir is required and must be a string');
  }
  try {
    fs.accessSync(projectDir);
  } catch (_err) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }

  const result = {
    projectDir,
    docsGenerated: [],
    errors: [],
  };

  // 1. Read project files for local analysis
  const pkg = readPackageJson(projectDir);
  const toolConfigs = findToolConfigs(projectDir);
  const dirs = getTopLevelDirs(projectDir);
  const files = getTopLevelFiles(projectDir);
  const frameworks = detectFrameworks(pkg);

  // 2. Dispatch explore agent for deeper analysis
  let agentOutput = '';
  try {
    const task = buildExploreTask(projectDir);
    const context = buildExploreContext(projectDir, pkg, toolConfigs, dirs, files);
    const agentResult = await agentPool.dispatch(task, context);
    agentOutput = agentResult?.output || '';
  } catch (err) {
    result.errors.push(`Agent dispatch failed: ${err.message || String(err)}`);
  }

  // 3. Ensure .kiro/steering/ directory exists
  const steeringDir = path.join(projectDir, '.kiro', 'steering');
  try {
    fs.mkdirSync(steeringDir, { recursive: true });
  } catch (err) {
    result.errors.push(`Failed to create steering directory: ${err.message}`);
    return result;
  }

  // 4. Generate and write project-overview.md (always)
  try {
    const { frontMatter, body } = generateProjectOverview(pkg, frameworks, dirs, files, agentOutput);
    const content = printSteeringDoc(frontMatter, body);
    const filePath = path.join(steeringDir, 'project-overview.md');
    fs.writeFileSync(filePath, content, 'utf8');
    result.docsGenerated.push('project-overview.md');
  } catch (err) {
    result.errors.push(`Failed to write project-overview.md: ${err.message}`);
  }

  // 5. Generate framework-specific doc if framework detected
  for (const framework of frameworks) {
    try {
      const { frontMatter, body } = generateFrameworkDoc(framework, pkg);
      const content = printSteeringDoc(frontMatter, body);
      const filename = `${framework}.md`;
      const filePath = path.join(steeringDir, filename);
      fs.writeFileSync(filePath, content, 'utf8');
      result.docsGenerated.push(filename);
    } catch (err) {
      result.errors.push(`Failed to write ${framework}.md: ${err.message}`);
    }
  }

  // 6. Generate tooling.md if tool config files found
  if (toolConfigs.length > 0) {
    try {
      const { frontMatter, body } = generateToolingDoc(toolConfigs, pkg);
      const content = printSteeringDoc(frontMatter, body);
      const filePath = path.join(steeringDir, 'tooling.md');
      fs.writeFileSync(filePath, content, 'utf8');
      result.docsGenerated.push('tooling.md');
    } catch (err) {
      result.errors.push(`Failed to write tooling.md: ${err.message}`);
    }
  }

  return result;
}

// --- Exports ---

module.exports = {
  generateSteeringDocs,
  // Exported for testing
  readPackageJson,
  findToolConfigs,
  detectFrameworks,
  getTopLevelDirs,
  getTopLevelFiles,
  buildExploreTask,
  buildExploreContext,
  generateProjectOverview,
  generateFrameworkDoc,
  generateToolingDoc,
  categorizeToolConfigs,
  getFrameworkGuidance,
  isRelatedDep,
  TOOL_CONFIG_PATTERNS,
  FRAMEWORK_DETECTORS,
};
