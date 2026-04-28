'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { AgentPool, CATEGORY_KEYWORDS } = require('../agent-pool.js');

// --- Generators ---

/**
 * Generate a random SubagentType config.
 */
function arbitrarySubagentType() {
  return fc.record({
    name: fc.constantFrom('code-search', 'implementation', 'requirements', 'design', 'general'),
    systemPrompt: fc.string({ minLength: 0, maxLength: 50 }),
    allowedTools: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
    timeout: fc.integer({ min: 100, max: 60000 }),
    maxConcurrent: fc.integer({ min: 1, max: 5 }),
  });
}

/**
 * Generate a task with a title containing keywords from a specific category.
 * Only uses keywords that are unique to that category (not shared with others).
 */
function arbitraryTaskWithCategory() {
  const allCategories = Object.keys(CATEGORY_KEYWORDS);

  // Build a set of keywords that appear in more than one category (ambiguous)
  const keywordCounts = {}
  for (const keywords of Object.values(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      keywordCounts[kw] = (keywordCounts[kw] || 0) + 1
    }
  }
  const ambiguous = new Set(Object.keys(keywordCounts).filter(kw => keywordCounts[kw] > 1))

  // Build unique-keyword map per category
  const uniqueKeywords = {}
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    uniqueKeywords[cat] = keywords.filter(kw => !ambiguous.has(kw))
  }

  // Only use categories that have at least one unique keyword
  const usableCategories = allCategories.filter(cat => uniqueKeywords[cat].length > 0)

  return fc.record({
    category: fc.constantFrom(...usableCategories),
    extraWords: fc.array(fc.constantFrom('the', 'a', 'for', 'with', 'new', 'all', 'this', 'module', 'feature', 'test'), { minLength: 0, maxLength: 5 }),
  }).chain(({ category, extraWords }) => {
    const keywords = uniqueKeywords[category];
    return fc.record({
      keyword: fc.constantFrom(...keywords),
      category: fc.constant(category),
      extraWords: fc.constant(extraWords),
    });
  }).map(({ keyword, category, extraWords }) => {
    const titleParts = [...extraWords];
    // Insert keyword at a random-ish position
    const insertPos = Math.floor(titleParts.length / 2);
    titleParts.splice(insertPos, 0, keyword);
    const title = titleParts.join(' ');

    return {
      task: {
        id: `task-${Math.random().toString(36).slice(2, 8)}`,
        title,
        status: 'not_started',
        dependencies: [],
        children: [],
        parent: null,
        markers: { start: false, branch: null, terminal: false, loop: null },
        parallel: false,
        metadata: {},
        depth: 0,
      },
      expectedCategory: category,
    };
  });
}

/**
 * Generate a sequence of task dispatches for concurrency testing.
 */
function arbitraryTaskSequence() {
  return fc.record({
    maxConcurrency: fc.integer({ min: 1, max: 5 }),
    numTasks: fc.integer({ min: 2, max: 15 }),
    taskDelay: fc.integer({ min: 5, max: 30 }),
  });
}

// --- Property Tests ---

describe('Property-based tests for agent-pool.js', () => {
  /**
   * Property 6: Agent type selection correctness
   * **Validates: Requirements 3.2**
   *
   * For any TaskNode dispatched to the AgentPool, the selected SubagentType
   * SHALL match the task's category based on keywords in the title.
   */
  it('Property 6: agent type selection correctness', () => {
    fc.assert(
      fc.property(arbitraryTaskWithCategory(), ({ task, expectedCategory }) => {
        const pool = new AgentPool({ maxConcurrency: 3, defaultTimeout: 5000 });

        // Register all types
        for (const name of Object.keys(CATEGORY_KEYWORDS)) {
          pool.registerType({ name, systemPrompt: '', allowedTools: [], timeout: 5000, maxConcurrent: 3 });
        }
        pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [], timeout: 5000, maxConcurrent: 3 });

        const selected = pool.selectType(task);

        // PROPERTY: selected type must not be null
        assert.ok(selected, `Selected type should not be null for task "${task.title}"`);

        // PROPERTY: selected type should match the expected category
        // The task title contains a keyword from expectedCategory, so that type should be selected
        assert.equal(
          selected.name,
          expectedCategory,
          `Task "${task.title}" should select "${expectedCategory}" but got "${selected.name}"`
        );
      }),
      { numRuns: 150 }
    );
  });

  /**
   * Property 6 additional: explicit metadata category always wins
   */
  it('Property 6: explicit metadata category overrides keyword matching', () => {
    fc.assert(
      fc.property(
        arbitrarySubagentType(),
        fc.constantFrom('code-search', 'implementation', 'requirements', 'design', 'general'),
        (typeConfig, explicitCategory) => {
          const pool = new AgentPool({ maxConcurrency: 3, defaultTimeout: 5000 });

          // Register all types
          for (const name of ['code-search', 'implementation', 'requirements', 'design', 'general']) {
            pool.registerType({ name, systemPrompt: '', allowedTools: [], timeout: 5000, maxConcurrent: 3 });
          }

          const task = {
            id: 'test',
            title: 'Some random title with no keywords',
            metadata: { category: explicitCategory },
          };

          const selected = pool.selectType(task);

          // PROPERTY: explicit category always wins
          assert.equal(
            selected.name,
            explicitCategory,
            `Explicit category "${explicitCategory}" should be selected`
          );
        }
      ),
      { numRuns: 150 }
    );
  });

  /**
   * Property 7: Concurrency limit enforcement
   * **Validates: Requirements 3.7**
   *
   * For any sequence of task dispatches, the number of simultaneously running
   * subagents SHALL never exceed the configured maxConcurrency limit.
   */
  it('Property 7: concurrency limit enforcement', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryTaskSequence(), async ({ maxConcurrency, numTasks, taskDelay }) => {
        const pool = new AgentPool({ maxConcurrency, defaultTimeout: 10000 });
        pool.registerType({ name: 'general', systemPrompt: '', allowedTools: [], timeout: 10000, maxConcurrent: maxConcurrency });

        let currentConcurrent = 0;
        let maxObserved = 0;

        const trackingFactory = () => {
          return async () => {
            currentConcurrent++;
            if (currentConcurrent > maxObserved) {
              maxObserved = currentConcurrent;
            }
            await new Promise((r) => setTimeout(r, taskDelay));
            currentConcurrent--;
            return 'done';
          };
        };

        const tasks = Array.from({ length: numTasks }, (_, i) => ({
          id: String(i + 1),
          title: 'Task',
          status: 'not_started',
          dependencies: [],
          children: [],
          parent: null,
          markers: { start: false, branch: null, terminal: false, loop: null },
          parallel: false,
          metadata: {},
          depth: 0,
        }));

        // Dispatch all tasks concurrently
        const promises = tasks.map((t) => pool.dispatch(t, {}, { agentFactory: trackingFactory }));
        await Promise.all(promises);

        // PROPERTY: max observed concurrency must never exceed maxConcurrency
        assert.ok(
          maxObserved <= maxConcurrency,
          `Max observed concurrency was ${maxObserved}, but limit is ${maxConcurrency}`
        );

        // PROPERTY: all tasks should have completed
        const results = await Promise.all(promises);
        for (const r of results) {
          assert.ok(r.output === 'done', 'All tasks should complete successfully');
        }
      }),
      { numRuns: 100 }
    );
  });
});
