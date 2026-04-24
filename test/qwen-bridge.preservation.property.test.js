'use strict';

/**
 * Preservation Property Tests — Tool Message Forwarding & Conversation Context
 *
 * These tests capture the CURRENT (unfixed) behavior of QwenBridge that must
 * be preserved after the performance fix. They are EXPECTED TO PASS on unfixed code.
 *
 * Part A: Validates that _handleMessage() correctly forwards all SDK message types
 *         to the EventSink with all expected fields preserved.
 *         **Validates: Requirements 3.3**
 *
 * Part B: Validates that run() with conversation history produces a prompt that
 *         contains all user and assistant messages (no context lost).
 *         **Validates: Requirements 3.6**
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const path = require('path');

// ── Tracking state for mocks ─────────────────────────────────────────────────

let capturedPrompt = null;
let capturedOptions = null;

function resetTracking() {
  capturedPrompt = null;
  capturedOptions = null;
}

// ── Mock @qwen-code/sdk ──────────────────────────────────────────────────────

const sdkModulePath = require.resolve('@qwen-code/sdk');

// Track which predicate should return true for the current test message
let mockPredicateState = {
  isPartialAssistant: false,
  isAssistant: false,
  isSystem: false,
  isResult: false,
};

function resetPredicateState() {
  mockPredicateState.isPartialAssistant = false;
  mockPredicateState.isAssistant = false;
  mockPredicateState.isSystem = false;
  mockPredicateState.isResult = false;
}

const mockSdkExports = {
  query: function mockQuery({ prompt, options }) {
    capturedPrompt = prompt;
    capturedOptions = options;
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
  isSDKAssistantMessage: (msg) => mockPredicateState.isAssistant,
  isSDKPartialAssistantMessage: (msg) => mockPredicateState.isPartialAssistant,
  isSDKSystemMessage: (msg) => mockPredicateState.isSystem,
  isSDKResultMessage: (msg) => mockPredicateState.isResult,
  tool: () => ({}),
  createSdkMcpServer: (config) => ({ _name: config.name, _closeBrowser: async () => {}, _getBrowser: () => null }),
};

require.cache[sdkModulePath] = {
  id: sdkModulePath,
  filename: sdkModulePath,
  loaded: true,
  exports: mockSdkExports,
};

// ── Mock playwright-tool.js ──────────────────────────────────────────────────

const playwrightModulePath = require.resolve('../playwright-tool');
delete require.cache[playwrightModulePath];

require.cache[playwrightModulePath] = {
  id: playwrightModulePath,
  filename: playwrightModulePath,
  loaded: true,
  exports: {
    createPlaywrightServer: function mockCreatePlaywrightServer() {
      return { _name: 'playwright', _closeBrowser: async () => {}, _getBrowser: () => null };
    },
  },
};

// ── Mock vision-tool.js ──────────────────────────────────────────────────────

const visionModulePath = require.resolve('../vision-tool');
delete require.cache[visionModulePath];

require.cache[visionModulePath] = {
  id: visionModulePath,
  filename: visionModulePath,
  loaded: true,
  exports: {
    createVisionServer: function mockCreateVisionServer() {
      return { _name: 'vision' };
    },
    registerImages: function mockRegisterImages(images) {
      return images.map((_, i) => `img_${i}`);
    },
    clearImages: function mockClearImages() {},
    getImageCount: () => 0,
    getImageIds: () => [],
  },
};

// ── Now require QwenBridge (picks up mocked modules) ─────────────────────────

const qwenBridgePath = require.resolve('../qwen-bridge');
delete require.cache[qwenBridgePath];

const { QwenBridge } = require('../qwen-bridge');

// ── Generators ───────────────────────────────────────────────────────────────


/**
 * Generate a random text-delta SDK message (isSDKPartialAssistantMessage).
 */
function genTextDeltaMsg() {
  return fc.record({
    text: fc.string({ minLength: 1, maxLength: 200 }),
  }).map(({ text }) => ({
    _type: 'text-delta',
    message: { content: [{ type: 'text', text }] },
    _expectedEvents: [{ type: 'text-delta', text }],
    _predicateSetup: () => {
      resetPredicateState();
      mockPredicateState.isPartialAssistant = true;
    },
  }));
}

/**
 * Generate a random tool_use SDK message (isSDKPartialAssistantMessage).
 */
function genToolUseMsg() {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 30 }),
    name: fc.string({ minLength: 1, maxLength: 50 }),
    input: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.string({ minLength: 0, maxLength: 50 }),
      { minKeys: 0, maxKeys: 3 }
    ),
  }).map(({ id, name, input }) => ({
    _type: 'tool_use',
    message: { content: [{ type: 'tool_use', id, name, input }] },
    _expectedEvents: [{ type: 'tool-use', id, name, input }],
    _predicateSetup: () => {
      resetPredicateState();
      mockPredicateState.isPartialAssistant = true;
    },
  }));
}

/**
 * Generate a random tool_result SDK message (isSDKPartialAssistantMessage).
 */
function genToolResultMsg() {
  return fc.record({
    tool_use_id: fc.string({ minLength: 1, maxLength: 30 }),
    content: fc.string({ minLength: 0, maxLength: 200 }),
    is_error: fc.boolean(),
  }).map(({ tool_use_id, content, is_error }) => ({
    _type: 'tool_result',
    message: { content: [{ type: 'tool_result', tool_use_id, content, is_error }] },
    _expectedEvents: [{ type: 'tool-result', tool_use_id, content, is_error }],
    _predicateSetup: () => {
      resetPredicateState();
      mockPredicateState.isPartialAssistant = true;
    },
  }));
}

