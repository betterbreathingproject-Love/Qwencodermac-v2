# Requirements Document

## Introduction

This specification covers integrating taosmd (a local-first AI memory system) as the persistent memory layer for QwenCoder Mac Studio. The integration adds a Temporal Knowledge Graph, Vector Memory with hybrid search, Zero-Loss Archive, and LLM-powered fact extraction to the existing application. The goal is to keep the main agent's context window lean (4–8K tokens) by retrieving relevant facts on demand from persistent memory rather than carrying full conversation history, while ensuring every agent turn, tool call, and decision is archived for zero-loss recall. A secondary Qwen3-4B model runs on Apple Silicon via MLX for fast async fact extraction after each turn, alongside the primary larger model used for inference.

## Glossary

- **Memory_Backend**: The Python module (`memory-bridge.py`) that wraps taosmd's KnowledgeGraph, VectorMemory, Archive, and retrieval APIs, exposing them as FastAPI endpoints on the existing server
- **Knowledge_Graph**: taosmd's Temporal Knowledge Graph backed by SQLite — stores structured entity-relationship triples with temporal validity windows and contradiction detection
- **Vector_Memory**: taosmd's vector store using ONNX MiniLM embeddings (all-MiniLM-L6-v2) for semantic search with hybrid keyword boosting, running in-process on the Python backend
- **Archive**: taosmd's Zero-Loss Archive — an append-only JSONL store with SQLite FTS5 full-text search index, recording every conversation turn, tool call, and agent decision verbatim
- **Session_Catalog**: taosmd's LLM-derived timeline directory that indexes archived sessions with topics, descriptions, and categories
- **Crystal_Store**: taosmd's compressed session digests containing narrative summaries, outcomes, and lessons learned, fed back into the Knowledge_Graph
- **Memory_Extractor**: taosmd's fact extraction pipeline that uses regex patterns (15ms) plus a small LLM (Qwen3-4B) to extract structured facts from conversation turns
- **Extraction_Model**: A Qwen3-4B model loaded via MLX alongside the primary model, dedicated to fast async fact extraction (dual-model serving on Apple Silicon)
- **Cross_Encoder_Reranker**: taosmd's ms-marco-MiniLM ONNX second-stage reranker that re-scores retrieval candidates for higher precision
- **Memory_Client**: The Node.js module (`memory-client.js`) that calls Memory_Backend HTTP endpoints from the Electron main process
- **Agent_Loop**: The `_agentLoop()` method in `direct-bridge.js` that orchestrates multi-turn tool-use conversations with the LLM
- **Orchestrator**: The `orchestrator.js` module that manages task graph execution and dispatches tasks to agents
- **Compactor**: The existing `compactor.js` module that compresses conversation context via claw-compactor
- **Retrieval_Context**: A block of relevant facts, memories, and archived content assembled by the Memory_Backend and injected into the agent's prompt before each LLM call
- **Intent_Classifier**: taosmd's query routing component that determines which memory layer(s) to query based on the user's question

## Requirements

### Requirement 1: taosmd Python Backend Integration

**User Story:** As a developer, I want taosmd's memory components initialized and served through the existing FastAPI backend, so that the Electron app can access persistent memory via HTTP without spawning additional processes.

#### Acceptance Criteria

1. WHEN the FastAPI server starts with a model loaded, THE Memory_Backend SHALL initialize taosmd's KnowledgeGraph, VectorMemory, and Archive using SQLite databases stored in `~/.qwencoder/memory/`
2. WHEN the Memory_Backend initializes VectorMemory, THE Memory_Backend SHALL configure it with `embed_mode="onnx"` using the all-MiniLM-L6-v2 ONNX model bundled in the application's models directory
3. IF taosmd is not installed or initialization fails, THEN THE Memory_Backend SHALL log the error and allow the server to continue operating without memory features, returning HTTP 503 for all memory endpoints
4. THE Memory_Backend SHALL expose a `GET /memory/status` endpoint that returns the initialization state of each memory component (Knowledge_Graph, Vector_Memory, Archive) and the Extraction_Model availability
5. WHEN the server receives a `SIGTERM` signal, THE Memory_Backend SHALL flush any pending Archive writes and close all SQLite connections before shutdown

