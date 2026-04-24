'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// --- Language detection ---

const EXTENSION_MAP = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.json': 'json',
};

const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_MAP);

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] || null;
}

// --- Backend detection ---

let _cachedBackend = null;

function detectBackend() {
  if (_cachedBackend) return _cachedBackend;

  // Try ast-grep (sg)
  try {
    const ver = execFileSync('sg', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    _cachedBackend = { backend: 'ast-grep', version: ver, path: findBinaryPath('sg') };
    return _cachedBackend;
  } catch (_) { /* not available */ }

  // Try ripgrep (rg)
  try {
    const ver = execFileSync('rg', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
    _cachedBackend = { backend: 'ripgrep', version: ver, path: findBinaryPath('rg') };
    return _cachedBackend;
  } catch (_) { /* not available */ }

  // Fallback to builtin
  _cachedBackend = { backend: 'builtin', version: null, path: null };
  return _cachedBackend;
}

function findBinaryPath(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return execFileSync(cmd, [name], { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0];
  } catch (_) {
    return null;
  }
}


/** Reset cached backend (useful for testing) */
function resetBackendCache() {
  _cachedBackend = null;
}

// --- Pattern validation ---

function validatePattern(pattern, language) {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    return { valid: false, error: 'Pattern must be a non-empty string' };
  }

  // Check for unbalanced brackets/parens/braces
  const brackets = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  const closers = new Set(Object.values(brackets));

  for (const ch of pattern) {
    if (brackets[ch]) {
      stack.push(brackets[ch]);
    } else if (closers.has(ch)) {
      if (stack.length === 0 || stack.pop() !== ch) {
        return { valid: false, error: `Unbalanced bracket: unexpected '${ch}' in pattern` };
      }
    }
  }
  if (stack.length > 0) {
    return { valid: false, error: `Unbalanced bracket: expected '${stack[stack.length - 1]}' before end of pattern` };
  }

  // Check for invalid regex if used in builtin/ripgrep mode
  // For ast-grep patterns, most strings are valid structural patterns
  // We just do basic sanity checks
  if (pattern.includes('\0')) {
    return { valid: false, error: 'Pattern must not contain null bytes' };
  }

  // Language-specific checks
  if (language) {
    const validLangs = ['javascript', 'typescript', 'python', 'json'];
    if (!validLangs.includes(language)) {
      return { valid: false, error: `Unsupported language: '${language}'. Supported: ${validLangs.join(', ')}` };
    }
  }

  return { valid: true };
}

// --- AST Search (ast-grep backend) ---

function parseAstGrepOutput(jsonStr) {
  let items;
  try {
    items = JSON.parse(jsonStr);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(items)) return [];

  return items.map((item) => ({
    file: item.file || item.path || '',
    startLine: item.range ? item.range.start.line + 1 : (item.start ? item.start.line + 1 : 0),
    endLine: item.range ? item.range.end.line + 1 : (item.end ? item.end.line + 1 : 0),
    snippet: item.text || item.lines || '',
    matchedPattern: item.rule || item.metaVariables ? JSON.stringify(item.metaVariables) : '',
  }));
}

function astGrepSearch(pattern, cwd, language) {
  const args = ['run', '--pattern', pattern, '--json'];
  if (language) {
    args.push('--lang', language);
  }
  try {
    const output = execFileSync('sg', args, {
      encoding: 'utf8',
      cwd,
      timeout: 10000,
    });
    return parseAstGrepOutput(output);
  } catch (err) {
    // ast-grep returns non-zero when no matches found
    if (err.stdout) {
      return parseAstGrepOutput(err.stdout);
    }
    return [];
  }
}

// --- Ripgrep fallback ---

function ripgrepSearch(pattern, cwd, language) {
  const args = ['--json', '--line-number'];

  // Add file type filter based on language
  if (language) {
    const globs = getGlobsForLanguage(language);
    for (const g of globs) {
      args.push('--glob', g);
    }
  } else {
    // Search all supported file types
    for (const ext of SUPPORTED_EXTENSIONS) {
      args.push('--glob', `*${ext}`);
    }
  }

  args.push(pattern);

  try {
    const output = execFileSync('rg', args, {
      encoding: 'utf8',
      cwd,
      timeout: 10000,
    });
    return parseRipgrepOutput(output);
  } catch (err) {
    if (err.stdout) {
      return parseRipgrepOutput(err.stdout);
    }
    return [];
  }
}

function parseRipgrepOutput(output) {
  const results = [];
  const lines = output.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'match' && obj.data) {
        const d = obj.data;
        results.push({
          file: d.path ? d.path.text : '',
          startLine: d.line_number || 0,
          endLine: d.line_number || 0,
          snippet: d.lines ? d.lines.text.trimEnd() : '',
          matchedPattern: d.submatches ? d.submatches.map((s) => s.match.text).join('') : '',
        });
      }
    } catch (_) {
      // skip non-JSON lines
    }
  }
  return results;
}

