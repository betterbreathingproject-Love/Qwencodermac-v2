# Tasks — Compactor v7 Upgrade

## Task 1: Upgrade Python Bridge to FusionEngine v7 API
- [ ] 1.1 Update `get_engine()` to initialize `FusionEngine(rewind=True)` and cache the instance
- [ ] 1.2 Update `cmd_compress_messages()` to forward per-message `contentType` hints and `dedup` option to `FusionEngine.compress_messages()`
- [ ] 1.3 Update `cmd_compress_messages()` to include per-message stats (`original_tokens`, `compressed_tokens`, `reduction_pct`, `stages_applied`) in JSON output
- [ ] 1.4 Update `cmd_compress_text()` to return `rewind_key` and `stages_applied` in stats when RewindStore is enabled
- [ ] 1.5 Add `cmd_rewind()` function that calls `FusionEngine.rewind(key)` and returns original content or error
- [ ] 1.6 Add `rewind` command to the `__main__` dispatch block
- [ ] 1.7 Update `cmd_status()` to include `rewind_enabled` in output
- [ ] 1.8 Wrap all FusionEngine calls in try/except to return original content + error field on failure

## Task 2: Update Node.js Compactor Module for v7 Features
- [ ] 2.1 Update `compressMessages()` to forward `contentType` per message and `dedup` option in the stdin JSON payload
- [ ] 2.2 Update `compressText()` to return `rewind_key` from the Python bridge response
- [ ] 2.3 Add `rewind(pythonPath, key)` function that calls the Python bridge `rewind` command
- [ ] 2.4 Update `compressMessages()` and `compressText()` to include `engine: 'python'` in stats on success, `engine: 'builtin'` on fallback
- [ ] 2.5 Update `getStatus()` to include `rewind_enabled` field

## Task 3: Add `detectContentType` Helper to `direct-bridge.js`
- [ ] 3.1 Implement `detectContentType(toolName, content)` function with tool-name mapping (`read_file` → `code`, `search_files`/`grep_search` → `search`, `bash`/`execute_command`/`list_dir` → `log`, browser tools → `prose`)
- [ ] 3.2 Add JSON content override: if content starts with `{` or `[` and parses as JSON, return `'json'`
- [ ] 3.3 Add diff content override: if content contains `---`, `+++`, `@@` markers, return `'diff'`
- [ ] 3.4 Default to `'auto'` when no mapping or override matches

## Task 4: Replace `trimMessages` with Compactor in Agent Loop
- [ ] 4.1 Import compactor module in `direct-bridge.js` and resolve `pythonPath` (reuse existing pattern from the codebase)
- [ ] 4.2 Replace the `trimMessages()` call block in `_agentLoop()` with `compactor.compressMessages()` call, passing `{ dedup: true, keepRecent: 4 }`
- [ ] 4.3 Preserve system message and last 4 messages by passing them as options to the compactor
- [ ] 4.4 Add secondary fallback: if compactor result still exceeds `MAX_INPUT_TOKENS`, call `trimMessages()` 
- [ ] 4.5 Emit `qwen-event` with `type: 'compaction-stats'` after successful compression

## Task 5: Replace Hard Truncation with Compactor for Tool Results
- [ ] 5.1 Replace the `content.slice(0, truncateLimit)` block with a call to `compactor.compressText(pythonPath, content, contentType)`
- [ ] 5.2 Call `detectContentType(fnName, content)` before compression to determine the content-type hint
- [ ] 5.3 Append compression notice to compressed content: `\n\n[compressed: {reduction_pct}% reduction, original {original_tokens} tokens, rewind key: {key}]`
- [ ] 5.4 Fall back to existing `content.slice(0, truncateLimit)` if `compressText()` fails or returns uncompressed
- [ ] 5.5 Emit `qwen-event` with `type: 'compaction-stats'` for tool result compression

## Task 6: Register `rewind_context` Tool and Handle Calls
- [ ] 6.1 Add `rewind_context` tool definition to `TOOL_DEFS` array with `key` parameter
- [ ] 6.2 Add `rewind_context` case to `executeTool()` switch that calls `compactor.rewind(pythonPath, key)`
- [ ] 6.3 Return error message when rewind key is not found or expired

## Task 7: Upgrade Builtin JS Compactor with Type-Aware Strategies
- [ ] 7.1 Update `compressText()` to accept and dispatch on `contentType` parameter before falling back to head/tail truncation
- [ ] 7.2 Implement code compression: remove single-line comments (`//`, `#`), collapse consecutive blank lines, remove trailing whitespace
- [ ] 7.3 Implement JSON compression: detect repeated array elements, replace with summary `{ count, schema, first }`
- [ ] 7.4 Implement log compression: fold consecutive repeated lines into single line with `[×N]` count
- [ ] 7.5 Implement search deduplication: merge results sharing same file path with overlapping line ranges
- [ ] 7.6 Ensure all compression paths return stats in `{ original_tokens, compressed_tokens, reduction_pct }` format

## Task 8: Add Compression Stats Badge to Renderer
- [ ] 8.1 Add module-level `_lastCompactionStats` variable in `renderer/app.js`
- [ ] 8.2 Add `compaction-stats` case to the `onQwenEvent` handler to store stats and trigger stats bar update
- [ ] 8.3 Add compaction stat chip to `updateAgentStatsBar()` showing reduction percentage and engine type icon
- [ ] 8.4 Add tooltip with detailed stats (original tokens, compressed tokens, reduction %, engine, stages) on hover
- [ ] 8.5 Use distinct CSS class for builtin engine badge (amber) vs python engine badge (green)

## Task 9: Property-Based Tests
- [ ] 9.1 Create `test/compactor.property.test.js` with fast-check generators for messages, tool names, content types
- [ ] 9.2 Property 1: Error fallback preserves original content — mock bridge to fail, verify output equals input
- [ ] 9.3 Property 5: Fallback to builtin on Python failure — mock bridge to error, verify `engine: 'builtin'` in result
- [ ] 9.4 Property 7: Content-type detection — generate random tool names and content, verify mapping correctness
- [ ] 9.5 Property 9: Builtin code compression removes comments and collapses blanks
- [ ] 9.6 Property 11: Builtin log compression folds repeated lines
- [ ] 9.7 Property 13: Builtin stats format consistency — verify stats fields for any input

## Task 10: Unit Tests
- [ ] 10.1 Create `test/compactor.test.js` with unit tests for `detectContentType()` examples
- [ ] 10.2 Add unit tests for `rewind_context` tool registration in TOOL_DEFS
- [ ] 10.3 Add unit tests for builtin compactor type-specific strategies (code, json, log, search)
- [ ] 10.4 Add unit tests for compression notice format
- [ ] 10.5 Add unit tests for compactor module fallback behavior with mocked execFile