### Requirement 2: Knowledge Graph API Endpoints

**User Story:** As a developer, I want HTTP endpoints for the Temporal Knowledge Graph, so that agents can store and query structured facts with temporal validity across sessions.

#### Acceptance Criteria

1. THE Memory_Backend SHALL expose a `POST /memory/kg/triples` endpoint that accepts a JSON body with `subject`, `predicate`, `object`, and optional `valid_from`/`valid_until` fields, and calls `KnowledgeGraph.add_triple()`
2. THE Memory_Backend SHALL expose a `GET /memory/kg/query/{entity}` endpoint that returns all triples where the entity appears as subject or object, including temporal validity metadata
3. WHEN a new triple contradicts an existing triple for the same subject-predicate pair, THE Knowledge_Graph SHALL mark the older triple's `valid_until` to the current timestamp and store the new triple with `valid_from` set to the current timestamp
4. THE Memory_Backend SHALL expose a `POST /memory/kg/query-temporal` endpoint that accepts an entity and a point-in-time timestamp, returning only triples valid at that moment
5. IF the Knowledge_Graph database is unavailable, THEN THE Memory_Backend SHALL return HTTP 503 with a descriptive error message

### Requirement 3: Zero-Loss Archive Endpoints

**User Story:** As a developer, I want HTTP endpoints for the Zero-Loss Archive, so that every agent turn, tool call, and decision is recorded verbatim and searchable via full-text search.

#### Acceptance Criteria

1. THE Memory_Backend SHALL expose a `POST /memory/archive/record` endpoint that accepts `event_type` (conversation, tool_call, decision, error), `payload` (the verbatim content), and `summary` (a short description), and calls `Archive.record()`
2. THE Memory_Backend SHALL expose a `GET /memory/archive/search` endpoint that accepts a `query` string and optional `limit` parameter, performing FTS5 full-text search via `Archive.search_fts()`
3. THE Archive SHALL store all records in append-only JSONL format in `~/.qwencoder/memory/archive/`
4. THE Archive SHALL maintain a SQLite FTS5 index at `~/.qwencoder/memory/archive-index.db` for full-text search over archived records
5. WHEN a record is written to the Archive, THE Archive SHALL include a UTC timestamp, the agent name, and the session identifier in the record metadata
6. THE Memory_Backend SHALL expose a `GET /memory/archive/events` endpoint that returns the most recent N archived events, ordered by timestamp descending, with a configurable `limit` parameter defaulting to 50

### Requirement 4: Vector Memory Endpoints

**User Story:** As a developer, I want HTTP endpoints for Vector Memory with hybrid search, so that agents can store and retrieve semantically similar content with keyword boosting.

#### Acceptance Criteria

1. THE Memory_Backend SHALL expose a `POST /memory/vector/add` endpoint that accepts `text` and optional `metadata`, embeds the text using the ONNX MiniLM model, and stores the embedding via `VectorMemory.add()`
2. THE Memory_Backend SHALL expose a `POST /memory/vector/search` endpoint that accepts a `query` string, optional `top_k` (default 10), and optional `hybrid` flag (default true), returning ranked results via `VectorMemory.search()`
3. WHEN the `hybrid` flag is true, THE Vector_Memory SHALL combine semantic cosine similarity with keyword overlap boosting for result ranking
4. WHEN the Vector_Memory embeds text, THE Vector_Memory SHALL use the ONNX Runtime backend targeting the CPU, achieving sub-millisecond embedding latency per query
5. IF the ONNX embedding model is not found at the configured path, THEN THE Memory_Backend SHALL return HTTP 503 for vector search endpoints and log the missing model path

### Requirement 5: Unified Retrieval Endpoint with Intent-Aware Routing

**User Story:** As a developer, I want a single retrieval endpoint that queries all memory layers in parallel and returns a merged, reranked result set, so that agents get the most relevant context without needing to call each layer separately.

#### Acceptance Criteria