/**
 * Generate a random system SDK message (isSDKSystemMessage).
 */
function genSystemMsg() {
  return fc.record({
    subtype: fc.constantFrom('init', 'config', 'status', 'info'),
    data: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.string({ minLength: 0, maxLength: 50 }),
      { minKeys: 0, maxKeys: 3 }
    ),
  }).map(({ subtype, data }) => ({
    _type: 'system',
    subtype,
    data,
    _expectedEvents: [{ type: 'system', subtype, data }],
    _predicateSetup: () => {
      resetPredicateState();
      mockPredicateState.isSystem = true;
    },
  }));
}

/**
 * Generate a random result SDK message (isSDKResultMessage).
 */
function genResultMsg() {
  return fc.record({
    subtype: fc.constantFrom('success', 'error'),
    is_error: fc.boolean(),
    result: fc.string({ minLength: 0, maxLength: 100 }),
    error: fc.string({ minLength: 0, maxLength: 100 }),
  }).map(({ subtype, is_error, result, error }) => ({
    _type: 'result',
    subtype,
    is_error,
    result,
    error,
    _expectedEvents: [{
      type: 'result',
      subtype,
      is_error,
      result: subtype === 'success' ? result : error,
    }],
    _predicateSetup: () => {
      resetPredicateState();
      mockPredicateState.isResult = true;
    },
  }));
}

/**
 * Generate any of the 5 SDK message types.
 */
function genAnySDKMessage() {
  return fc.oneof(
    genTextDeltaMsg(),
    genToolUseMsg(),
    genToolResultMsg(),
    genSystemMsg(),
    genResultMsg()
  );
}

// ── Property Tests ───────────────────────────────────────────────────────────

describe('Preservation — Tool Message Forwarding (Part A)', () => {

  /**
   * Property 5: Tool Message Forwarding Integrity
   *
   * For all generated SDK messages (text-delta, tool_use, tool_result, system, result),
   * _handleMessage() produces the correct EventSink output with all expected fields preserved.
   *
   * **Validates: Requirements 3.3**
   */
  it('_handleMessage() correctly forwards all SDK message types to EventSink', async () => {
    await fc.assert(
      fc.asyncProperty(genAnySDKMessage(), async (sdkMsg) => {
        // Set up the predicate mock for this message type
        sdkMsg._predicateSetup();

        const sentEvents = [];
        const sink = {
          send: (channel, data) => {
            sentEvents.push({ channel, data });
          },
        };

        const bridge = new QwenBridge(sink);

        // Call _handleMessage with the generated SDK message
        bridge._handleMessage(sdkMsg);

        // PROPERTY: the number of events sent must match expected
        assert.equal(
          sentEvents.length,
          sdkMsg._expectedEvents.length,
          `Expected ${sdkMsg._expectedEvents.length} event(s) for ${sdkMsg._type}, got ${sentEvents.length}`
        );

        // PROPERTY: each event must match the expected output exactly
        for (let i = 0; i < sdkMsg._expectedEvents.length; i++) {
          assert.equal(sentEvents[i].channel, 'qwen-event',
            `Event channel should be 'qwen-event'`);
          assert.deepStrictEqual(
            sentEvents[i].data,
            sdkMsg._expectedEvents[i],
            `Event data mismatch for ${sdkMsg._type} message`
          );
        }
      }),
      { numRuns: 200 }
    );
  });
});

describe('Preservation — Conversation Context Completeness (Part B)', () => {

  /**
   * Property 6: Conversation Context Completeness
   *
   * For all generated conversation histories (varying lengths 0-20, varying roles
   * and content), the prompt passed to query() contains every message's content,
   * ensuring no conversation context is lost.
   *
   * **Validates: Requirements 3.6**
   */
  it('run() with conversation history produces prompt containing all messages', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          prompt: fc.string({ minLength: 1, maxLength: 100 }),
          history: fc.array(
            fc.record({
              role: fc.constantFrom('user', 'assistant'),
              content: fc.string({ minLength: 1 }),
            }),
            { minLength: 1, maxLength: 20 }
          ),
        }),
        async ({ prompt, history }) => {
          resetTracking();
          resetPredicateState();

          const sink = { send: () => {} };
          const bridge = new QwenBridge(sink);

          await bridge.run({ prompt, conversationHistory: history });

          // PROPERTY: the prompt passed to query() must exist
          assert.ok(capturedPrompt, 'query() should have been called with a prompt');

          // PROPERTY: the current prompt must appear in the prompt string
          assert.ok(
            capturedPrompt.includes(prompt),
            `Prompt should contain the current user prompt "${prompt.slice(0, 50)}..." but it does not.`
          );

          // PROPERTY: conversation history is embedded in the prompt using XML-style
          // structured tags (not the old [User]: / [Assistant]: transcript format)
          // Every message's content must appear in the prompt string
          for (const msg of history) {
            assert.ok(
              capturedPrompt.includes(msg.content),
              `Prompt should contain history message content "${msg.content.slice(0, 50)}..." but it does not.`
            );
          }

          // PROPERTY: history must NOT use the old transcript markers
          assert.ok(
            !capturedPrompt.includes('[User]:'),
            'Prompt should not contain old "[User]:" transcript markers'
          );
          assert.ok(
            !capturedPrompt.includes('[Assistant]:'),
            'Prompt should not contain old "[Assistant]:" transcript markers'
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});
