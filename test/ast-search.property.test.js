'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const path = require('node:path');
const {
  validatePattern,
  builtinSearch,
} = require('../ast-search.js');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// --- Generators ---

/**
 * Generate valid search patterns that will match something in the fixture files.
 */
function arbitraryValidSearchPattern() {
  return fc.oneof(
    // Keywords that exist in fixture files
    fc.constantFrom(
      'function', 'class', 'const', 'return', 'import', 'require',
      'def', 'self', 'async', 'interface', 'export', 'module',
      'name', 'value', 'add', 'greet', 'Calculator', 'User'
    ),
    // Simple regex patterns
    fc.constantFrom(
      'function\\s+\\w+', 'class\\s+\\w+', 'const\\s+\\w+',
      'def\\s+\\w+', 'return', 'import'
    )
  );
}

/**
 * Generate a language for searching.
 */
function arbitraryLanguage() {
  return fc.constantFrom('javascript', 'typescript', 'python', 'json', null);
}

/**
 * Generate invalid patterns that should fail validation.
 */
function arbitraryInvalidPattern() {
  return fc.oneof(
    // Empty or whitespace-only strings
    fc.constantFrom('', '   ', '\t', '\n'),
    // Non-string types
    fc.constantFrom(null, undefined, 123, true, {}, []),
    // Strings with null bytes
    fc.constant('a').map((s) => s + '\0' + s),
    fc.constant('hello\0world'),
    // Unbalanced brackets
    fc.constantFrom(
      'function foo(', 'class Bar {', 'arr[0',
      'foo)', 'bar}', 'baz]',
      '(()', '{{}', '[[['
    )
  );
}

// --- Property Tests ---

describe('Property-based tests for ast-search.js', () => {
  // 4.5.1 Property 8: Search result completeness
  // **Validates: Requirements 5.3**
  it('Property 8: search result completeness — all fields present', () => {
    fc.assert(
      fc.property(
        arbitraryValidSearchPattern(),
        arbitraryLanguage(),
        (pattern, language) => {
          const results = builtinSearch(pattern, FIXTURES_DIR, language);

          for (const result of results) {
            // file must be a non-empty string
            assert.ok(
              typeof result.file === 'string' && result.file.length > 0,
              `file should be non-empty string, got: ${JSON.stringify(result.file)}`
            );

            // startLine must be a positive integer
            assert.ok(
              Number.isInteger(result.startLine) && result.startLine > 0,
              `startLine should be positive integer, got: ${result.startLine}`
            );

            // endLine must be a positive integer
            assert.ok(
              Number.isInteger(result.endLine) && result.endLine > 0,
              `endLine should be positive integer, got: ${result.endLine}`
            );

            // startLine <= endLine
            assert.ok(
              result.startLine <= result.endLine,
              `startLine (${result.startLine}) should be <= endLine (${result.endLine})`
            );

            // snippet must be a non-empty string
            assert.ok(
              typeof result.snippet === 'string' && result.snippet.length > 0,
              `snippet should be non-empty string, got: ${JSON.stringify(result.snippet)}`
            );

            // matchedPattern must be a string
            assert.ok(
              typeof result.matchedPattern === 'string',
              `matchedPattern should be a string, got: ${typeof result.matchedPattern}`
            );
          }
        }
      ),
      { numRuns: 120 }
    );
  });

  // 4.5.2 Property 9: Invalid pattern error descriptiveness
  // **Validates: Requirements 5.5**
  it('Property 9: invalid pattern error descriptiveness', () => {
    fc.assert(
      fc.property(
        arbitraryInvalidPattern(),
        (pattern) => {
          const result = validatePattern(pattern, 'javascript');

          // Must be invalid
          assert.equal(
            result.valid,
            false,
            `Pattern ${JSON.stringify(pattern)} should be invalid`
          );

          // Must have a non-empty error string
          assert.ok(
            typeof result.error === 'string' && result.error.length > 0,
            `Error should be a non-empty string, got: ${JSON.stringify(result.error)}`
          );
        }
      ),
      { numRuns: 120 }
    );
  });
});