1. THE Memory_Backend SHALL expose a `POST /memory/retrieve` endpoint that accepts a `query` string, optional `agent_name`, optional `top_k` (default 10), and optional `mode` ("fast" or "thorough", default "fast")
2. WHEN mode is "thorough", THE Memory_Backend SHALL fan out the query to Knowledge_Graph, Vector_Memory, and Archive in parallel, merge results using Reciprocal Rank Fusion, and rerank using the Cross_Encoder_Reranker
3. WHEN mode is "fast", THE Memory_Backend SHALL use the Intent_Classifier to route the query to the most relevant memory layer(s) and skip the Cross_Encoder_Reranker
4. THE Memory_Backend SHALL apply query expansion (entity extraction and temporal resolution) before dispatching to memory layers
5. THE Memory_Backend SHALL return results as a JSON array where each item includes `source` (kg, vector, archive), `content`, `score`, and `metadata`
6. THE Memory_Backend SHALL enforce a configurable token budget (default 2048 tokens) on the assembled Retrieval_Context, truncating lower-scored results to fit

### Requirement 6: Dual-Model MLX Serving for Fact Extraction

**User Story:** As a developer, I want a secondary Qwen3-4B model loaded alongside the primary model on Apple Silicon, so that fact extraction runs asynchronously without blocking the main inference pipeline.

#### Acceptance Criteria

1. THE Memory_Backend SHALL support loading a secondary Extraction_Model (Qwen3-4B) via MLX using a `POST /memory/extractor/load` endpoint that accepts a `model_path` parameter
2. WHILE the primary model is performing inference, THE Extraction_Model SHALL be able to run fact extraction concurrently using a separate MLX inference path
3. WHEN the Extraction_Model is loaded, THE Memory_Backend SHALL report its status (model name, memory usage) via the `GET /memory/status` endpoint
4. IF loading the Extraction_Model would cause Metal memory usage to exceed 85% of system RAM, THEN THE Memory_Backend SHALL reject the load request with HTTP 507 and a descriptive error indicating insufficient memory
5. THE Memory_Backend SHALL expose a `POST /memory/extractor/unload` endpoint that releases the Extraction_Model and frees its Metal memory allocation
6. IF the Extraction_Model is not loaded, THEN THE Memory_Backend SHALL fall back to regex-only fact extraction (15ms per turn) and log a warning that LLM-based extraction is unavailable

### Requirement 7: Async Fact Extraction After Each Agent Turn

**User Story:** As a developer, I want facts automatically extracted from every conversation turn and stored in the Knowledge Graph, so that structured knowledge accumulates across sessions without blocking the main agent loop.

#### Acceptance Criteria

1. WHEN an agent turn completes (assistant response received), THE Memory_Client SHALL send the turn content to `POST /memory/extract` asynchronously without awaiting the response
2. THE Memory_Backend SHALL expose a `POST /memory/extract` endpoint that accepts `message` (the turn content), `agent_name`, and `session_id`, and runs the Memory_Extractor pipeline
3. WHEN the Memory_Extractor processes a turn, THE Memory_Extractor SHALL first apply regex-based extraction (15ms), then queue LLM-based extraction via the Extraction_Model if available
4. WHEN the Memory_Extractor extracts facts, THE Memory_Extractor SHALL store each fact as a triple in the Knowledge_Graph with `valid_from` set to the current timestamp
5. WHEN the Memory_Extractor processes a turn, THE Memory_Extractor SHALL also add the turn content to Vector_Memory for semantic indexing
6. IF the Memory_Extractor encounters an error during extraction, THEN THE Memory_Extractor SHALL log the error and continue without affecting the agent's operation
7. THE Memory_Backend SHALL expose a `GET /memory/extract/queue` endpoint that returns the current extraction queue depth and processing status

### Requirement 8: Memory-Augmented Agent Loop

**User Story:** As a user, I want the agent to automatically retrieve relevant memories before each response, so that the agent has access to prior context without carrying full conversation history in the context window.

#### Acceptance Criteria

