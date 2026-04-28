# Implementation Plan: Dual-Model Fast Assistant

## Overview

Implement the dual-model fast assistant by adding a `POST /memory/assist` endpoint to `memory-bridge.py`, creating a new `assist-client.js` CommonJS module, and wiring ten integration points into `direct-bridge.js`'s `_agentLoop()`. All capabilities degrade silently when no extraction model is loaded.

## Tasks

- [x] 1. Add `POST /memory/assist` endpoint to `memory-bridge.py`
  - Add `AssistRequest` and `AssistResponse` Pydantic models to `memory-bridge.py`
  - Implement the `_get_extraction_semaphore()` lazy-init helper (or reuse if already present) and the `_assist_with_semaphore(handler_coro)` wrapper
  - Implement the `POST /memory/assist` route: validate `task_type`, return HTTP 400 for unknown types, return HTTP 503 `{"degraded": true, "reason": "no extraction model loaded"}` when `_extract_model is None`, wrap handler dispatch in `asyncio.wait_for(..
  ., timeout=60.0)` returning HTTP 504 on timeout
  - Apply `_fail_closed_filter` to all text payload fields before passing to any handler
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 1.1 Write unit tests for the assist endpoint routing and error cases
    - Test HTTP 400 for invalid `task_type`, HTTP 503 when model unloaded, HTTP 504 on timeout
    - Mock `_extract_model` and `asyncio.wait_for` as needed
    - _Requirements: 1.2, 1.3, 1.4, 1.5_

- [x] 2. Implement the ten assist task handlers in `memory-bridge.py`
  - [x] 2.1 Implement `_handle_vision`: accept `image_b64`, `mime_type`, `prompt`; call `mlx_lm.generate` (or equivalent VLM path) with the image; return `result` text capped at `VISION_MAX_CHARS` equivalent
    - _Requirements: 3.1, 3.5, 3.7_

  - [x] 2.2 Implement `_handle_todo_bootstrap`: accept `user_prompt`; prompt the extraction model to produce a JSON array of `{id, content, status}` todo items; parse and return as `result_data`
    - _Requirements: 4.3_

  - [x] 2.3 Implement `_handle_todo_watch`: accept `tool_name`, `tool_result`, `current_todos`; prompt the extraction model to infer status changes only (`pending→in_progress` or `in_progress→done`); return updated array or `null` if no changes; never add items or change content
    - _Requirements: 5.7_

  - [x] 2.4 Implement `_handle_fetch_summarize`: accept `url`, `raw_content`, `max_output_tokens`; instruct the model to preserve title, key facts, URLs, code snippets, error messages, and structured data; return `result` summary
    - _Requirements: 6.5_

  - [x] 2.5 Implement `_handle_tool_validate`: accept `tool_name`, `tool_args`, `recent_context`; check tool-specific preconditions (`edit_file` old_string presence, `bash` syntax, `write_file`/`read_file` path validity); return `result_data` as `{valid, reason?}`
    - _Requirements: 11.2_

  - [x] 2.6 Implement `_handle_error_diagnose`: accept `tool_name`, `tool_args`, `error_message`, `recent_context`; produce a single sentence (≤ 100 tokens) root cause + fix suggestion; return as `result`
    - _Requirements: 12.4_

  - [x] 2.7 Implement `_handle_git_summarize`: accept `command`, `raw_output`; preserve branch name, file counts, file names, short commit hashes, commit messages, merge conflicts, untracked files; return `result`
    - _Requirements: 13.4_

  - [x] 2.8 Implement `_handle_rank_search`: accept `pattern`, `results` (string array), `task_context`; rank by exact match > proximity to recent files > frequency; return `result_data` as ranked string array
    - _Requirements: 14.4_

  - [x] 2.9 Implement `_handle_extract_section`: accept `file_path`, `file_content`, `task_context`; return the contiguous block most relevant to the task context with ±20 lines of surrounding context; return as `result`
    - _Requirements: 15.4_

  - [x] 2.10 Implement `_handle_detect_repetition`: accept `recent_responses` (array of strings); detect semantic similarity, planning loops, and tool retry loops; return `result_data` as `{repeating, reason?}`
    - _Requirements: 16.4_

  - [ ]* 2.11 Write Python unit tests for each handler (`test/test_memory_bridge_assist.py`)
    - Mock `_extract_model` and `mlx_lm.generate`; verify response shape for each handler
    - Verify secret filtering is applied before model invocation
    - Verify `_get_extraction_semaphore()` returns the same instance on repeated calls
    - _Requirements: 1.6, 7.1_

