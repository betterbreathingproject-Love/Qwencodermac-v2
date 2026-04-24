# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Agent Streaming Performance Bottlenecks
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bugs exist
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the seven performance bottlenecks exist in the current code
  - **Scoped PBT Approach**: Scope the property to concrete failing cases for each bottleneck:
    - Bottleneck 1 (MCP Server Reuse): Call `run()` twice on the same QwenBridge instance (mock SDK `query`) — assert `createPlaywrightServer` is NOT called on the second invocation. On unfixed code, it IS called every time → FAIL
    - Bottleneck 2 (History Serialization): Call `run()` with a 10-turn `conversationHistory` — assert the prompt passed to `query()` does NOT contain `[User]:` / `[Assistant]:` transcript markers. On unfixed code, it DOES contain them → FAIL
    - Bottleneck 4 (System Prompt Inflation): Call `run()` with a text-only prompt (no images, no browsing keywords) — assert the system prompt does NOT contain Playwright tool descriptions (`browser_navigate`, etc.) or Vision tool descriptions (`vision_analyze`). On unfixed code, it always includes them → FAIL
    - Bottleneck 7 (Vision Server Without Images): Call `run()` with no images — assert `createVisionServer` is NOT called and `clearImages()` is NOT called. On unfixed code, both are called → FAIL
  - Test file: `test/qwen-bridge.property.test.js`
  - Use `fast-check` with `fc.record` to generate random prompts, conversation histories, and image arrays
  - Mock `@qwen-code/sdk` `query` to capture the prompt and options passed, and return an empty async iterator
  - Mock `createPlaywrightServer` and `createVisionServer` to count invocations
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct — it proves the bottlenecks exist)
  - Document counterexamples found (e.g., "createPlaywrightServer called 2 times for 2 runs instead of 1", "prompt contains [User]: markers", "system prompt includes browser_navigate for text-only request")
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.4, 1.7_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Tool Message Forwarding and Conversation Context Integrity
  - **IMPORTANT**: Follow observation-first methodology
  - **Test file**: `test/qwen-bridge.preservation.property.test.js`
  - **Part A — Tool Message Forwarding Preservation**:
    - Observe: `_handleMessage()` with `isSDKPartialAssistantMessage` containing `tool_use` block forwards `{ type: 'tool-use', id, name, input }` to the EventSink on unfixed code
    - Observe: `_handleMessage()` with `isSDKPartialAssistantMessage` containing `tool_result` block forwards `{ type: 'tool-result', tool_use_id, content, is_error }` to the EventSink on unfixed code
    - Observe: `_handleMessage()` with `isSDKResultMessage` forwards `{ type: 'result', subtype, is_error, result }` on unfixed code
    - Observe: `_handleMessage()` with `isSDKSystemMessage` forwards `{ type: 'system', subtype, data }` on unfixed code
    - Observe: `_handleMessage()` with `isSDKPartialAssistantMessage` containing `text` block forwards `{ type: 'text-delta', text }` on unfixed code
    - Write property-based test: for all generated SDK messages (text-delta, tool_use, tool_result, system, result types), `_handleMessage()` produces the correct EventSink output with all expected fields preserved
    - Use `fast-check` `fc.oneof` to generate random SDK message shapes covering all five message types
  - **Part B — Conversation Context Completeness Preservation**:
    - Observe: `run()` with a 5-turn conversation history produces a `finalPrompt` that contains all user and assistant messages on unfixed code
    - Write property-based test: for all generated conversation histories (varying lengths 0-20, varying roles and content), the prompt passed to `query()` contains every message's content, ensuring no conversation context is lost
    - Use `fast-check` `fc.array(fc.record({ role: fc.constantFrom('user', 'assistant'), content: fc.string({ minLength: 1 }) }))` to generate histories
  - Verify tests PASS on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.3, 3.6_

