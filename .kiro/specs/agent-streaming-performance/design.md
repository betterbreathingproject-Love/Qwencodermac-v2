# Agent Streaming Performance Bugfix Design

## Overview

The agent streaming path (`qwen-run` → `QwenBridge` → `@qwen-code/sdk` → renderer) introduces significant latency overhead compared to the direct `chat-stream` SSE passthrough. Seven distinct performance bottlenecks have been identified: per-run MCP server instantiation, conversation history text serialization, per-token processing overhead, system prompt inflation, orchestrator dispatch overhead, inference lock contention blocking preparation, and unnecessary Vision server creation. The fix targets each bottleneck with minimal, surgical changes while preserving all existing behavior for non-affected code paths.

## Glossary

- **Bug_Condition (C)**: Any agent-mode request (`qwen-run`) that triggers one or more of the seven identified performance bottlenecks — per-run MCP instantiation, history re-serialization, per-token overhead, prompt inflation, dispatch overhead, lock contention, or unnecessary Vision server creation
- **Property (P)**: The agent streaming path should exhibit minimal overhead — lazy MCP initialization, structured history passing, direct token forwarding, context-aware prompts, cached dispatch, concurrent preparation, and conditional Vision server creation
- **Preservation**: All existing behaviors must remain unchanged — direct streaming passthrough, MCP tool functionality when needed, tool message parsing, task graph ordering, inference serialization, conversation context, and auto-edit mode
- **QwenBridge**: The class in `qwen-bridge.js` that wraps the `@qwen-code/sdk` query interface, manages MCP servers, and forwards streaming events to the renderer via an EventSink
- **EventSink**: Interface (`WindowSink`, `CallbackSink`, `WorkerSink`) that abstracts how streaming events are delivered to consumers
- **AgentPool**: The class in `agent-pool.js` that manages concurrency, type selection, and dispatch of tasks to subagents
- **Orchestrator**: The class in `orchestrator.js` that executes task graphs by dispatching nodes to the AgentPool
- **_inference_lock**: The `threading.Lock` in `server.py` that serializes all MLX inference to prevent thread-safety issues

## Bug Details

### Bug Condition

The performance degradation manifests whenever a user sends a prompt via the agent mode (`qwen-run` IPC handler). The `QwenBridge.run()` method performs excessive setup work on every invocation, the `_handleMessage()` method adds per-token processing overhead, and the `AgentPool.dispatch()` method repeats work that could be cached or parallelized.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type AgentRequest { prompt, images, conversationHistory, context }
  OUTPUT: boolean

  // Any agent-mode request triggers at least one bottleneck
  RETURN input.path == 'qwen-run'
         AND (
           mcpServersCreatedPerRun(input)              // Bottleneck 1: per-run MCP instantiation
           OR historySerializedAsText(input)            // Bottleneck 2: text transcript inflation
           OR tokenProcessingHasOverhead(input)         // Bottleneck 3: per-token overhead
           OR systemPromptIncludesUnusedTools(input)    // Bottleneck 4: prompt inflation
           OR dispatchRepeatsTypeSelection(input)       // Bottleneck 5: dispatch overhead
           OR preparationBlockedByInferenceLock(input)  // Bottleneck 6: lock contention
           OR visionServerCreatedWithoutImages(input)   // Bottleneck 7: unnecessary Vision server
         )