- [x] 3. Extend `GET /memory/status` with `fast_assistant_enabled`
  - Add `fast_assistant_enabled: bool` field to the `MemoryStatus` Pydantic model
  - Set it to `True` when `_extract_model is not None` in the `get_memory_status` handler
  - _Requirements: 10.1_

- [x] 4. Checkpoint — Ensure all Python tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Create `assist-client.js`
  - Create `assist-client.js` as a CommonJS module (`'use strict'`, `require`/`module.exports`)
  - Define all seven exported constants at the top: `FETCH_SUMMARIZE_THRESHOLD = 4000`, `VISION_MAX_CHARS = 2000`, `GIT_SUMMARIZE_THRESHOLD = 2000`, `SEARCH_RANK_THRESHOLD = 15`, `FILE_EXTRACT_THRESHOLD = 8000`, `TODO_BOOTSTRAP_ENABLED = true`, `TODO_WATCH_ENABLED = true`
  - Implement the internal `_assistRequest(taskType, payload, timeoutMs)` helper using Node.js built-in `http`: POST to `http://127.0.0.1:8090/memory/assist`, return `null` on HTTP 503 with `degraded: true` (no warning), log a single warning line on any other error, apply per-function socket timeouts
  - Implement and export all ten async functions: `assistVision`, `assistTodoBootstrap`, `assistTodoWatch`, `assistFetchSummarize`, `assistValidateTool`, `assistDiagnoseError`, `assistGitSummarize`, `assistRankSearchResults`, `assistExtractRelevantSection`, `assistDetectRepetition`
  - `assistValidateTool` uses 10s timeout; `assistDiagnoseError` uses 15s; `assistExtractRelevantSection` uses 20s; all others use `ASSIST_TIMEOUT_MS = 65000`
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 10.4, 10.5, 10.6, 17.2, 17.3_

  - [ ]* 5.1 Write unit tests for `assist-client.js` (`test/assist-client.test.js`)
    - Verify all 10 functions and 7 constants are exported
    - Verify `_assistRequest` returns `null` on HTTP 503 `degraded: true`, ECONNREFUSED, and HTTP 500
    - Verify `assistFetchSummarize` returns `null` without calling the endpoint when content ≤ `FETCH_SUMMARIZE_THRESHOLD`
    - Verify `assistValidateTool` returns `null` without calling the endpoint for tools not in the validated set
    - Verify warning is logged exactly once on non-degraded failure
    - _Requirements: 2.2, 2.3, 2.6, 11.7_

  - [ ]* 5.2 Write property tests for `assist-client.js` (`test/assist-client.property.test.js`)
    - **Property 2: Assist client returns null for any HTTP error** — `fc.integer({ min: 400, max: 599 })` → result is `null`
    - **Property 3: All capabilities degrade to null when no extraction model is loaded** — all 10 functions return `null` on HTTP 503 degraded
    - **Property 5: Fetch summarize threshold is respected in both directions** — `fc.string()` → called iff `length > FETCH_SUMMARIZE_THRESHOLD`
    - **Property 8: Validation is skipped for non-validated tools** — `fc.string().filter(s => !VALIDATED_TOOLS.has(s))` → `assistValidateTool` not called
    - Use `{ numRuns: 150 }` for all properties
    - **Validates: Requirements 2.3, 6.1, 6.7, 8.1, 8.5, 11.7, 17.4**

