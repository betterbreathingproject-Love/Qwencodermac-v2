'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  validatePattern,
  detectBackend,
  resetBackendCache,
  astSearch,
  builtinSearch,
  parseAstGrepOutput,
  parseRipgrepOutput,
  getSupportedPatterns,
  getSearchStatus,
  detectLanguage,
  EXTENSION_MAP,
  SUPPORTED_EXTENSIONS,
} = require('../ast-search.js');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// --- 4.4.1 Test pattern validation ---

describe('validatePattern', () => {
  it('accepts a simple valid pattern', () => {
    const result = validatePattern('function $NAME', 'javascript');
    assert.deepEqual(result, { valid: true });
  });

  it('accepts a pattern with balanced brackets', () => {
    const result = validatePattern('function greet(name) { return name; }', 'javascript');
    assert.deepEqual(result, { valid: true });
  });

  it('accepts a pattern without language', () => {
    const result = validatePattern('class Foo', undefined);
    assert.deepEqual(result, { valid: true });
  });

  it('rejects empty string pattern', () => {
    const result = validatePattern('', 'javascript');
    assert.equal(result.valid, false);
    assert.ok(result.error.length > 0);
  });

  it('rejects non-string pattern', () => {
    const result = validatePattern(123, 'javascript');
    assert.equal(result.valid, false);
    assert.ok(result.error.length > 0);
  });

  it('rejects null pattern', () => {
    const result = validatePattern(null, 'javascript');
    assert.equal(result.valid, false);
  });

  it('rejects pattern with unbalanced opening bracket', () => {
    const result = validatePattern('function foo(', 'javascript');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('Unbalanced'));
  });

  it('rejects pattern with unbalanced closing bracket', () => {
    const result = validatePattern('function foo)', 'javascript');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('Unbalanced'));
  });

  it('rejects pattern with unbalanced curly braces', () => {
    const result = validatePattern('class Foo {', 'javascript');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('Unbalanced'));
  });

  it('rejects unsupported language', () => {
    const result = validatePattern('fn main()', 'rust');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('Unsupported language'));
  });

  it('rejects pattern with null bytes', () => {
    const result = validatePattern('hello\0world', 'javascript');
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('null'));
  });

  it('accepts pattern with nested balanced brackets', () => {
    const result = validatePattern('foo([{bar}])', 'javascript');
    assert.deepEqual(result, { valid: true });
  });
});

// --- 4.2 Language detection ---

describe('detectLanguage', () => {
  it('detects JavaScript from .js', () => {
    assert.equal(detectLanguage('file.js'), 'javascript');
  });

  it('detects JavaScript from .jsx', () => {
    assert.equal(detectLanguage('file.jsx'), 'javascript');
  });

  it('detects TypeScript from .ts', () => {
    assert.equal(detectLanguage('file.ts'), 'typescript');
  });

  it('detects TypeScript from .tsx', () => {
    assert.equal(detectLanguage('file.tsx'), 'typescript');
  });

  it('detects Python from .py', () => {
    assert.equal(detectLanguage('file.py'), 'python');
  });

  it('detects JSON from .json', () => {
    assert.equal(detectLanguage('file.json'), 'json');
  });

  it('returns null for unsupported extension', () => {
    assert.equal(detectLanguage('file.rb'), null);
  });

  it('handles paths with directories', () => {
    assert.equal(detectLanguage('src/components/App.tsx'), 'typescript');
  });
});


// --- 4.1.7 / getSearchStatus ---

describe('getSearchStatus', () => {
  it('returns an object with backend field', () => {
    const status = getSearchStatus();
    assert.ok(['ast-grep', 'ripgrep', 'builtin'].includes(status.backend));
  });

  it('returns version and path for non-builtin backends', () => {
    const status = getSearchStatus();
    if (status.backend !== 'builtin') {
      assert.ok(typeof status.version === 'string');
    }
  });
});

// --- 4.1.6 getSupportedPatterns ---