1. WHEN the Agent_Loop prepares messages for an LLM call, THE Agent_Loop SHALL call the Memory_Client to retrieve relevant context via the unified retrieval endpoint using the current user message as the query
2. WHEN Retrieval_Context is returned, THE Agent_Loop SHALL inject it as a system message immediately before the user's message, prefixed with `[Memory Context]`
3. WHILE the Memory_Backend is unavailable, THE Agent_Loop SHALL proceed without memory augmentation and log a debug message
4. THE Agent_Loop SHALL pass `mode: "fast"` for normal turns and `mode: "thorough"` when the user's message contains explicit recall phrases ("remember when", "what did I say about", "last time", "previously")
5. THE Agent_Loop SHALL limit the injected Retrieval_Context to a configurable token budget (default 2048 tokens, configurable via `MEMORY_CONTEXT_BUDGET` environment variable)
6. WHEN the Agent_Loop estimates total message tokens, THE Agent_Loop SHALL include the injected Retrieval_Context in the token count for compaction threshold calculations

### Requirement 9: Archive-Before-Compact Integration

**User Story:** As a user, I want the full conversation archived before compaction occurs, so that no detail is ever lost even when the context window is aggressively compressed.

#### Acceptance Criteria

1. WHEN the Agent_Loop triggers context compaction (token count exceeds compaction threshold), THE Agent_Loop SHALL first archive all messages that will be compacted by sending each to the Archive via the Memory_Client
2. WHEN archiving messages before compaction, THE Agent_Loop SHALL record each message with `event_type: "pre_compaction"` and include the session identifier and turn number in the metadata
3. WHEN archiving is complete, THE Agent_Loop SHALL proceed with the existing compaction flow (claw-compactor compression with trimMessages fallback)
4. IF archiving fails before compaction, THEN THE Agent_Loop SHALL log the error and proceed with compaction without blocking the agent's operation
5. WHEN the Compactor compresses messages, THE Agent_Loop SHALL emit a `qwen-event` with type `memory-archive` containing the count of archived messages and the archive status

### Requirement 10: Memory-Aware Orchestrator Integration

**User Story:** As a developer, I want the orchestrator to provide memory context to dispatched agents, so that task execution benefits from cross-session knowledge without each agent needing to manage memory independently.

#### Acceptance Criteria

1. WHEN the Orchestrator dispatches a task to an agent, THE Orchestrator SHALL query the Memory_Client for facts relevant to the task title and description
2. WHEN Retrieval_Context is available for a dispatched task, THE Orchestrator SHALL include the Retrieval_Context in the task's `specContext` field, appended after any existing spec context
3. WHEN an agent completes a task, THE Orchestrator SHALL archive the task result (output, duration, agent type) to the Archive via the Memory_Client with `event_type: "task_completion"`
4. WHILE the Memory_Client is unavailable, THE Orchestrator SHALL dispatch tasks without memory augmentation and continue normal operation
5. WHEN the Orchestrator starts execution, THE Orchestrator SHALL archive the full task graph structure to the Archive with `event_type: "workflow_start"`

### Requirement 11: Node.js Memory Client Module

**User Story:** As a developer, I want a Node.js module that wraps all memory HTTP endpoints, so that the Electron main process and agent modules can interact with memory through a clean async API.

#### Acceptance Criteria

1. THE Memory_Client SHALL export async functions: `retrieve(query, options)`, `archiveRecord(eventType, payload, summary)`, `extractTurn(message, agentName, sessionId)`, `kgAddTriple(subject, predicate, object)`, `kgQueryEntity(entity)`, `vectorSearch(query, options)`, `archiveSearch(query, options)`, and `getStatus()`
2. THE Memory_Client SHALL read the server base URL from the `MLX_SERVER_URL` environment variable, defaulting to `http://localhost:8090`
3. WHEN a Memory_Client function call fails due to a network error or HTTP 5xx response, THE Memory_Client SHALL return a default empty result (empty array for searches, null for status) and log the error, without throwing an exception
4. THE Memory_Client SHALL use Node.js built-in `http` module for HTTP requests (no external HTTP client dependency)
5. THE Memory_Client SHALL implement a configurable request timeout (default 5 seconds for retrieval, 2 seconds for archive writes, 30 seconds for extraction)

### Requirement 12: Tool Call and Decision Archiving

**User Story:** As a user, I want every tool call and its result archived, so that the full decision trail is preserved and searchable across sessions.

