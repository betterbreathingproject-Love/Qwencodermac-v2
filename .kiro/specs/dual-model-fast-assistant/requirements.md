# Requirements Document

## Introduction

The dual-model fast assistant feature leverages the existing secondary extraction model (a small, fast, vision-capable MLX model such as Qwen2.5-VL-3B or Qwen2.5-VL-4B, already loaded in the `_extract_model` slot of `memory-bridge.py`) to handle lightweight tasks in the gaps between primary model inference. The goal is to make the overall agent experience faster and more responsive without adding memory overhead or changing the primary model's behavior.

Three capabilities are introduced:

1. **Vision & screenshot offload** — image analysis is routed to the small model, producing a text description injected into the primary model's context, saving 10–15 seconds per image on a 30B primary model.
2. **Proactive todo list generation** — the small model generates the initial todo list from the user's prompt in parallel while the primary model warms up, and subsequently infers todo status updates from tool results without requiring an explicit `update_todos` call from the primary model.
3. **Web fetch summarization** — when `web_fetch` returns large HTML/text content, the small model summarizes it before it reaches the primary model, reducing context window usage.

All three capabilities gracefully degrade to current behavior when no extraction model is loaded. The primary model's behavior is unchanged — it still sees the same context, just with pre-processed content substituted in.

## Glossary

- **Assist_Endpoint**: The new `POST /memory/assist` FastAPI endpoint in `memory-bridge.py` that routes lightweight tasks to the extraction model.
- **Extraction_Model**: The secondary MLX model loaded in `_extract_model` / `_extract_processor` within `memory-bridge.py`. A small, fast, vision-capable model (e.g. Qwen2.5-VL-3B or Qwen2.5-VL-4B).
- **Primary_Model**: The main large language model (e.g. Qwen3-30B-A3B) served by `server.py` via the `/v1/chat/completions` endpoint.
- **Assist_Client**: The new `assistClient.js` CommonJS module (or an extension of `memory-client.js`) that wraps the `/memory/assist` HTTP endpoint.
- **Agent_Loop**: The `_agentLoop()` method in `direct-bridge.js` that drives the tool-use conversation with the Primary_Model.
- **Vision_Offload**: The capability that routes image analysis to the Extraction_Model instead of the Primary_Model.
- **Todo_Bootstrap**: The capability that generates the initial todo list from the user's prompt using the Extraction_Model before the Primary_Model's first token.
- **Todo_Watcher**: The sub-capability of Todo_Bootstrap that infers todo status updates from tool results using the Extraction_Model.
- **Fetch_Summarizer**: The capability that summarizes large `web_fetch` results using the Extraction_Model before they are added to the Primary_Model's context.
- **Assist_Task**: A single unit of work dispatched to the Assist_Endpoint. Has a `task_type` field: `"vision"`, `"todo_bootstrap"`, `"todo_watch"`, or `"fetch_summarize"`.
- **Degraded_Mode**: The operating mode when no Extraction_Model is loaded. All three capabilities fall back to current behavior silently.
- **MLX_Serialization**: The constraint that MLX serializes all GPU operations on Apple Silicon. The Extraction_Model and Primary_Model share the Metal GPU and cannot run truly simultaneously; assist tasks run in the gaps between Primary_Model inference turns.

---

## Requirements

### Requirement 1: Assist Endpoint

**User Story:** As a developer running QwenCoder Mac Studio, I want a dedicated backend endpoint for lightweight assist tasks so that the Agent_Loop can offload work to the Extraction_Model without coupling to the existing extraction pipeline.

#### Acceptance Criteria

1. THE Assist_Endpoint SHALL accept `POST /memory/assist` requests with a JSON body containing at minimum a `task_type` field (`"vision"`, `"todo_bootstrap"`, `"todo_watch"`, or `"fetch_summarize"`) and a `payload` field.
2. WHEN the Extraction_Model is not loaded, THE Assist_Endpoint SHALL return HTTP 503 with a JSON body `{"degraded": true, "reason": "no extraction model loaded"}`.
3. WHEN the Extraction_Model is loaded and a valid `task_type` is provided, THE Assist_Endpoint SHALL route the request to the appropriate handler and return a JSON response containing a `result` string field.
4. IF an unsupported `task_type` is provided, THEN THE Assist_Endpoint SHALL return HTTP 400 with a descriptive error message.
5. THE Assist_Endpoint SHALL enforce a per-request timeout of 60 seconds and return HTTP 504 if the Extraction_Model does not complete within that window.
6. THE Assist_Endpoint SHALL use the existing `_extraction_semaphore` (or equivalent serialization mechanism) to prevent concurrent Metal GPU usage between the Extraction_Model and the Primary_Model.

