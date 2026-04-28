# Implementation Plan: taosmd Memory Integration

## Overview

This plan implements taosmd as a persistent memory layer for QwenCoder Mac Studio. The work is organized into phases: Python backend (memory-bridge.py with all /memory/* endpoints), Node.js client (memory-client.js), agent loop integration (direct-bridge.js), orchestrator integration (orchestrator.js), and archive-before-compact integration (compactor flow). Each phase builds incrementally, with property and unit tests validating correctness at each step.

## Tasks

- [x] 1. Create memory-bridge.py with initialization, status, and secret filtering
  - [x] 1.1 Create `memory-bridge.py` as a FastAPI APIRouter module with `initialize()` and `shutdown()` lifecycle functions
    - Define module-level state variables (`_kg`, `_vm`, `_archive`, `_extractor`, `_extract_model`, `_initialized`)
    - Implement `initialize(data_dir)` that creates `~/.qwencoder/memory/` and subdirectories if missing, initializes taosmd KnowledgeGraph, VectorMemory (embed_mode="onnx"), and Archive
    - Implement `shutdown()` that flushes pending Archive writes and closes all SQLite connections
    - Wrap initialization in try/except so server continues without memory if taosmd is missing
    - Define all Pydantic request/response models (TripleRequest, ArchiveRecordRequest, VectorAddRequest, RetrieveRequest, ExtractRequest, etc.)
    - _Requirements: 1.1, 1.2, 1.3, 14.4, 14.5_

  - [x] 1.2 Implement `GET /memory/status` and `GET /memory/stats` endpoints
    - Return initialization state of each component (KnowledgeGraph, VectorMemory, Archive) and Extraction_Model availability
    - Return storage sizes (SQLite DB sizes in bytes), record counts, and last extraction timestamp
    - _Requirements: 1.4, 14.2_

  - [x] 1.3 Implement the secret filtering pipeline as a preprocessing function
    - Apply taosmd's 17 regex patterns to redact API keys, bearer tokens, passwords, private keys, AWS credentials, connection strings
    - Replace matched values with `[REDACTED]`
    - Log redaction events (pattern type and character count) without logging the redacted value
    - Fail closed if the filtering pipeline itself errors (reject ingest rather than store unfiltered)
    - _Requirements: 15.1, 15.2, 15.3, 15.4_

  - [x] 1.4 Register the memory router in `server.py` via `app.include_router()` and wire SIGTERM handler
    - Import memory-bridge router and include it on the FastAPI app
    - Register SIGTERM signal handler that calls `memory_bridge.shutdown()`
    - _Requirements: 1.1, 1.5_

  - [x] 1.5 Write property test for secret filtering (Property 16)
    - **Property 16: Secret filtering on ingest**
    - Test that text containing API keys, bearer tokens, AWS credentials has secrets replaced with `[REDACTED]` and original values are absent
    - File: `test/memory-bridge.property.test.js`
    - **Validates: Requirements 15.1, 15.2, 15.4**

- [x] 2. Implement Knowledge Graph API endpoints
  - [x] 2.1 Implement `POST /memory/kg/triples` endpoint
    - Accept JSON body with subject, predicate, object, optional valid_from/valid_until
    - Apply secret filtering before storing
    - Call `KnowledgeGraph.add_triple()` with temporal contradiction detection (mark older triple's valid_until when same subject-predicate pair)
    - Return HTTP 503 if KG is unavailable
    - _Requirements: 2.1, 2.3, 2.5_

  - [x] 2.2 Implement `GET /memory/kg/query/{entity}` and `POST /memory/kg/query-temporal` endpoints
    - Query all triples where entity appears as subject or object, including temporal metadata
    - Temporal query accepts entity + point-in-time timestamp, returns only triples valid at that moment
    - _Requirements: 2.2, 2.4_

  - [x] 2.3 Implement `DELETE /memory/kg/clear` endpoint with confirmation guard
    - Require `confirm: true` in request body; reject without it
    - _Requirements: 14.1_

  - [x] 2.4 Write property tests for Knowledge Graph (Properties 1, 2, 3, 17)
    - **Property 1: Triple storage and query round-trip**
    - **Property 2: Temporal contradiction supersession**
    - **Property 3: Temporal query returns only valid triples**
    - **Property 17: KG clear requires confirmation**
    - File: `test/memory-bridge.property.test.js`
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 14.1**

- [x] 3. Implement Archive API endpoints
  - [x] 3.1 Implement `POST /memory/archive/record` endpoint
    - Accept event_type, payload, summary, optional agent_name/session_id/turn_number
    - Apply secret filtering to payload before storing
    - Include UTC timestamp, agent_name, and session_id in record metadata
    - Store in append-only JSONL format in `~/.qwencoder/memory/archive/`
    - _Requirements: 3.1, 3.3, 3.5_

  - [x] 3.2 Implement `GET /memory/archive/search` and `GET /memory/archive/events` endpoints
    - FTS5 full-text search via `Archive.search_fts()` with query and optional limit
    - Recent events endpoint returns last N events ordered by timestamp descending, default limit 50
    - _Requirements: 3.2, 3.4, 3.6_

  - [x] 3.3 Implement `POST /memory/archive/compress` endpoint
    - Trigger gzip compression of archive JSONL files older than 24 hours
    - _Requirements: 14.3_

  - [x] 3.4 Write property tests for Archive (Properties 4, 5, 6)
    - **Property 4: Archive record metadata completeness**
    - **Property 5: Archive FTS search finds stored content**
    - **Property 6: Archive events ordered by timestamp descending**
    - File: `test/memory-bridge.property.test.js`
    - **Validates: Requirements 3.1, 3.2, 3.5, 3.6**

- [x] 4. Implement Vector Memory and Unified Retrieval endpoints
  - [x] 4.1 Implement `POST /memory/vector/add` and `POST /memory/vector/search` endpoints
    - Add: embed text using ONNX MiniLM, apply secret filtering before embedding, store via VectorMemory.add()
    - Search: accept query, top_k (default 10), hybrid flag (default true); combine semantic cosine similarity with keyword overlap boosting when hybrid=true
    - Return HTTP 503 if ONNX model not found
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 15.4_

  - [x] 4.2 Implement `POST /memory/retrieve` unified retrieval endpoint
    - Accept query, optional agent_name, top_k (default 10), mode ("fast" or "thorough", default "fast")
    - Thorough mode: fan out to KG, Vector, Archive in parallel, merge with Reciprocal Rank Fusion, rerank with CrossEncoder
    - Fast mode: use IntentClassifier to route to most relevant layer(s), skip reranker
    - Apply query expansion (entity extraction, temporal resolution) before dispatch
    - Enforce configurable token budget (default 2048 tokens), truncate lower-scored results to fit
    - Return results as JSON array with source, content, score, metadata
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 4.3 Write property tests for Vector Memory and Retrieval (Properties 7, 8, 9)
    - **Property 7: Vector search round-trip with hybrid boosting**
    - **Property 8: Unified retrieval token budget enforcement**
    - **Property 9: Unified retrieval thorough mode spans all sources**
    - File: `test/memory-bridge.property.test.js`
    - **Validates: Requirements 4.1, 4.2, 4.3, 5.2, 5.5, 5.6**

- [x] 5. Checkpoint — Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement dual-model MLX serving and fact extraction endpoints
  - [x] 6.1 Implement `POST /memory/extractor/load` and `POST /memory/extractor/unload` endpoints
    - Load secondary Qwen3-4B model via MLX with separate `_extraction_semaphore` (concurrency=1)
    - Check Metal memory before loading: reject with HTTP 507 if active memory > 85% of system RAM
    - Unload endpoint releases model and frees Metal memory
    - Report extraction model status (name, memory usage) via GET /memory/status
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 6.2 Implement `POST /memory/extract` and `GET /memory/extract/queue` endpoints
    - Accept message, agent_name, session_id
    - Run regex-based extraction first (15ms), then queue LLM extraction via Extraction_Model if available
    - Store extracted facts as triples in KG with valid_from = current timestamp
    - Add turn content to VectorMemory for semantic indexing
    - Fall back to regex-only if Extraction_Model not loaded, log warning
    - Queue endpoint returns extraction queue depth and processing status
    - _Requirements: 6.6, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [x] 6.3 Write property test for extraction pipeline (Property 10)
    - **Property 10: Extraction pipeline stores in KG and vector**
    - File: `test/memory-bridge.property.test.js`
    - **Validates: Requirements 7.4, 7.5**

- [x] 7. Implement session management endpoints
  - [x] 7.1 Implement `POST /memory/session/enrich` and `POST /memory/session/crystallize` endpoints
    - Enrich: run Session Catalog enrichment pipeline (topic extraction, description, category) on completed session
    - Crystallize: generate Crystal_Store digest (narrative summary, outcomes, lessons), feed lessons back into KG
    - Use heuristic-only enrichment when Extraction_Model not loaded
    - _Requirements: 13.3, 13.4, 13.5_

  - [x] 7.2 Write unit tests for session management endpoints
    - Test enrichment with and without Extraction_Model
    - Test crystal generation and KG feedback
    - File: `test/memory-bridge.test.js`
    - _Requirements: 13.3, 13.4, 13.5_

- [x] 8. Create memory-client.js Node.js client module
  - [x] 8.1 Create `memory-client.js` with HTTP helper and all exported async functions
    - Use Node.js built-in `http` module (no external HTTP client)
    - Read base URL from `MLX_SERVER_URL` env var, default `http://localhost:8090`
    - Implement configurable timeouts: 5s for retrieval, 2s for archive writes, 30s for extraction, 3s for status
    - Export: `retrieve(query, options)`, `archiveRecord(eventType, payload, summary)`, `extractTurn(message, agentName, sessionId)`, `kgAddTriple(subject, predicate, object)`, `kgQueryEntity(entity)`, `vectorSearch(query, options)`, `archiveSearch(query, options)`, `getStatus()`
    - All functions catch errors internally and return safe defaults (empty array, null, {ok: false}) — never throw
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 8.2 Write property test for memory client error resilience (Property 11)
    - **Property 11: Memory client error resilience**
    - Test all exported functions return safe defaults when server is unreachable
    - File: `test/memory-client.property.test.js`
    - **Validates: Requirements 11.3**

  - [x] 8.3 Write unit tests for memory-client.js
    - Test HTTP request construction, timeout handling, response parsing
    - Mock `http.request` to simulate server responses and failures
    - File: `test/memory-client.test.js`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [x] 9. Checkpoint — Ensure all client and backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Integrate memory retrieval and extraction into the agent loop (direct-bridge.js)
  - [x] 10.1 Add recall phrase detection and pre-LLM memory retrieval to `_agentLoop()`
    - Detect recall phrases ("remember when", "what did I say about", "last time", "previously") in user message
    - Call `memoryClient.retrieve(userMessage, { mode })` — "thorough" for recall phrases, "fast" otherwise
    - Inject non-empty retrieval results as a `[Memory Context]` system message immediately before the user's message
    - Limit injected context to configurable token budget (default 2048, via `MEMORY_CONTEXT_BUDGET` env var)
    - Include memory context tokens in `estimateMessagesTokens()` for compaction threshold calculations
    - Skip memory augmentation gracefully if Memory_Backend is unavailable (log debug, continue)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [x] 10.2 Write property tests for recall phrase detection and context injection (Properties 12, 13, 14)
    - **Property 12: Recall phrase detection selects thorough mode**
    - **Property 13: Memory context injection format**
    - **Property 14: Token estimation includes memory context**
    - File: `test/memory-client.property.test.js`
    - **Validates: Requirements 8.2, 8.4, 8.6**

  - [x] 10.3 Add post-turn async fact extraction to `_agentLoop()`
    - After assistant response is complete, fire-and-forget `memoryClient.extractTurn(response, agentName, sessionId)`
    - Do not await the response — extraction must not block the agent loop
    - Log and continue if extraction fails
    - _Requirements: 7.1, 7.6_

  - [x] 10.4 Add tool call and decision archiving to `_agentLoop()`
    - After each tool execution, fire-and-forget archive with event_type "tool_call" including tool name, arguments summary (first 200 chars), result status, result size in bytes
    - Truncate tool results > 10000 chars to first 10000 chars with `truncated: true` metadata
    - Archive assistant responses containing reasoning/decisions with event_type "decision"
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

  - [x] 10.5 Write property tests for tool call archiving (Properties 18, 19)
    - **Property 18: Tool call archive truncation**
    - **Property 19: Tool call archive metadata completeness**
    - File: `test/memory-client.property.test.js`
    - **Validates: Requirements 12.2, 12.5**

  - [x] 10.6 Add session start/end lifecycle events
    - On first user message in a session, record `session_start` event via Memory_Client
    - On session end (user closes chat or starts new conversation), record `session_end` event and trigger `POST /memory/session/enrich`
    - _Requirements: 13.1, 13.2_

- [x] 11. Integrate archive-before-compact into the agent loop
  - [x] 11.1 Add archive-before-compact logic to `_agentLoop()` compaction trigger
    - When token count exceeds compaction threshold, archive all messages that will be compacted via Memory_Client with event_type "pre_compaction" including session_id and turn_number
    - After archiving (or if archiving fails gracefully), proceed with existing compaction flow
    - Emit `qwen-event` with type `memory-archive` containing archived message count and status
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 11.2 Write integration tests for archive-before-compact flow
    - Test that messages are archived before compaction
    - Test graceful fallback when archiving fails
    - Test qwen-event emission
    - File: `test/direct-bridge-memory.test.js`
    - _Requirements: 9.1, 9.4, 9.5_

- [x] 12. Integrate memory into the orchestrator
  - [x] 12.1 Add pre-dispatch memory retrieval and post-completion archiving to `orchestrator.js`
    - In `_dispatchNode()`: query Memory_Client for facts relevant to task title/description, append retrieval context to task's `specContext`
    - After task completion: archive task result (output, duration, agent type) with event_type "task_completion"
    - On `start()`: archive full task graph structure with event_type "workflow_start"
    - Skip memory augmentation gracefully when Memory_Client is unavailable
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 12.2 Write property test for orchestrator specContext augmentation (Property 15)
    - **Property 15: Orchestrator specContext augmentation**
    - File: `test/orchestrator-memory.test.js`
    - **Validates: Requirements 10.2**

  - [x] 12.3 Write integration tests for orchestrator memory integration
    - Test pre-dispatch retrieval appends to specContext
    - Test post-completion archiving
    - Test workflow_start archiving
    - Test graceful degradation when memory unavailable
    - File: `test/orchestrator-memory.test.js`
    - _Requirements: 10.1, 10.3, 10.4, 10.5_

- [x] 13. Add extraction model UI to model picker and single-model fallback
  - [x] 13.1 Add "Extraction Model" section to the model picker panel in `renderer/app.js`
    - Display extraction model status (loaded name + memory usage, or "Not loaded") below the primary model selector
    - Show a dropdown of available models from `~/.lmstudio/models/` (filtered to ≤ 8B where possible, with option to select any)
    - Add "Load" button that calls `POST /memory/extractor/load` via IPC → Memory_Client
    - When loaded, show green indicator, model name, and "Unload" button
    - Show toast notification on load failure (e.g. HTTP 507 insufficient memory)
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [x] 13.2 Add IPC handlers in main process for extraction model load/unload
    - Wire `memory-extractor-load` and `memory-extractor-unload` IPC channels
    - Forward to Memory_Client's HTTP calls to the backend
    - Return status/error to renderer
    - _Requirements: 15.3, 15.5_

  - [x] 13.3 Implement single-model extraction fallback in `memory-bridge.py`
    - When no Extraction_Model is loaded, route extraction to primary model's `/v1/chat/completions` endpoint
    - Use a concise extraction system prompt (under 200 tokens) that outputs entity-relationship triples as JSON
    - Queue extraction requests sequentially to avoid contending with user-facing inference
    - Prefer dedicated Extraction_Model when loaded; fall back to primary model otherwise
    - Track extraction source ("extraction_model" or "primary_model") in queue status
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

  - [x] 13.4 Write unit tests for single-model extraction fallback
    - Test that extraction routes to primary model when no extraction model loaded
    - Test that extraction prefers dedicated model when available
    - Test sequential queuing to avoid inference contention
    - File: `test/memory-bridge.test.js`
    - _Requirements: 16.1, 16.3, 16.4_

- [x] 14. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All Node.js code uses CommonJS (`require`/`module.exports`), all tests use `node:test` + `node:assert/strict` + `fast-check` v4
- Python backend code uses FastAPI + Pydantic, integrated into existing `server.py`
- Fire-and-forget patterns (extraction, archiving) must never block the agent loop
