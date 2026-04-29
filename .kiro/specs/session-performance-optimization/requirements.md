# Requirements Document

## Introduction

Long agent sessions in QwenCoder Mac Studio become progressively slower over time. The root cause is context window bloat: the model must prefill an ever-growing prompt on every turn, and on MLX the prefill time scales roughly linearly with token count. Three compounding factors make this worse: (1) memory context is re-injected immediately after compaction, re-inflating the context before it has stabilised; (2) the full spec document is passed verbatim to every task step regardless of relevance; (3) each task step carries no awareness of what predecessor steps already accomplished, so the agent re-reasons from scratch.

This spec addresses all three causes and introduces a step-isolation model where each task step receives exactly the context it needs — the current task description, a compact summary of predecessor outputs, and on-demand memory retrieval — rather than the full accumulated history.

## Glossary

- **Context_Bloat**: The progressive growth of the messages array between compaction passes, causing each LLM prefill to be slower than the last
- **Compaction_Cooldown**: A turn counter that suppresses memory re-injection for N turns after a compaction pass, preventing immediate re-inflation
- **Spec_Context_Budget**: A character cap applied to the `specContext` field before it is passed to a dispatched task, preventing large spec documents from bloating every step's initial prompt
- **Predecessor_Summary**: A compact block of prior step outputs injected into a task's context, giving the agent awareness of what's already been done without carrying full conversation transcripts
- **Step_Isolation**: The design principle that each task step receives a minimal, purpose-built context rather than the full accumulated session history
- **Post_Compaction_Cooldown**: The `_postCompactionCooldown` counter in `_agentLoop()` that tracks how many turns to skip memory injection after a compaction pass
- **autotune**: The `llm-autotune` Python middleware library (https://github.com/tanavc1/local-llm-autotune) that right-sizes KV cache buffers per request, reducing TTFT by ~39% and KV cache RAM by ~67%

## Requirements

### Requirement 1: Post-Compaction Memory Injection Cooldown

**User Story:** As a user running long agent sessions, I want memory context injection to pause briefly after a compaction pass, so that the context window has time to stabilise before new content is added.

#### Acceptance Criteria

1. WHEN a compaction pass completes (either via claw-compactor or the trimMessages fallback), THE Agent_Loop SHALL set a `_postCompactionCooldown` counter to 3
2. WHEN `_postCompactionCooldown` is greater than 0 at the start of a turn, THE Agent_Loop SHALL decrement the counter and skip memory context injection for that turn
3. WHEN `_postCompactionCooldown` is 0, THE Agent_Loop SHALL apply the existing memory injection logic (token budget check + retrieval)
4. THE `_postCompactionCooldown` counter SHALL be initialised to 0 at the start of each `_agentLoop()` invocation
5. THE cooldown SHALL apply only to the proactive memory retrieval injection — it SHALL NOT suppress the existing 70% token budget guard (which remains as an additional independent check)

### Requirement 2: Spec Context Budget per Task Step

**User Story:** As a developer, I want the spec document passed to each task step to be capped at a sensible size, so that large spec files don't bloat every step's initial prompt and slow down prefill.

#### Acceptance Criteria

1. WHEN the Orchestrator dispatches a task, THE Orchestrator SHALL apply a `SPEC_CONTEXT_BUDGET` character cap (default 2000 characters) to `this._specContext` before including it in the task's `specContext` field
2. WHEN `this._specContext` exceeds `SPEC_CONTEXT_BUDGET` characters, THE Orchestrator SHALL truncate it and append the suffix `\n\n... [spec truncated — full context available via memory retrieval]`
3. WHEN `this._specContext` is within `SPEC_CONTEXT_BUDGET` characters, THE Orchestrator SHALL pass it unchanged
4. THE `SPEC_CONTEXT_BUDGET` constant SHALL be defined as a named constant in `orchestrator.js` (default 2000) so it can be tuned without searching for magic numbers
5. THE truncation SHALL be applied before memory context is appended, so the memory retrieval block always follows the (possibly truncated) spec context

### Requirement 3: Predecessor Step Output Summaries

**User Story:** As a developer, I want each dispatched task to receive a compact summary of what predecessor tasks already accomplished, so the agent doesn't re-reason from scratch and can build on prior work efficiently.

#### Acceptance Criteria

1. WHEN the Orchestrator dispatches a task, THE Orchestrator SHALL call `_buildPredecessorSummary(node)` and append the result to the task's `specContext` if non-null
2. THE `_buildPredecessorSummary` method SHALL collect completed predecessor nodes by traversing the node's parent chain up to 2 levels and any `deps` array entries
3. THE `_buildPredecessorSummary` method SHALL cap each predecessor's output at 300 characters, appending `…` when truncated
4. THE `_buildPredecessorSummary` method SHALL include at most 5 predecessors to prevent the summary itself from becoming a bloat source
5. WHEN no completed predecessors with output exist, `_buildPredecessorSummary` SHALL return null and no summary block SHALL be appended
6. THE predecessor summary block SHALL be formatted as `[Prior step results]\n{entries}` where each entry is `[Completed: {title}]\n{snippet}`
7. THE predecessor summary SHALL be appended after the memory context block (i.e. it is the last thing added to `specContext`)

### Requirement 4: autotune KV Cache Optimisation (Optional Integration)

**User Story:** As a user on Apple Silicon, I want the MLX server to right-size its KV cache buffer per request, so that time-to-first-token is reduced and memory pressure is lower during long sessions.

#### Acceptance Criteria

1. THE Python backend (`server.py` or `memory-bridge.py`) SHALL support an optional `autotune` integration that, when the `llm-autotune` package is installed, wraps the `/v1/chat/completions` endpoint with autotune's KV cache right-sizing middleware
2. WHEN `llm-autotune` is not installed, THE server SHALL continue operating exactly as today with no errors or warnings
3. WHEN `llm-autotune` is installed, THE server SHALL log a single startup message confirming autotune is active
4. THE integration SHALL NOT require any changes to the Node.js side — it is purely a Python-side middleware addition
5. THE `GET /memory/status` endpoint SHALL include an `autotune_enabled` boolean field reflecting whether autotune is active

### Requirement 5: Observability — Context Size Tracking

**User Story:** As a developer, I want to see the current context token count and compaction cooldown state in the debug event stream, so I can diagnose performance issues in long sessions.

#### Acceptance Criteria

1. WHEN a compaction pass completes, THE Agent_Loop SHALL emit a `qwen-event` with `type: 'compaction-stats'` that includes the `postCompactionCooldown` value (always 3 after a pass)
2. WHEN memory injection is skipped due to the cooldown, THE Agent_Loop SHALL emit a `qwen-event` with `type: 'system'`, `subtype: 'debug'`, and a message indicating the cooldown turns remaining
3. WHEN the Orchestrator truncates `specContext`, THE Orchestrator SHALL log a debug message indicating the original length and the truncated length
4. WHEN `_buildPredecessorSummary` returns a non-null summary, THE Orchestrator SHALL log a debug message indicating how many predecessors were included