---

### Requirement 2: Assist Client

**User Story:** As a developer integrating the fast assistant into the Agent_Loop, I want a Node.js client module that wraps the Assist_Endpoint so that all three capabilities can call it without duplicating HTTP logic.

#### Acceptance Criteria

1. THE Assist_Client SHALL expose at minimum four async functions: `assistVision(imageData, mimeType, prompt)`, `assistTodoBootstrap(userPrompt)`, `assistTodoWatch(toolName, toolResult, currentTodos)`, and `assistFetchSummarize(url, rawContent, maxOutputTokens)`.
2. WHEN the Assist_Endpoint returns HTTP 503 with `degraded: true`, THE Assist_Client SHALL return `null` without throwing an exception.
3. IF the Assist_Endpoint is unreachable or returns any HTTP error, THEN THE Assist_Client SHALL return `null` without throwing an exception.
4. THE Assist_Client SHALL apply a client-side timeout of 65 seconds (5 seconds longer than the server timeout) to all requests.
5. THE Assist_Client SHALL be a CommonJS module using `require`/`module.exports` and the Node.js built-in `http` module.
6. THE Assist_Client SHALL log a single warning line when a request fails, including the task type and the failure reason, without logging the full payload.

---

### Requirement 3: Vision & Screenshot Offload

**User Story:** As a user of QwenCoder Mac Studio, I want image analysis to be handled by the fast small model so that I don't wait 10–15 extra seconds for the primary model to process screenshots or attached images.

#### Acceptance Criteria

1. WHEN the Agent_Loop detects one or more image attachments in the user's message (base64-encoded image content in the messages array), THE Agent_Loop SHALL call `assistVision()` for each image before dispatching the messages to the Primary_Model.
2. WHEN the `browser_screenshot` tool returns a result containing a base64-encoded image, THE Agent_Loop SHALL call `assistVision()` on the screenshot result before appending it to the conversation.
3. WHEN `assistVision()` returns a non-null description string, THE Agent_Loop SHALL replace the image content part in the messages array with a text content part containing the description, prefixed with `[Vision: ` and suffixed with `]`.
4. WHEN `assistVision()` returns `null` (Degraded_Mode or error), THE Agent_Loop SHALL leave the original image content unchanged and proceed normally.
5. THE Agent_Loop SHALL pass a concise task-appropriate prompt to `assistVision()` describing what to look for (e.g. `"Describe this screenshot in detail, focusing on UI elements, error messages, and code visible on screen."`).
6. WHILE the Primary_Model is actively streaming tokens, THE Agent_Loop SHALL NOT call `assistVision()` — vision offload calls SHALL only occur in the gaps between inference turns.
7. THE vision description injected into the Primary_Model's context SHALL be plain text and SHALL NOT exceed 500 tokens (approximately 2000 characters).

---

### Requirement 4: Proactive Todo List Generation (Bootstrap)

**User Story:** As a user of QwenCoder Mac Studio, I want the todo list to appear immediately when I send a message so that I can see the agent's plan while the primary model is still warming up.

#### Acceptance Criteria