END FUNCTION
```

### Examples

- **Bottleneck 1**: User sends "refactor this function" → `run()` creates fresh `createPlaywrightServer()` and `createVisionServer()` instances even though the previous run's servers are still valid. Expected: reuse existing servers. Actual: ~50-200ms wasted on server instantiation per run.
- **Bottleneck 2**: User has 20-turn conversation history → `run()` serializes all 20 turns into a `[User]: ...\n[Assistant]: ...` text transcript prepended to the prompt, inflating token count by thousands. Expected: pass as structured message objects. Actual: prompt token count doubles or triples.
- **Bottleneck 3**: Each token from the SDK passes through `_handleMessage()` which checks `isSDKResultMessage`, `isSDKSystemMessage`, `isSDKPartialAssistantMessage`, and `isSDKAssistantMessage` predicates sequentially. Expected: fast-path for the common `text-delta` case. Actual: 4 predicate checks per token.
- **Bottleneck 4**: User sends a text-only prompt with no images → system prompt still includes full Playwright tool descriptions (~500 tokens) and Vision tool descriptions (~200 tokens). Expected: omit irrelevant tool descriptions. Actual: ~700 extra prompt tokens per request.
- **Bottleneck 5**: Orchestrator dispatches 10 tasks of the same type → `selectType()` performs keyword matching on every dispatch. Expected: cache type selection for repeated task patterns. Actual: redundant string matching on every dispatch.
- **Bottleneck 6**: Two sequential agent requests → second request's prompt building waits for the first request's inference to complete because preparation and inference share the same execution flow. Expected: preparation proceeds concurrently. Actual: full serialization of preparation + inference.
- **Bottleneck 7**: User sends "explain this code" with no images → `run()` still calls `createVisionServer()` and `clearImages()`. Expected: skip Vision server entirely. Actual: unnecessary object instantiation and function call.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Direct streaming (`chat-stream` IPC) must continue to forward raw SSE chunks from the Python server to the renderer with current minimal-latency passthrough behavior
- When the agent actually uses Playwright or Vision tools during a run, fully functional MCP server instances with proper browser isolation and image analysis must be provided
- Tool_use and tool_result messages must continue to be correctly parsed, forwarded, and displayed in the renderer UI
- Task graph execution must continue to respect task ordering, semaphore concurrency limits, and timeout constraints
- The Python server must continue to serialize MLX inference via `_inference_lock` to prevent thread-safety issues
- Conversation history must continue to give the agent full multi-turn context so it can reference prior turns
- Auto-edit permission mode must continue to auto-approve actions without requiring user confirmation

**Scope:**
All inputs that do NOT go through the agent mode (`qwen-run`) should be completely unaffected by this fix. This includes:
- Direct `chat-stream` SSE streaming requests
- Non-streaming `chat` IPC requests
- File system operations (`read-file`, `write-file`, `read-dir`)
- Git operations (`git-status`, `git-log`)
- Task graph parsing (without execution)
- Spec workflow operations

## Hypothesized Root Cause

Based on the bug description and code analysis, the root causes are:

1. **Per-Run MCP Server Instantiation** (`qwen-bridge.js:run()` lines creating `_playwrightServer` and `_visionServer`): The `run()` method unconditionally calls `createPlaywrightServer()` and `createVisionServer()` at the start of every invocation. These factory functions create new SDK MCP server instances with fresh tool registrations. The Playwright server additionally sets up closure-scoped browser state variables. This work is repeated even when the previous run's servers are still valid and no tools have been used.

2. **Conversation History Text Serialization** (`qwen-bridge.js:run()` transcript building): The `run()` method converts `conversationHistory` into a plain-text transcript using `[User]: ...\n[Assistant]: ...` format and prepends it to the prompt string. This means the entire conversation history is re-tokenized as part of the prompt on every request, rather than being passed as structured message objects that the SDK could handle more efficiently (e.g., with KV-cache reuse).

3. **Sequential Predicate Checking in _handleMessage** (`qwen-bridge.js:_handleMessage()`): Every message from the SDK async iterator passes through four sequential predicate checks (`isSDKResultMessage`, `isSDKSystemMessage`, `isSDKPartialAssistantMessage`, `isSDKAssistantMessage`). The most common message type during streaming is `partial_assistant` (text deltas), but it's checked third. There's no early-exit optimization for the hot path.

4. **Unconditional System Prompt Inflation** (`qwen-bridge.js:run()` systemPrompt construction): The system prompt always includes full descriptions of all Playwright tools (10 tools) and Vision tools regardless of whether the user's request involves browsing or images. This adds ~700 tokens to every prompt, increasing LLM processing time.

5. **Repeated Agent Type Selection** (`agent-pool.js:selectType()`): The `selectType()` method performs keyword matching against `CATEGORY_KEYWORDS` on every `dispatch()` call. For orchestrated task graphs where many tasks have similar titles, this repeated string matching is wasteful.

6. **Preparation-Inference Serialization**: While the Python server's `_inference_lock` correctly serializes MLX inference, the Node.js agent layer doesn't separate preparation work (prompt building, context assembly, MCP server setup) from the inference call. This means sequential requests are fully serialized end-to-end rather than allowing preparation to overlap with ongoing inference.

7. **Unconditional Vision Server Creation** (`qwen-bridge.js:run()`): Even when `images` is empty/undefined, `run()` creates a Vision MCP server and calls `clearImages()`. The Vision server creation involves `createSdkMcpServer()` with tool registration, which is unnecessary when no images are attached.

## Correctness Properties

Property 1: Bug Condition - MCP Server Lazy Initialization

_For any_ sequence of `run()` invocations on the same `QwenBridge` instance where no Playwright or Vision tools are actually used, the fixed `run()` method SHALL NOT create new MCP server instances on subsequent calls, reusing existing instances or deferring creation until tools are actually needed.

**Validates: Requirements 2.1, 2.7**

Property 2: Bug Condition - Structured Conversation History

_For any_ `run()` invocation with a non-empty `conversationHistory` array, the fixed `run()` method SHALL pass the history in a structured format (message objects) rather than serializing it into a text transcript prepended to the prompt, such that the prompt string does not contain the `[User]:` / `[Assistant]:` transcript markers.

**Validates: Requirements 2.2**

Property 3: Bug Condition - Context-Aware System Prompt

_For any_ `run()` invocation, the fixed `run()` method SHALL only include tool descriptions in the system prompt for tools relevant to the current request context: Playwright descriptions only when browsing-related keywords are detected, Vision descriptions only when images are attached.

**Validates: Requirements 2.4**

Property 4: Bug Condition - Conditional Vision Server Creation

_For any_ `run()` invocation where `images` is empty, undefined, or null, the fixed `run()` method SHALL NOT create a Vision MCP server instance and SHALL NOT call `clearImages()`.

**Validates: Requirements 2.7**

Property 5: Preservation - Tool Message Forwarding Integrity

_For any_ SDK message of type `tool_use` or `tool_result`, the fixed `_handleMessage()` method SHALL produce exactly the same event data sent to the EventSink as the original method, preserving all fields (`id`, `name`, `input`, `tool_use_id`, `content`, `is_error`).

**Validates: Requirements 3.3**

Property 6: Preservation - Conversation Context Completeness

_For any_ `run()` invocation with conversation history, the fixed method SHALL ensure the agent receives the full multi-turn context (all prior user and assistant messages) so it can reference any previous turn, regardless of the format used to pass the history.

**Validates: Requirements 3.6**

Property 7: Preservation - MCP Tool Functionality When Needed

_For any_ `run()` invocation where the agent actually invokes a Playwright or Vision tool, the fixed code SHALL provide a fully functional MCP server instance with proper browser isolation (Playwright) or image analysis capabilities (Vision), producing the same tool results as the original code.

**Validates: Requirements 3.2**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `qwen-bridge.js`

**Function**: `QwenBridge.run()`

**Specific Changes**:

1. **Lazy MCP Server Initialization**: Move `createPlaywrightServer()` and `createVisionServer()` out of `run()` and into a lazy initialization pattern. Store servers on the instance and only create them when first needed (i.e., when the SDK actually invokes a tool). Use a getter or proxy pattern so the MCP server config can reference a lazily-created server.
   - Replace `this._playwrightServer = createPlaywrightServer()` with a lazy getter
   - Replace `this._visionServer = createVisionServer()` with conditional creation only when images are present

2. **Structured Conversation History**: Replace the text transcript serialization with structured message passing. Instead of building `finalPrompt` with `[User]: ...\n[Assistant]: ...`, pass `conversationHistory` as an array of `{role, content}` objects via the SDK's conversation support (if available) or as separate message entries in the prompt construction.
   - Remove the transcript-building loop
   - Pass history as structured `conversationHistory` option to the SDK query, or prepend as proper message objects

3. **Conditional Vision Server Creation**: Guard Vision MCP server creation behind an `images` check.
   - Only create `_visionServer` and call `registerImages()` when `images && images.length > 0`
   - Skip `clearImages()` when no images are attached
   - Only include `vision` in `mcpServers` config when Vision server exists

4. **Context-Aware System Prompt**: Build the system prompt dynamically based on request context.
   - Only include Playwright tool descriptions when the prompt contains browsing-related keywords or when Playwright tools have been used in the current session
   - Only include Vision tool descriptions when images are attached
   - Keep the base system prompt and permission mode instructions unconditional

5. **Optimized _handleMessage Hot Path**: Reorder predicate checks to prioritize the most common message type during streaming.
   - Check `isSDKPartialAssistantMessage` first (most frequent during streaming)
   - Add early return after `stream_event` type check
   - Consider caching the `msg.type` or using a dispatch map instead of sequential predicate checks

**File**: `agent-pool.js`

**Function**: `AgentPool.selectType()` and `AgentPool.dispatch()`

**Specific Changes**:

6. **Cached Agent Type Selection**: Add a simple LRU or Map cache for `selectType()` results keyed by task title or metadata category.
   - Add `this._typeCache = new Map()` to constructor
   - In `selectType()`, check cache before performing keyword matching
   - Invalidate cache when `registerType()` is called

7. **Preparation-Inference Separation**: In `dispatch()`, separate the preparation phase (type selection, context assembly) from the execution phase so preparation for the next task can begin while the current task's inference is running.
   - Extract preparation logic into a separate `_prepare()` method
   - Allow `_prepare()` to run before `_acquireSlot()` where safe

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the performance bottlenecks on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bottlenecks BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that instrument `QwenBridge.run()` and `AgentPool.dispatch()` to count MCP server instantiations, measure prompt sizes, and track type selection calls. Run these tests on the UNFIXED code to observe the overhead.

**Test Cases**:
1. **MCP Server Reuse Test**: Call `run()` twice on the same QwenBridge instance with no tool usage — assert that `createPlaywrightServer` is called twice (will fail to show reuse on unfixed code)
2. **History Serialization Test**: Call `run()` with 10-turn conversation history — assert that the prompt contains `[User]:` transcript markers (will demonstrate inflation on unfixed code)
3. **Vision Server Without Images Test**: Call `run()` with no images — assert that `_visionServer` is created (will demonstrate unnecessary creation on unfixed code)
4. **System Prompt Inflation Test**: Call `run()` with a text-only prompt — assert that system prompt contains Playwright tool descriptions (will demonstrate inflation on unfixed code)

**Expected Counterexamples**:
- MCP servers are created on every `run()` call regardless of need
- Conversation history is serialized as text, inflating prompt token count
- Vision server is created even when no images are attached
- Possible causes: unconditional initialization in `run()`, text-based history format, no conditional logic for tool descriptions

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := QwenBridge_fixed.run(input)
  ASSERT mcpServersLazilyInitialized(result)
  ASSERT historyPassedAsStructured(result)
  ASSERT systemPromptIsContextAware(result)
  ASSERT visionServerSkippedWhenNoImages(result)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT QwenBridge_original.handleMessage(input) = QwenBridge_fixed.handleMessage(input)
  ASSERT AgentPool_original.dispatch(input) = AgentPool_fixed.dispatch(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain (different message types, tool configurations, conversation histories)
- It catches edge cases that manual unit tests might miss (empty histories, single-message histories, histories with special characters)
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for tool message forwarding, conversation context, and MCP functionality, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Tool Message Forwarding Preservation**: Observe that `_handleMessage()` correctly forwards `tool_use` and `tool_result` events on unfixed code, then write PBT to verify the fixed version produces identical output for all message types
2. **Conversation Context Preservation**: Observe that the agent receives full conversation history on unfixed code, then write PBT to verify the fixed version provides equivalent context regardless of history format
3. **MCP Functionality Preservation**: Observe that Playwright and Vision tools work correctly when needed on unfixed code, then write tests to verify they still work after lazy initialization changes
4. **Direct Streaming Preservation**: Observe that `chat-stream` IPC works correctly on unfixed code, then verify it is completely unaffected by the agent-path changes

### Unit Tests

- Test `QwenBridge.run()` with no images: verify Vision server is not created
- Test `QwenBridge.run()` with images: verify Vision server IS created and functional
- Test `QwenBridge.run()` called twice: verify MCP servers are reused
- Test `_handleMessage()` with each message type: verify correct event forwarding
- Test system prompt construction with/without images and browsing keywords
- Test `AgentPool.selectType()` caching: verify cache hit on repeated calls
- Test `AgentPool.dispatch()` preparation separation

### Property-Based Tests

- Generate random SDK messages (text-delta, tool_use, tool_result, system, result) and verify `_handleMessage()` produces identical EventSink output before and after the fix
- Generate random conversation histories (varying lengths, roles, content) and verify the agent receives equivalent context in both implementations
- Generate random request configurations (with/without images, with/without browsing keywords) and verify system prompt only includes relevant tool descriptions
- Generate random task titles and verify `selectType()` returns the same type with and without caching

### Integration Tests

- Test full agent flow: send prompt → receive streaming tokens → verify all events arrive at renderer
- Test agent flow with images: send prompt with images → verify Vision server is created and functional
- Test agent flow with Playwright: send browsing prompt → verify Playwright server is created and functional
- Test sequential agent requests: send two prompts back-to-back → verify both complete correctly
- Test orchestrator task execution: run a task graph → verify all tasks complete with correct ordering
