# Requirements Document

## Introduction

This specification covers upgrading the claw-compactor integration in QwenCoder Mac Studio from basic FusionEngine usage to the full v7 FusionEngine pipeline. The current integration uses only `engine.compress()` and `engine.compress_messages()` without leveraging content-type hints, reversible compression (RewindStore), per-message stats, cross-message semantic deduplication, or custom stage configuration. Additionally, the `_agentLoop` in `direct-bridge.js` uses a naive `trimMessages()` function and hard character-limit truncation for tool results instead of routing through the compactor. This upgrade aims to reduce prompt sizes, preserve more meaningful context, and prevent OOM-induced HTTP 500 errors during local MLX inference.

## Glossary

- **Compactor**: The Node.js module (`compactor.js`) that bridges to the claw-compactor Python library for LLM context compression
- **FusionEngine**: The 14-stage compression pipeline from claw-compactor v7 that performs content-type-aware, AST-aware, and semantically-aware compression
- **RewindStore**: A claw-compactor v7 feature that stores compressed content reversibly, allowing retrieval of original content on demand
- **Python_Bridge**: The Python script (`compactor-bridge.py`) that imports and invokes FusionEngine from the claw-compactor package
- **Builtin_Compactor**: The pure JavaScript fallback compactor (`compactor-builtin.js`) used when the Python bridge is unavailable
- **Agent_Loop**: The `_agentLoop()` method in `direct-bridge.js` that orchestrates multi-turn tool-use conversations with the LLM
- **Tool_Result**: The string output returned by a tool execution (file contents, search results, bash output, etc.) that is added to the message history
- **Content_Type_Hint**: A label (e.g., `code`, `json`, `log`, `diff`, `search`, `prose`) passed to FusionEngine to select optimal compression stages
- **Compression_Stats**: Per-operation metrics returned by FusionEngine including original tokens, compressed tokens, reduction percentage, and stages applied
- **SimHash_Dedup**: Semantic deduplication via SimHash fingerprinting that identifies and collapses near-duplicate content across messages

## Requirements

### Requirement 1: Full FusionEngine v7 Python Bridge

**User Story:** As a developer, I want the Python bridge to use the full FusionEngine v7 API, so that compression leverages all 14 pipeline stages including content-type hints, RewindStore, per-message stats, and custom stage configuration.

#### Acceptance Criteria

1. WHEN the Python_Bridge receives a compress-messages command, THE Python_Bridge SHALL pass content-type hints from the input payload to `FusionEngine.compress_messages()` for each message
2. WHEN the Python_Bridge receives a compress-text command with a content_type parameter, THE Python_Bridge SHALL pass the content_type to `FusionEngine.compress()` as a content-type hint
3. WHEN the Python_Bridge initializes FusionEngine, THE Python_Bridge SHALL enable RewindStore by passing `rewind=True` to the FusionEngine constructor
4. WHEN compression completes, THE Python_Bridge SHALL include per-message Compression_Stats in the JSON output including original_tokens, compressed_tokens, reduction_pct, and stages_applied for each message
5. WHEN the Python_Bridge receives a rewind command with a rewind key, THE Python_Bridge SHALL call `FusionEngine.rewind()` and return the original uncompressed content
6. WHEN the Python_Bridge receives a compress-messages command with a `dedup` option set to true, THE Python_Bridge SHALL enable cross-message SimHash_Dedup in the FusionEngine call
7. IF FusionEngine raises an exception during compression, THEN THE Python_Bridge SHALL return the original uncompressed content along with an error field in the stats object

### Requirement 2: Compactor Node.js Module v7 API

**User Story:** As a developer, I want the Node.js compactor module to expose the full v7 feature set, so that callers can pass content-type hints, request rewind, and receive detailed compression stats.

#### Acceptance Criteria

1. WHEN `compressMessages()` is called with a messages array where each message includes a `contentType` field, THE Compactor SHALL forward the content-type hints to the Python_Bridge
2. WHEN `compressText()` is called with a contentType parameter, THE Compactor SHALL forward the contentType to the Python_Bridge
3. THE Compactor SHALL expose a `rewind(key)` function that calls the Python_Bridge rewind command and returns the original content
4. WHEN compression succeeds via the Python_Bridge, THE Compactor SHALL return the full Compression_Stats object including per-message breakdowns
5. IF the Python_Bridge fails or times out, THEN THE Compactor SHALL fall back to the Builtin_Compactor and include `engine: 'builtin'` in the returned stats
6. WHEN `compressMessages()` is called with `{ dedup: true }` in options, THE Compactor SHALL pass the dedup flag to the Python_Bridge

### Requirement 3: Replace trimMessages with Compactor-Based Compression

**User Story:** As a user, I want the agent loop to use intelligent compression instead of naive message dropping, so that important context is preserved even when the conversation grows large.

#### Acceptance Criteria

1. WHEN the estimated token count of messages exceeds MAX_INPUT_TOKENS in the Agent_Loop, THE Agent_Loop SHALL call `compressMessages()` on the Compactor instead of calling `trimMessages()`
2. WHEN the Compactor compresses messages in the Agent_Loop, THE Agent_Loop SHALL preserve the system message and the most recent 4 messages without compression
3. WHEN the Compactor returns compressed messages, THE Agent_Loop SHALL emit a `qwen-event` with type `system` and subtype `debug` containing the Compression_Stats (original count, compressed count, reduction percentage)
4. IF the Compactor fails to reduce token count below MAX_INPUT_TOKENS, THEN THE Agent_Loop SHALL apply the existing `trimMessages()` as a secondary fallback
5. WHEN compressing messages in the Agent_Loop, THE Agent_Loop SHALL pass `{ dedup: true }` to enable cross-message semantic deduplication