1. WHEN a new agent session starts and the user sends their first message, THE Agent_Loop SHALL call `assistTodoBootstrap(userPrompt)` before dispatching the first request to the Primary_Model.
2. WHEN `assistTodoBootstrap()` returns a non-null result containing a valid todo array, THE Agent_Loop SHALL emit a `qwen-event` with `type: "tool_result"` and `tool: "update_todos"` containing the bootstrapped todos, so the renderer displays them immediately.
3. THE Extraction_Model SHALL generate todos in the same JSON format used by the `update_todos` tool: an array of objects with `id` (number), `content` (string), and `status` (`"pending"`).
4. WHEN `assistTodoBootstrap()` returns `null` (Degraded_Mode or error), THE Agent_Loop SHALL proceed normally without emitting any todo event.
5. THE bootstrapped todo list SHALL be treated as a suggestion only — the Primary_Model MAY call `update_todos` at any time to replace or refine the list, and its call SHALL take precedence.
6. THE `assistTodoBootstrap()` call SHALL be non-blocking with respect to the Primary_Model dispatch — the Agent_Loop SHALL NOT wait for the bootstrap result before sending the first request to the Primary_Model.
7. IF `assistTodoBootstrap()` completes after the Primary_Model has already emitted its own `update_todos` call, THEN THE Agent_Loop SHALL discard the bootstrap result and not emit the todo event.

---

### Requirement 5: Proactive Todo Status Watching

**User Story:** As a user of QwenCoder Mac Studio, I want the todo list to update automatically as the agent completes steps so that I can track progress without the primary model having to call update_todos explicitly.

#### Acceptance Criteria

1. WHEN a tool call completes and the Agent_Loop has an active todo list (bootstrapped or set by the Primary_Model), THE Agent_Loop SHALL call `assistTodoWatch(toolName, toolResult, currentTodos)` in a fire-and-forget manner.
2. WHEN `assistTodoWatch()` returns a non-null result containing a valid todo array with at least one status change compared to `currentTodos`, THE Agent_Loop SHALL emit a `qwen-event` with `type: "tool_result"` and `tool: "update_todos"` containing the updated todos.
3. WHEN `assistTodoWatch()` returns a todo array with no status changes compared to `currentTodos`, THE Agent_Loop SHALL NOT emit any event.
4. WHEN `assistTodoWatch()` returns `null` (Degraded_Mode or error), THE Agent_Loop SHALL continue without updating the todo list.
5. THE `assistTodoWatch()` call SHALL be fire-and-forget — the Agent_Loop SHALL NOT await its result before proceeding to the next tool call or Primary_Model dispatch.
6. WHEN the Primary_Model calls `update_todos` explicitly, THE Agent_Loop SHALL update `currentTodos` with the Primary_Model's version, and subsequent `assistTodoWatch()` calls SHALL use the Primary_Model's version as the baseline.
7. THE Assist_Endpoint's `todo_watch` handler SHALL only return status changes (`"pending"` → `"in_progress"` or `"in_progress"` → `"done"`); it SHALL NOT add new todo items or change todo content.

---

### Requirement 6: Web Fetch Summarization

**User Story:** As a user of QwenCoder Mac Studio, I want large web pages fetched by the agent to be summarized before they reach the primary model so that the context window is used efficiently and the primary model can focus on reasoning.

#### Acceptance Criteria

1. WHEN the `web_fetch` tool returns a result whose character length exceeds 4000 characters, THE Agent_Loop SHALL call `assistFetchSummarize(url, rawContent, maxOutputTokens)` before appending the tool result to the conversation.
2. WHEN `assistFetchSummarize()` returns a non-null summary string, THE Agent_Loop SHALL replace the raw `web_fetch` tool result content with a formatted string: `[Summarized by fast model — original: {charCount} chars]\n\n{summary}`.
3. WHEN `assistFetchSummarize()` returns `null` (Degraded_Mode or error), THE Agent_Loop SHALL use the original `web_fetch` result unchanged.
4. THE `maxOutputTokens` parameter passed to `assistFetchSummarize()` SHALL be 512 tokens.
5. THE Assist_Endpoint's `fetch_summarize` handler SHALL instruct the Extraction_Model to preserve: the page title, key facts, all URLs and links mentioned, code snippets, error messages, and any structured data (tables, lists).
6. THE summarization threshold of 4000 characters SHALL be configurable via a constant in the Assist_Client module (default: 4000).
7. WHEN the `web_fetch` result is 4000 characters or fewer, THE Agent_Loop SHALL use it unchanged without calling `assistFetchSummarize()`.

---

### Requirement 7: MLX Serialization & Gap Scheduling

**User Story:** As a developer maintaining QwenCoder Mac Studio, I want assist tasks to be scheduled in the gaps between primary model inference so that Metal GPU contention is avoided and the primary model's throughput is not degraded.