- [x] 6. Wire `assist-client.js` into `direct-bridge.js` — lazy load and state tracking
  - Add lazy-require block for `assist-client.js` at the top of `direct-bridge.js` (same pattern as `memory-client.js`)
  - Add `_lastTodos`, `_bootstrapDone`, and `lastTextResponses` state variables inside `_agentLoop()` (or equivalent scope)
  - Add `VALIDATED_TOOLS` constant: `new Set(['edit_file', 'write_file', 'bash', 'read_file'])`
  - Add `GIT_CMD_RE` regex constant: `/^git\s+(status|log|diff|show)\b/`
  - Add `hasStatusChanges(updated, current)` helper that returns `true` if any item's `status` differs
  - _Requirements: 8.1, 8.2, 8.3_

- [x] 7. Integration point 1 — Vision offload (before first LLM call and after `browser_screenshot`)
  - In the messages preprocessing block before `_streamCompletion`, iterate content parts; for each `image_url` or `image` part call `assistClient.assistVision(...)` and replace with `{ type: 'text', text: '[Vision: ${desc}]' }` when non-null
  - After `browser_screenshot` tool result is received, apply the same vision replacement before appending to messages
  - Only call when not actively streaming (gap point constraint)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [ ]* 7.1 Write property test for vision replacement (`test/assist-client.property.test.js`)
    - **Property 4: Vision replacement preserves message structure** — for any array of image parts and non-null descriptions, each replacement is a text part starting with `[Vision: ` and ending with `]`, length ≤ `VISION_MAX_CHARS + '[Vision: ]'.length`
    - **Validates: Requirements 3.3, 3.7**

- [x] 8. Integration point 2 — Todo bootstrap (before first LLM call, fire-and-forget)
  - On `turn === 0`, fire `assistClient.assistTodoBootstrap(userPrompt).then(todos => { if (todos && !_bootstrapDone) emit update_todos event })` without awaiting
  - Set `_bootstrapDone = true` whenever the primary model calls `update_todos`; check this flag in the bootstrap `.then()` to discard late results
  - Emit `qwen-event` with `{ type: 'tool_result', tool: 'update_todos', result: { todos } }` using the existing sink
  - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 4.7_

- [x] 9. Integration point 3 — Todo watch (after each tool result, fire-and-forget)
  - After each tool result is received and `_lastTodos` is non-null, fire `assistClient.assistTodoWatch(fnName, content, _lastTodos).then(updated => { if (updated && hasStatusChanges(updated, _lastTodos)) emit update_todos event })` without awaiting
  - Update `_lastTodos` whenever the primary model calls `update_todos`
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 10. Integration points 4, 7, 8, 9 — Awaited tool result post-processors
  - Integration point 4 — Fetch summarize: after `web_fetch` result, if `content.length > FETCH_SUMMARIZE_THRESHOLD`, await `assistFetchSummarize` and replace content with `[Summarized by fast model — original: ${n} chars]\n\n${summary}` when non-null
  - Integration point 7 — Git summarize: after `bash` result matching `GIT_CMD_RE`, if `content.length > GIT_SUMMARIZE_THRESHOLD`, await `assistGitSummarize` and replace with `[Git summary by fast model — original: ${n} chars]\n\n${summary}` when non-null
  - Integration point 8 — Search rank: after `search_files` result, split lines, if count > `SEARCH_RANK_THRESHOLD`, await `assistRankSearchResults` and replace with `[Ranked by fast model — showing 15 of ${total} matches]\n\n${top15}` when non-null
  - Integration point 9 — File extract: after `read_file` result, if `content.length > FILE_EXTRACT_THRESHOLD` and task context is available, await `assistExtractRelevantSection` and replace with `[Relevant section extracted by fast model — file: ${n} chars total]\n\n${section}` when non-null
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 6.7, 13.1, 13.2, 13.3, 14.1, 14.2, 14.3, 15.1, 15.2, 15.3, 15.7_

  - [ ]* 10.1 Write property tests for threshold guards (`test/assist-client.property.test.js`)
    - **Property 10: Git summarize threshold is respected** — bash + git command, `s.length > GIT_SUMMARIZE_THRESHOLD` iff called
    - **Property 11: Search ranking threshold is respected** — `R.length > SEARCH_RANK_THRESHOLD` iff called
    - **Property 12: File extract threshold is respected** — `s.length > FILE_EXTRACT_THRESHOLD` iff called
    - **Validates: Requirements 13.1, 14.1, 15.1**