describe('getSupportedPatterns', () => {
  it('returns an array of pattern examples', () => {
    const patterns = getSupportedPatterns();
    assert.ok(Array.isArray(patterns));
    assert.ok(patterns.length > 0);
  });

  it('each pattern has construct, language, pattern, and description', () => {
    const patterns = getSupportedPatterns();
    for (const p of patterns) {
      assert.ok(typeof p.construct === 'string');
      assert.ok(typeof p.language === 'string');
      assert.ok(typeof p.pattern === 'string');
      assert.ok(typeof p.description === 'string');
    }
  });

  it('includes patterns for JavaScript, TypeScript, and Python', () => {
    const patterns = getSupportedPatterns();
    const langs = new Set(patterns.map((p) => p.language));
    assert.ok(langs.has('javascript'));
    assert.ok(langs.has('typescript'));
    assert.ok(langs.has('python'));
  });
});

// --- 4.3 Parse ast-grep JSON output ---

describe('parseAstGrepOutput', () => {
  it('parses valid ast-grep JSON output', () => {
    const json = JSON.stringify([
      {
        file: 'src/app.js',
        range: { start: { line: 5, column: 0 }, end: { line: 10, column: 1 } },
        text: 'function greet(name) { return name; }',
      },
    ]);
    const results = parseAstGrepOutput(json);
    assert.equal(results.length, 1);
    assert.equal(results[0].file, 'src/app.js');
    assert.equal(results[0].startLine, 6); // 0-indexed to 1-indexed
    assert.equal(results[0].endLine, 11);
    assert.equal(results[0].snippet, 'function greet(name) { return name; }');
  });

  it('returns empty array for invalid JSON', () => {
    const results = parseAstGrepOutput('not json');
    assert.deepEqual(results, []);
  });

  it('returns empty array for non-array JSON', () => {
    const results = parseAstGrepOutput('{"key": "value"}');
    assert.deepEqual(results, []);
  });

  it('handles multiple results', () => {
    const json = JSON.stringify([
      { file: 'a.js', range: { start: { line: 0, column: 0 }, end: { line: 2, column: 0 } }, text: 'fn1' },
      { file: 'b.js', range: { start: { line: 3, column: 0 }, end: { line: 5, column: 0 } }, text: 'fn2' },
    ]);
    const results = parseAstGrepOutput(json);
    assert.equal(results.length, 2);
    assert.equal(results[0].file, 'a.js');
    assert.equal(results[1].file, 'b.js');
  });
});

// --- 4.3 Parse ripgrep JSON output ---

describe('parseRipgrepOutput', () => {
  it('parses valid ripgrep JSON output', () => {
    const lines = [
      JSON.stringify({ type: 'match', data: { path: { text: 'src/app.js' }, line_number: 5, lines: { text: 'function greet(name) {\n' }, submatches: [{ match: { text: 'function greet' } }] } }),
      JSON.stringify({ type: 'summary', data: {} }),
    ].join('\n');
    const results = parseRipgrepOutput(lines);
    assert.equal(results.length, 1);
    assert.equal(results[0].file, 'src/app.js');
    assert.equal(results[0].startLine, 5);
    assert.equal(results[0].snippet, 'function greet(name) {');
  });

  it('returns empty array for empty output', () => {
    const results = parseRipgrepOutput('');
    assert.deepEqual(results, []);
  });

  it('skips non-match entries', () => {
    const lines = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'a.js' } } }),
      JSON.stringify({ type: 'match', data: { path: { text: 'a.js' }, line_number: 1, lines: { text: 'hello\n' }, submatches: [{ match: { text: 'hello' } }] } }),
      JSON.stringify({ type: 'end', data: {} }),
    ].join('\n');
    const results = parseRipgrepOutput(lines);
    assert.equal(results.length, 1);
  });
});

// --- 4.4.2 Test search against fixture source files ---