#### Acceptance Criteria

1. THE Assist_Endpoint SHALL acquire the `_extraction_semaphore` before invoking the Extraction_Model and release it immediately after the Extraction_Model call completes.
2. WHILE the Primary_Model is holding the inference semaphore (i.e. a `/v1/chat/completions` request is in flight), THE Assist_Endpoint SHALL queue incoming assist requests and process them after the Primary_Model releases the semaphore.
3. THE Assist_Endpoint SHALL NOT introduce a new semaphore that could deadlock with the existing `_inference_semaphore` used by `server.py`.
4. THE Agent_Loop SHALL only dispatch assist tasks at natural gap points: before the first Primary_Model call (bootstrap), after a tool result is received (watch, summarize), or when processing user input before the Primary_Model call (vision, bootstrap).
5. IF an assist task is still pending when the Agent_Loop needs to dispatch to the Primary_Model, THE Agent_Loop SHALL proceed with the Primary_Model dispatch without waiting for the assist task to complete.

---

### Requirement 8: Graceful Degradation

**User Story:** As a user of QwenCoder Mac Studio, I want the agent to work exactly as it does today when no extraction model is loaded so that the feature is purely additive and never breaks existing behavior.

#### Acceptance Criteria

1. WHEN no Extraction_Model is loaded in `_extract_model`, ALL three capabilities (Vision_Offload, Todo_Bootstrap, Todo_Watcher, Fetch_Summarizer) SHALL be skipped silently.
2. THE Agent_Loop SHALL NOT log an error or warning when operating in Degraded_Mode — the absence of the Extraction_Model is a normal operating condition.
3. THE Primary_Model's messages array, tool definitions, system prompt, and response handling SHALL be identical whether or not the Extraction_Model is loaded.
4. IF the Extraction_Model is unloaded mid-session (e.g. via `POST /memory/extractor/unload`), THEN all subsequent assist calls in that session SHALL degrade gracefully without requiring a session restart.
5. THE Assist_Client SHALL check for `degraded: true` in the HTTP 503 response body and treat it as a normal no-op, not as an error condition.

---

### Requirement 9: Renderer Integration

**User Story:** As a user of QwenCoder Mac Studio, I want the bootstrapped todo list and inferred status updates to appear in the UI in the same way as primary-model-driven updates so that the experience is seamless.

#### Acceptance Criteria

1. THE `qwen-event` emitted for bootstrapped todos and watcher-inferred updates SHALL use the same channel and data shape as events emitted when the Primary_Model calls `update_todos`, so the renderer requires no changes.
2. WHEN a vision description replaces an image in the messages array, THE renderer SHALL display the text description in place of the image thumbnail, using the existing tool result rendering path.
3. WHEN a fetch summary replaces a raw `web_fetch` result, THE renderer SHALL display the summary text with the `[Summarized by fast model — original: {charCount} chars]` prefix visible to the user.
4. THE renderer SHALL NOT require any new IPC channels or event types to support this feature.

---

### Requirement 10: Configuration & Observability

**User Story:** As a developer maintaining QwenCoder Mac Studio, I want the fast assistant feature to be observable and configurable so that I can tune thresholds and diagnose issues.

#### Acceptance Criteria

1. THE `GET /memory/status` endpoint SHALL include a `fast_assistant_enabled` boolean field that is `true` when an Extraction_Model is loaded and `false` otherwise.
2. THE Assist_Endpoint SHALL log each completed assist task at DEBUG level, including: `task_type`, elapsed time in milliseconds, and output token count.
3. THE Assist_Endpoint SHALL log each degraded (skipped) assist request at DEBUG level with the reason `"no extraction model"`.
4. THE fetch summarization threshold (default 4000 characters) SHALL be defined as a named constant `FETCH_SUMMARIZE_THRESHOLD` in the Assist_Client module.
5. THE vision description maximum length (default 2000 characters) SHALL be defined as a named constant `VISION_MAX_CHARS` in the Assist_Client module.
6. THE todo bootstrap and todo watch capabilities SHALL each be independently disableable via boolean constants `TODO_BOOTSTRAP_ENABLED` and `TODO_WATCH_ENABLED` in the Assist_Client module, defaulting to `true`.