- [x] 11. Integration point 5 — Tool pre-validation (before tool execution, awaited)
  - Before executing any tool in `VALIDATED_TOOLS`, await `assistClient.assistValidateTool(fnName, fnArgs, recentContext)` with a 10s timeout
  - When result is `{ valid: false, reason }`, push `{ role: 'system', content: 'Tool call rejected: ${reason}' }` to messages and `continue` to re-prompt the primary model without executing the tool
  - When result is `{ valid: true }` or `null`, proceed with tool execution normally
  - Skip validation entirely for tools not in `VALIDATED_TOOLS`
  - _Requirements: 11.1, 11.3, 11.4, 11.5, 11.7_

  - [ ]* 11.1 Write property tests for tool validation (`test/assist-client.property.test.js`)
    - **Property 7: Tool validation rejection prevents tool execution** — for any validated tool + `{valid: false, reason}`, tool is not executed and system message is injected
    - **Property 8: Validation is skipped for non-validated tools** — for any tool name not in `VALIDATED_TOOLS`, `assistValidateTool` is not called
    - **Validates: Requirements 11.3, 11.7**

- [x] 12. Integration point 6 — Error diagnosis (after tool error, awaited)
  - After a tool result where `result.error` is truthy, await `assistClient.assistDiagnoseError(fnName, fnArgs, content, recentContext)` with a 15s timeout
  - When non-null, prepend to content: `[Fast model diagnosis: ${diagnosis}]\n\n${content}`
  - When null or timeout, use original content unchanged
  - _Requirements: 12.1, 12.2, 12.3, 12.5, 12.6_

  - [ ]* 12.1 Write property test for error diagnosis format (`test/assist-client.property.test.js`)
    - **Property 9: Error diagnosis format is always correct** — for any `(diagnosis, originalError)`, result equals `[Fast model diagnosis: ${diagnosis}]\n\n${originalError}`
    - **Validates: Requirements 12.2**

- [x] 13. Integration point 10 — Repetition detection (after each text response, fire-and-forget)
  - After each non-tool-call assistant text response, push `text.slice(0, 500)` to `lastTextResponses`, keep only the last 3
  - When `lastTextResponses.length >= 2`, fire `assistClient.assistDetectRepetition(lastTextResponses).then(result => { if (result?.repeating) inject system message and trigger existing loop-breaking logic })` without awaiting
  - Leave the existing string-matching repetition detection in place as a fallback
  - _Requirements: 16.1, 16.2, 16.3, 16.5, 16.7_

- [x] 14. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Final wiring — verify graceful degradation end-to-end
  - Confirm the lazy-require guard (`assistClient = null` when module missing) means all integration points are no-ops when `assist-client.js` is absent or the endpoint is down
  - Confirm no `console.error` or `console.warn` is emitted in degraded mode (HTTP 503 `degraded: true` path)
  - Confirm the primary model's `messages` array, tool definitions, system prompt, and response handling are byte-for-byte identical in degraded vs. enabled mode for a session with no images, no large files, and no tool errors
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.4_

- [x] 16. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests use `fast-check` v4 with `{ numRuns: 150 }` per the tech stack
- All JS code uses `'use strict'` and CommonJS (`require`/`module.exports`)
- The `_extraction_semaphore` in `memory-bridge.py` is the sole serialization mechanism — no new semaphores are introduced