- [x] 3. Fix agent streaming performance bottlenecks

  - [x] 3.1 Implement lazy MCP server initialization in QwenBridge
    - Move `createPlaywrightServer()` out of `run()` into a lazy getter `_getPlaywrightServer()` that creates the server on first access and reuses it on subsequent calls
    - Store `this._playwrightServer` on the instance; only create when first needed
    - Update `close()` to clean up the cached server instance
    - _Bug_Condition: isBugCondition(input) where mcpServersCreatedPerRun(input) is true — every `run()` call creates fresh servers_
    - _Expected_Behavior: Reuse existing MCP server instances across runs; only create when first needed_
    - _Preservation: When agent actually uses Playwright tools, fully functional MCP server with browser isolation must be provided (Req 3.2)_
    - _Requirements: 2.1_

  - [x] 3.2 Implement conditional Vision server creation
    - Guard `createVisionServer()` behind `images && images.length > 0` check in `run()`
    - Skip `clearImages()` when no images are attached
    - Only include `vision` key in `mcpServers` config when Vision server exists
    - When images ARE present, create the Vision server and register images as before
    - _Bug_Condition: isBugCondition(input) where visionServerCreatedWithoutImages(input) is true — Vision server created even with no images_
    - _Expected_Behavior: Skip Vision MCP server creation and clearImages() when images is empty/undefined/null_
    - _Preservation: When images are attached, Vision server must be created and functional (Req 3.2)_
    - _Requirements: 2.7_

  - [x] 3.3 Replace conversation history text serialization with structured format
    - Remove the transcript-building loop that creates `[User]: ...\n[Assistant]: ...` format
    - Pass `conversationHistory` as structured `{role, content}` message objects — either via SDK conversation support or by prepending as proper message entries in the prompt construction
    - Ensure the agent still receives full multi-turn context so it can reference prior turns
    - _Bug_Condition: isBugCondition(input) where historySerializedAsText(input) is true — history serialized as text transcript_
    - _Expected_Behavior: Prompt string does not contain `[User]:` / `[Assistant]:` transcript markers; history passed as structured objects_
    - _Preservation: Agent must receive full conversation context for all prior turns (Req 3.6)_
    - _Requirements: 2.2_

  - [x] 3.4 Implement context-aware system prompt construction
    - Only include Playwright tool descriptions when the prompt contains browsing-related keywords (e.g., "browse", "scrape", "website", "navigate", "click") or when Playwright tools have been used in the current session
    - Only include Vision tool descriptions when `images && images.length > 0`
    - Keep the base system prompt preset and permission mode instructions unconditional
    - _Bug_Condition: isBugCondition(input) where systemPromptIncludesUnusedTools(input) is true — full tool descriptions always included_
    - _Expected_Behavior: System prompt only includes tool descriptions relevant to the current request context_
    - _Preservation: Tool message parsing and forwarding must remain unchanged (Req 3.3); auto-edit mode instructions must remain (Req 3.7)_
    - _Requirements: 2.4_

  - [x] 3.5 Optimize _handleMessage hot path
    - Reorder predicate checks: check `isSDKPartialAssistantMessage` first (most frequent during streaming), then `isSDKAssistantMessage`, then `isSDKResultMessage`, then `isSDKSystemMessage`
    - Add early return after `stream_event` type check (already present)
    - This is a reordering optimization only — no behavioral change to the event data sent to the EventSink
    - _Bug_Condition: isBugCondition(input) where tokenProcessingHasOverhead(input) is true — 4 sequential predicate checks per token_
    - _Expected_Behavior: Most common message type (partial_assistant / text-delta) checked first for faster hot path_
    - _Preservation: All message types must produce identical EventSink output (Req 3.3)_
    - _Requirements: 2.3_

  - [x] 3.6 Add agent type selection caching in AgentPool
    - Add `this._typeCache = new Map()` to `AgentPool` constructor
    - In `selectType()`, check cache keyed by `task.metadata?.category || task.title` before performing keyword matching
    - Return cached result on hit; populate cache on miss
    - Invalidate cache (clear the Map) when `registerType()` is called
    - _Bug_Condition: isBugCondition(input) where dispatchRepeatsTypeSelection(input) is true — keyword matching on every dispatch_
    - _Expected_Behavior: Cache type selection results; avoid redundant keyword matching for repeated task patterns_
    - _Preservation: Task graph execution must respect ordering, concurrency, and timeouts (Req 3.4)_
    - _Requirements: 2.5_

  - [x] 3.7 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Agent Streaming Performance Bottlenecks Fixed
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior for all four scoped bottlenecks
    - When this test passes, it confirms: MCP servers are reused, history is structured, system prompt is context-aware, Vision server is skipped when no images
    - Run bug condition exploration test from step 1: `node --test test/qwen-bridge.property.test.js`
    - **EXPECTED OUTCOME**: Test PASSES (confirms bugs are fixed)
    - _Requirements: 2.1, 2.2, 2.4, 2.7_

  - [x] 3.8 Verify preservation tests still pass
    - **Property 2: Preservation** - Tool Message Forwarding and Conversation Context Integrity
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2: `node --test test/qwen-bridge.preservation.property.test.js`
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm tool message forwarding produces identical EventSink output for all message types
    - Confirm conversation context completeness is maintained regardless of history format change

- [x] 4. Checkpoint - Ensure all tests pass
  - Run full test suite: `node --test 'test/*.test.js'`
  - Ensure all existing tests pass (no regressions in agent-pool, orchestrator, task-graph, qwen-bridge, spec-workflow tests)
  - Ensure both property-based test files pass (bug condition + preservation)
  - Ask the user if questions arise