#### Acceptance Criteria

1. WHEN the Agent_Loop executes a tool call, THE Agent_Loop SHALL archive the tool name, arguments, and result to the Archive via the Memory_Client with `event_type: "tool_call"`
2. WHEN archiving a tool call, THE Agent_Loop SHALL include the tool name, a summary of the arguments (first 200 characters), the result status (success or error), and the result size in bytes as metadata
3. WHEN the Agent_Loop receives an assistant response containing reasoning or decisions, THE Agent_Loop SHALL archive the response with `event_type: "decision"` and a summary extracted from the first 200 characters
4. THE Agent_Loop SHALL archive tool calls and decisions asynchronously (fire-and-forget) without awaiting the archive response to avoid adding latency to the agent loop
5. IF a tool call result exceeds 10000 characters, THEN THE Agent_Loop SHALL archive only the first 10000 characters of the result with a metadata flag `truncated: true`

### Requirement 13: Session Management and Crystal Generation

**User Story:** As a user, I want conversation sessions automatically cataloged and crystallized into compressed digests, so that long-term patterns and lessons are captured in the Knowledge Graph.

#### Acceptance Criteria

1. WHEN a new conversation starts (first user message in a session), THE Memory_Client SHALL register the session with the Archive by recording an event with `event_type: "session_start"` including the session identifier and timestamp
2. WHEN a conversation session ends (user closes the chat or starts a new conversation), THE Memory_Client SHALL record a `session_end` event and trigger session enrichment via `POST /memory/session/enrich`
3. THE Memory_Backend SHALL expose a `POST /memory/session/enrich` endpoint that runs the Session Catalog enrichment pipeline (topic extraction, description, category assignment) on the completed session
4. THE Memory_Backend SHALL expose a `POST /memory/session/crystallize` endpoint that generates a Crystal_Store digest (narrative summary, outcomes, lessons) and feeds extracted lessons back into the Knowledge_Graph
5. WHILE the Extraction_Model is not loaded, THE Memory_Backend SHALL use heuristic-only session enrichment (tier 1) instead of LLM-based enrichment

### Requirement 14: Memory Data Management

**User Story:** As a developer, I want endpoints for managing memory data (clearing, exporting, inspecting), so that the memory system can be maintained and debugged.

#### Acceptance Criteria

1. THE Memory_Backend SHALL expose a `DELETE /memory/kg/clear` endpoint that removes all triples from the Knowledge_Graph (requires confirmation via a `confirm: true` field in the request body)
2. THE Memory_Backend SHALL expose a `GET /memory/stats` endpoint that returns storage sizes (SQLite database sizes in bytes), record counts (triples, vectors, archive events), and the last extraction timestamp
3. THE Memory_Backend SHALL expose a `POST /memory/archive/compress` endpoint that triggers gzip compression of archive JSONL files older than 24 hours
4. THE Memory_Backend SHALL store all persistent data under `~/.qwencoder/memory/` with the following structure: `knowledge-graph.db`, `vector-memory.db`, `archive/` (JSONL files), `archive-index.db`, `crystals.db`
5. IF the `~/.qwencoder/memory/` directory does not exist, THEN THE Memory_Backend SHALL create it and all required subdirectories on first initialization

### Requirement 15: Secret Filtering on Ingest

**User Story:** As a user, I want sensitive information automatically redacted before it enters the memory system, so that API keys, passwords, and tokens are not persisted in the knowledge graph or archive.

#### Acceptance Criteria

1. WHEN content is ingested into any memory layer (Knowledge_Graph, Vector_Memory, Archive), THE Memory_Backend SHALL apply taosmd's secret filtering pipeline (17 regex patterns) to redact sensitive values
2. THE Memory_Backend SHALL redact patterns matching API keys, bearer tokens, passwords, private keys, AWS credentials, and connection strings, replacing matched values with `[REDACTED]`
3. WHEN a value is redacted, THE Memory_Backend SHALL log the redaction event (pattern type and character count redacted) without logging the redacted value itself
4. THE Memory_Backend SHALL apply secret filtering before embedding text into Vector_Memory, ensuring that sensitive values are not encoded into vector representations