function getGlobsForLanguage(language) {
  switch (language) {
    case 'javascript': return ['*.js', '*.jsx'];
    case 'typescript': return ['*.ts', '*.tsx'];
    case 'python': return ['*.py'];
    case 'json': return ['*.json'];
    default: return [];
  }
}


// --- Built-in Node.js fallback ---

function builtinSearch(pattern, cwd, language) {
  const results = [];
  let regex;
  try {
    regex = new RegExp(pattern, 'g');
  } catch (_) {
    // If pattern is not valid regex, use it as a literal string
    regex = new RegExp(escapeRegex(pattern), 'g');
  }

  const extensions = language ? getExtensionsForLanguage(language) : SUPPORTED_EXTENSIONS;
  const files = listFilesRecursive(cwd, extensions);

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const fileLines = content.split('\n');

      for (let i = 0; i < fileLines.length; i++) {
        regex.lastIndex = 0;
        const match = regex.exec(fileLines[i]);
        if (match) {
          results.push({
            file: path.relative(cwd, filePath),
            startLine: i + 1,
            endLine: i + 1,
            snippet: fileLines[i].trimEnd(),
            matchedPattern: match[0],
          });
        }
      }
    } catch (_) {
      // Skip files that can't be read
    }
  }

  return results;
}

function listFilesRecursive(dir, extensions) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          // entry.parentPath is available in Node 20+, entry.path in Node 18.17+
          const parentDir = entry.parentPath || entry.path || dir;
          results.push(path.join(parentDir, entry.name));
        }
      }
    }
  } catch (_) {
    // Fallback: manual recursion for older Node versions
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
          results.push(...listFilesRecursive(fullPath, extensions));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            results.push(fullPath);
          }
        }
      }
    } catch (_) { /* skip inaccessible dirs */ }
  }
  return results;
}

function getExtensionsForLanguage(language) {
  switch (language) {
    case 'javascript': return ['.js', '.jsx'];
    case 'typescript': return ['.ts', '.tsx'];
    case 'python': return ['.py'];
    case 'json': return ['.json'];
    default: return SUPPORTED_EXTENSIONS;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Main search function ---

function astSearch(searchPattern, cwd) {
  const pattern = typeof searchPattern === 'string' ? searchPattern : searchPattern.pattern;
  const language = typeof searchPattern === 'string' ? null : (searchPattern.language || null);
  const fileGlob = typeof searchPattern === 'string' ? null : (searchPattern.fileGlob || null);

  // Validate
  const validation = validatePattern(pattern, language);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const resolvedCwd = cwd || process.cwd();
  const status = detectBackend();

  switch (status.backend) {
    case 'ast-grep':
      return astGrepSearch(pattern, resolvedCwd, language);
    case 'ripgrep':
      return ripgrepSearch(pattern, resolvedCwd, language);
    case 'builtin':
    default:
      return builtinSearch(pattern, resolvedCwd, language);
  }
}

// --- Supported patterns ---

function getSupportedPatterns() {
  return [
    { construct: 'function_declaration', language: 'javascript', pattern: 'function $NAME($$$PARAMS) { $$$ }', description: 'Match function declarations' },
    { construct: 'arrow_function', language: 'javascript', pattern: 'const $NAME = ($$$PARAMS) => $BODY', description: 'Match arrow function assignments' },
    { construct: 'class_declaration', language: 'javascript', pattern: 'class $NAME { $$$ }', description: 'Match class declarations' },
    { construct: 'import_statement', language: 'javascript', pattern: 'import $NAME from "$SOURCE"', description: 'Match default imports' },
    { construct: 'require_call', language: 'javascript', pattern: 'require("$MODULE")', description: 'Match require calls' },
    { construct: 'async_function', language: 'javascript', pattern: 'async function $NAME($$$PARAMS) { $$$ }', description: 'Match async function declarations' },
    { construct: 'function_def', language: 'python', pattern: 'def $NAME($$$PARAMS): $$$BODY', description: 'Match Python function definitions' },
    { construct: 'class_def', language: 'python', pattern: 'class $NAME: $$$BODY', description: 'Match Python class definitions' },
    { construct: 'interface', language: 'typescript', pattern: 'interface $NAME { $$$ }', description: 'Match TypeScript interface declarations' },
    { construct: 'type_alias', language: 'typescript', pattern: 'type $NAME = $TYPE', description: 'Match TypeScript type aliases' },
  ];
}

// --- Search status ---

function getSearchStatus() {
  return detectBackend();
}

// --- Exports ---

module.exports = {
  detectBackend,
  resetBackendCache,
  validatePattern,
  astSearch,
  parseAstGrepOutput,
  parseRipgrepOutput,
  builtinSearch,
  ripgrepSearch,
  getSupportedPatterns,
  getSearchStatus,
  detectLanguage,
  EXTENSION_MAP,
  SUPPORTED_EXTENSIONS,
};