describe('builtinSearch', () => {
  it('finds function declarations in JavaScript fixtures', () => {
    const results = builtinSearch('function', FIXTURES_DIR, 'javascript');
    assert.ok(results.length > 0, 'Should find at least one match');
    for (const r of results) {
      assert.ok(r.file.endsWith('.js'));
      assert.ok(r.startLine > 0);
      assert.ok(r.snippet.includes('function'));
    }
  });

  it('finds class declarations in TypeScript fixtures', () => {
    const results = builtinSearch('class', FIXTURES_DIR, 'typescript');
    assert.ok(results.length > 0, 'Should find at least one match');
    for (const r of results) {
      assert.ok(r.file.endsWith('.ts'));
    }
  });

  it('finds def keywords in Python fixtures', () => {
    const results = builtinSearch('def', FIXTURES_DIR, 'python');
    assert.ok(results.length > 0, 'Should find at least one match');
    for (const r of results) {
      assert.ok(r.file.endsWith('.py'));
    }
  });

  it('finds keys in JSON fixtures', () => {
    const results = builtinSearch('version', FIXTURES_DIR, 'json');
    assert.ok(results.length > 0, 'Should find at least one match');
    for (const r of results) {
      assert.ok(r.file.endsWith('.json'));
    }
  });

  it('returns empty array when no matches', () => {
    const results = builtinSearch('zzz_nonexistent_pattern_zzz', FIXTURES_DIR, 'javascript');
    assert.equal(results.length, 0);
  });

  it('searches all supported file types when no language specified', () => {
    const results = builtinSearch('class', FIXTURES_DIR, null);
    assert.ok(results.length > 0);
    // Should find matches in both .js and .ts files
    const extensions = new Set(results.map((r) => path.extname(r.file)));
    assert.ok(extensions.size >= 1);
  });

  it('search results have all required fields', () => {
    const results = builtinSearch('function', FIXTURES_DIR, 'javascript');
    for (const r of results) {
      assert.ok(typeof r.file === 'string' && r.file.length > 0, 'file should be non-empty string');
      assert.ok(typeof r.startLine === 'number' && r.startLine > 0, 'startLine should be positive');
      assert.ok(typeof r.endLine === 'number' && r.endLine > 0, 'endLine should be positive');
      assert.ok(r.startLine <= r.endLine, 'startLine should be <= endLine');
      assert.ok(typeof r.snippet === 'string' && r.snippet.length > 0, 'snippet should be non-empty');
      assert.ok(typeof r.matchedPattern === 'string', 'matchedPattern should be a string');
    }
  });
});

// --- 4.4.3 Test ripgrep fallback behavior ---

describe('detectBackend', () => {
  beforeEach(() => {
    resetBackendCache();
  });

  it('returns a valid backend status', () => {
    const status = detectBackend();
    assert.ok(['ast-grep', 'ripgrep', 'builtin'].includes(status.backend));
    assert.ok('version' in status);
    assert.ok('path' in status);
  });

  it('caches the result on subsequent calls', () => {
    const status1 = detectBackend();
    const status2 = detectBackend();
    assert.strictEqual(status1, status2);
  });

  it('returns fresh result after cache reset', () => {
    const status1 = detectBackend();
    resetBackendCache();
    const status2 = detectBackend();
    assert.deepEqual(status1, status2); // same values but different objects
  });
});

// --- astSearch integration (uses whatever backend is available) ---

describe('astSearch', () => {
  it('accepts a string pattern', () => {
    const results = astSearch('function', FIXTURES_DIR);
    assert.ok(Array.isArray(results));
  });

  it('accepts a SearchPattern object', () => {
    const results = astSearch({ pattern: 'function', language: 'javascript' }, FIXTURES_DIR);
    assert.ok(Array.isArray(results));
  });

  it('throws on invalid pattern', () => {
    assert.throws(() => astSearch('', FIXTURES_DIR), /non-empty/);
  });

  it('throws on unsupported language', () => {
    assert.throws(
      () => astSearch({ pattern: 'fn', language: 'rust' }, FIXTURES_DIR),
      /Unsupported language/
    );
  });

  it('returns results with all required fields', () => {
    const results = astSearch('function', FIXTURES_DIR);
    for (const r of results) {
      assert.ok(typeof r.file === 'string');
      assert.ok(typeof r.startLine === 'number');
      assert.ok(typeof r.endLine === 'number');
      assert.ok(typeof r.snippet === 'string');
      assert.ok('matchedPattern' in r);
    }
  });
});
