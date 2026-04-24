'use strict';

/**
 * Bug Condition Exploration Property Test — Agent Streaming Performance
 *
 * These tests surface counterexamples demonstrating performance bottlenecks
 * in the CURRENT (unfixed) QwenBridge code. They are EXPECTED TO FAIL on
 * unfixed code — failure confirms the bugs exist.
 *
 * Validates: Requirements 1.1, 1.2, 1.4, 1.7
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const path = require('path');

// ── Tracking state for mocks ─────────────────────────────────────────────────

let playwrightCreateCount = 0;
let visionCreateCount = 0;
let clearImagesCalled = false;
let capturedPrompt = null;
let capturedOptions = null;

function resetTracking() {
  playwrightCreateCount = 0;
  visionCreateCount = 0;
  clearImagesCalled = false;
  capturedPrompt = null;
  capturedOptions = null;
}

// ── Mock @qwen-code/sdk ──────────────────────────────────────────────────────
// We need to intercept the SDK's query function and predicate helpers.
// Replace the module in require.cache before QwenBridge loads it.

const sdkModulePath = require.resolve('@qwen-code/sdk');

// Save original SDK module
const originalSdkModule = require.cache[sdkModulePath];

// Create mock SDK exports
const mockSdkExports = {
  query: function mockQuery({ prompt, options }) {
    capturedPrompt = prompt;
    capturedOptions = options;
    // Return an async iterator that yields nothing (empty stream)
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: true, value: undefined };
          }
        };
      },
      getSessionId() { return 'mock-session'; },
      async interrupt() {},
      async close() {},
    };
  },
  isSDKAssistantMessage: () => false,
  isSDKPartialAssistantMessage: () => false,
  isSDKSystemMessage: () => false,
  isSDKResultMessage: () => false,
  tool: () => ({}),
  createSdkMcpServer: (config) => ({ _name: config.name, _closeBrowser: async () => {}, _getBrowser: () => null }),
};

// Install mock SDK into require.cache
require.cache[sdkModulePath] = {
  id: sdkModulePath,
  filename: sdkModulePath,
  loaded: true,
  exports: mockSdkExports,
};

// ── Mock playwright-tool.js ──────────────────────────────────────────────────

const playwrightModulePath = require.resolve('../playwright-tool');
const originalPlaywrightModule = require.cache[playwrightModulePath];

// Remove cached module so we can replace it
delete require.cache[playwrightModulePath];

require.cache[playwrightModulePath] = {
  id: playwrightModulePath,
  filename: playwrightModulePath,
  loaded: true,
  exports: {
    createPlaywrightServer: function mockCreatePlaywrightServer() {
      playwrightCreateCount++;
      return {
        _name: 'playwright',
        _closeBrowser: async () => {},
        _getBrowser: () => null,
      };
    },
  },
};

// ── Mock vision-tool.js ──────────────────────────────────────────────────────

const visionModulePath = require.resolve('../vision-tool');
const originalVisionModule = require.cache[visionModulePath];

delete require.cache[visionModulePath];

require.cache[visionModulePath] = {
  id: visionModulePath,
  filename: visionModulePath,
  loaded: true,
  exports: {
    createVisionServer: function mockCreateVisionServer() {
      visionCreateCount++;
      return { _name: 'vision' };
    },
    registerImages: function mockRegisterImages(images) {
      return images.map((_, i) => `img_${i}`);
    },
    clearImages: function mockClearImages() {
      clearImagesCalled = true;
    },
    getImageCount: () => 0,
    getImageIds: () => [],
  },
};

// ── Now require QwenBridge (it will pick up our mocked modules) ──────────────

// Clear QwenBridge from cache so it re-requires with our mocks
const qwenBridgePath = require.resolve('../qwen-bridge');
delete require.cache[qwenBridgePath];

const { QwenBridge } = require('../qwen-bridge');

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random text-only prompt (no browsing keywords, no image references).
 */
function arbitraryTextPrompt() {
  const words = [
    'refactor', 'explain', 'summarize', 'optimize', 'review',
    'this', 'the', 'code', 'function', 'module', 'class',
    'please', 'help', 'me', 'with', 'a', 'simple', 'task',
  ];
  return fc.array(fc.constantFrom(...words), { minLength: 2, maxLength: 10 })
    .map(arr => arr.join(' '));
}

/**
 * Generate a conversation history of a given length.
 */