### Requirement 4: Intelligent Tool Result Compression

**User Story:** As a user, I want tool results to be compressed intelligently based on their content type instead of hard-truncated at a character limit, so that more useful information is preserved in the context.

#### Acceptance Criteria

1. WHEN a Tool_Result exceeds 8000 characters (or 24000 for read_file), THE Agent_Loop SHALL compress the Tool_Result using `compressText()` from the Compactor instead of slicing at the character limit
2. WHEN compressing a Tool_Result, THE Agent_Loop SHALL determine the Content_Type_Hint based on the tool name: `read_file` maps to `code`, `search_files` and `grep_search` map to `search`, `execute_command` maps to `log`, and tools returning JSON-parseable output map to `json`
3. WHEN compressing a Tool_Result, THE Agent_Loop SHALL pass the determined Content_Type_Hint to `compressText()`
4. WHEN the Compactor returns a compressed Tool_Result, THE Agent_Loop SHALL append a compression notice to the content indicating the original size and reduction percentage
5. IF the Compactor fails to compress a Tool_Result, THEN THE Agent_Loop SHALL fall back to the existing hard truncation behavior

### Requirement 5: Content-Type Detection for Tool Results

**User Story:** As a developer, I want tool results to be automatically tagged with content types, so that the compactor can apply the optimal compression strategy for each type.

#### Acceptance Criteria

1. THE Agent_Loop SHALL determine Content_Type_Hint for each Tool_Result before compression using the following mapping:
   - `read_file` → `code`
   - `search_files`, `grep_search` → `search`
   - `execute_command` → `log`
   - `list_directory` → `log`
   - `browser_screenshot` → `prose`
   - `browser_navigate`, `browser_click`, `browser_type` → `prose`
2. WHEN a Tool_Result content is valid JSON (starts with `{` or `[` and parses successfully), THE Agent_Loop SHALL override the Content_Type_Hint to `json` regardless of the tool name
3. WHEN a Tool_Result contains diff markers (`---`, `+++`, `@@`), THE Agent_Loop SHALL override the Content_Type_Hint to `diff`
4. IF no Content_Type_Hint can be determined, THEN THE Agent_Loop SHALL use `auto` as the Content_Type_Hint to let FusionEngine auto-detect

### Requirement 6: RewindStore Integration for Retrievable Compression

**User Story:** As a user, I want compressed sections to be retrievable on demand, so that the LLM can access full original content when it needs more detail from a previously compressed message.

#### Acceptance Criteria

1. WHEN the Compactor compresses a Tool_Result with RewindStore enabled, THE Compactor SHALL store the rewind key in the compression notice appended to the content
2. WHEN the Agent_Loop encounters a tool call to a `rewind_context` tool, THE Agent_Loop SHALL call `Compactor.rewind(key)` and return the original uncompressed content as the tool result
3. THE Agent_Loop SHALL register a `rewind_context` tool definition with a single `key` parameter in the tool list provided to the LLM
4. IF a rewind key is expired or not found, THEN THE Compactor SHALL return an error message indicating the content is no longer available

### Requirement 7: Improved Builtin JavaScript Fallback

**User Story:** As a user running without Python, I want the builtin JS compactor to provide better compression than naive truncation, so that context quality is maintained even without claw-compactor installed.

#### Acceptance Criteria

1. WHEN compressing code content, THE Builtin_Compactor SHALL remove single-line comments, collapse consecutive blank lines to one, and remove trailing whitespace before applying truncation
2. WHEN compressing JSON content, THE Builtin_Compactor SHALL detect repeated array elements and replace them with a statistical summary showing the first element, element count, and key schema
3. WHEN compressing log content, THE Builtin_Compactor SHALL detect and fold repeated log lines into a single line with a repetition count
4. WHEN compressing search result content, THE Builtin_Compactor SHALL deduplicate results that share the same file path and overlapping line ranges
5. THE Builtin_Compactor SHALL accept a contentType parameter and apply the type-specific compression strategy before falling back to head/tail truncation
6. WHEN the Builtin_Compactor compresses content, THE Builtin_Compactor SHALL return Compression_Stats in the same format as the Python-backed Compactor (original_tokens, compressed_tokens, reduction_pct)

### Requirement 8: Compression Stats in UI

**User Story:** As a developer debugging context issues, I want to see compression statistics in the UI, so that I can understand how much compression is being applied and which stages are active.

#### Acceptance Criteria

1. WHEN the Agent_Loop compresses messages or tool results, THE Agent_Loop SHALL emit a `qwen-event` with type `compaction-stats` containing the Compression_Stats object
2. WHEN the renderer receives a `compaction-stats` event, THE renderer SHALL display a compact stats badge showing the reduction percentage and engine type (python or builtin)
3. WHEN the user hovers over the compression stats badge, THE renderer SHALL show a tooltip with detailed stats: original tokens, compressed tokens, reduction percentage, engine type, and stages applied
4. WHILE the Compactor engine is `builtin`, THE renderer SHALL display the stats badge in a distinct color to indicate the fallback engine is active