function arbitraryConversationHistory(minLen, maxLen) {
  return fc.array(
    fc.record({
      role: fc.constantFrom('user', 'assistant'),
      content: fc.string({ minLength: 1, maxLength: 100 }),
    }),
    { minLength: minLen, maxLength: maxLen }
  );
}

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Bug Condition Exploration — Agent Streaming Performance', () => {

  /**
   * Bottleneck 1 (MCP Server Reuse):
   * Call run() twice on the same QwenBridge instance — assert createPlaywrightServer
   * is NOT called on the second invocation.
   * On unfixed code, it IS called every time → FAIL
   *
   * **Validates: Requirements 1.1**
   */
  it('Bottleneck 1: MCP servers should be reused across run() calls', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          prompt1: arbitraryTextPrompt(),
          prompt2: arbitraryTextPrompt(),
        }),
        async ({ prompt1, prompt2 }) => {
          resetTracking();

          const sink = { send: () => {} };
          const bridge = new QwenBridge(sink);

          // First run
          await bridge.run({ prompt: prompt1 });
          const countAfterFirst = playwrightCreateCount;

          // Second run on the SAME instance
          await bridge.run({ prompt: prompt2 });
          const countAfterSecond = playwrightCreateCount;

          // PROPERTY: createPlaywrightServer should NOT be called again on second run
          // (it should reuse the server from the first run)
          assert.equal(
            countAfterFirst, 1,
            `createPlaywrightServer should be called once on first run, got ${countAfterFirst}`
          );
          assert.equal(
            countAfterSecond, 1,
            `createPlaywrightServer should still be 1 after second run (reused), but got ${countAfterSecond}`
          );
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Bottleneck 2 (History Serialization):
   * Call run() with a 10-turn conversationHistory — assert the prompt passed
   * to query() does NOT contain [User]: / [Assistant]: transcript markers.
   * On unfixed code, it DOES contain them → FAIL
   *
   * **Validates: Requirements 1.2**
   */
  it('Bottleneck 2: conversation history should not be serialized as text transcript', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          prompt: arbitraryTextPrompt(),
          history: arbitraryConversationHistory(10, 10),
        }),
        async ({ prompt, history }) => {
          resetTracking();

          const sink = { send: () => {} };
          const bridge = new QwenBridge(sink);

          await bridge.run({ prompt, conversationHistory: history });

          // PROPERTY: the prompt passed to query() should NOT contain transcript markers
          assert.ok(capturedPrompt, 'query() should have been called with a prompt');
          assert.ok(
            !capturedPrompt.includes('[User]:'),
            `Prompt should not contain "[User]:" transcript marker, but it does. Prompt starts with: "${capturedPrompt.slice(0, 200)}"`
          );
          assert.ok(
            !capturedPrompt.includes('[Assistant]:'),
            `Prompt should not contain "[Assistant]:" transcript marker, but it does.`
          );
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Bottleneck 4 (System Prompt Inflation):
   * Call run() with a text-only prompt (no images, no browsing keywords) — assert
   * the system prompt does NOT contain Playwright tool descriptions or Vision
   * tool descriptions.
   * On unfixed code, it always includes them → FAIL
   *
   * **Validates: Requirements 1.4**
   */
  it('Bottleneck 4: system prompt should not include unused tool descriptions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          prompt: arbitraryTextPrompt(),
        }),
        async ({ prompt }) => {
          resetTracking();

          const sink = { send: () => {} };
          const bridge = new QwenBridge(sink);

          await bridge.run({ prompt, images: [] });

          // PROPERTY: system prompt should NOT contain Playwright or Vision tool descriptions
          assert.ok(capturedOptions, 'query() should have been called with options');
          const systemPrompt = typeof capturedOptions.systemPrompt === 'string'
            ? capturedOptions.systemPrompt
            : (capturedOptions.systemPrompt?.append || '');

          assert.ok(
            !systemPrompt.includes('browser_navigate'),
            `System prompt should not contain "browser_navigate" for text-only prompt, but it does.`
          );
          assert.ok(
            !systemPrompt.includes('vision_analyze'),
            `System prompt should not contain "vision_analyze" for text-only prompt with no images, but it does.`
          );
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Bottleneck 7 (Vision Server Without Images):
   * Call run() with no images — assert createVisionServer is NOT called and
   * clearImages() is NOT called.
   * On unfixed code, both are called → FAIL
   *
   * **Validates: Requirements 1.7**
   */
  it('Bottleneck 7: Vision server should not be created when no images are attached', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          prompt: arbitraryTextPrompt(),
        }),
        async ({ prompt }) => {
          resetTracking();

          const sink = { send: () => {} };
          const bridge = new QwenBridge(sink);

          // Call with no images (undefined)
          await bridge.run({ prompt });

          // PROPERTY: createVisionServer should NOT be called when no images
          assert.equal(
            visionCreateCount, 0,
            `createVisionServer should not be called when no images are attached, but was called ${visionCreateCount} time(s)`
          );

          // PROPERTY: clearImages should NOT be called when no images
          assert.equal(
            clearImagesCalled, false,
            `clearImages() should not be called when no images are attached, but it was called`
          );
        }
      ),
      { numRuns: 20 }
    );
  });
});
