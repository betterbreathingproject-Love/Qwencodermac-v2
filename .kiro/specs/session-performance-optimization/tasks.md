# Implementation Plan: Session Performance Optimization

## Overview

Three targeted changes to stop long sessions from getting progressively slower. All changes are in existing files — no new modules required. Tasks 1–3 are already implemented in the codebase; tasks 4–6 add tests and the optional autotune integration.

## Tasks

- [x] 1. Post-compaction cooldown in `direct-bridge.js`
  - [x] 1.1 Add `_postCompactionCooldown` state variable
    - Add `let _postCompactionCooldown = 0` to the loop-level state variables at the top of `_agentLoop()`
    - Comment explains: after a compaction pass, skip memory re-injection for a few turns to prevent immediate re-inflation
    - _Requirements: 1.4_

  - [x] 1.2 Set cooldown to 3 after every compaction pass
    - After the compaction block completes (both claw-compactor and trimMessages fallback paths), add `_postCompactionCooldown = 3`
    - This applies regardless of which compaction path ran
    - _Requirements: 1.1_

  - [x] 1.3 Guard memory injection with cooldown check
    - Decrement `_postCompactionCooldown` at the start of the memory injection section: `if (_postCompactionCooldown > 0) _postCompactionCooldown--`
    - Add `&& _postCompactionCooldown === 0` as an additional AND condition on the existing memory injection guard
    - The existing 70% token budget check remains active and independent
    - _Requirements: 1.2, 1.3, 1.5_

- [x] 2. Spec context budget trimming in `orchestrator.js`
  - [x] 2.1 Add `SPEC_CONTEXT_BUDGET` constant and trimming logic in `_dispatchNode()`
    - Define `const SPEC_CONTEXT_BUDGET = 2000` at the top of the dispatch block
    - Compute `trimmedSpecContext`: if `this._specContext` exceeds budget, slice to budget and append `'\n\n... [spec truncated — full context available via memory retrieval]'`
    - Use `trimmedSpecContext` as the base for `specContextWithMemory` instead of `this._specContext` directly
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 3. Predecessor step summaries in `orchestrator.js`
  - [x] 3.1 Add `_buildPredecessorSummary(node)` method to `Orchestrator`
    - Traverse `node.parent` chain up to 2 levels deep, collecting predecessor IDs
    - Also include any IDs in `node.deps` array if present
    - For each predecessor ID, look up `this._results.get(predId)` — skip if no output
    - Cap each output snippet at 300 chars, append `…` when truncated
    - Cap total predecessors at 5
    - Return `null` when no completed predecessors with output exist
    - Format: `[Prior step results]\n[Completed: {title}]\n{snippet}\n\n...`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 3.2 Call `_buildPredecessorSummary` in `_dispatchNode()` and append to task specContext
    - After building `specContextWithMemory`, call `this._buildPredecessorSummary(node)`
    - If non-null, append to `task.specContext` (after memory context, before dispatch)
    - _Requirements: 3.1, 3.7_

- [ ] 4. Write tests for cooldown behaviour (`test/session-performance.test.js`)
  - [ ] 4.1 Unit tests for `_postCompactionCooldown`
    - Test: cooldown is 0 at loop start (no compaction fired)
    - Test: cooldown is 3 immediately after a compaction pass
    - Test: memory injection is skipped on turns 1, 2, 3 after compaction (cooldown > 0)
    - Test: memory injection resumes on turn 4 after compaction (cooldown reaches 0)
    - Test: a second compaction resets cooldown back to 3
    - Use `node:test` and `node:assert/strict`
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [ ] 4.2 Unit tests for spec context trimming
    - Test: string within budget passes unchanged
    - Test: string exactly at budget passes unchanged
    - Test: string one char over budget is truncated with correct suffix
    - Test: very long string is truncated to budget + suffix length
    - Test: null/undefined specContext is handled gracefully (no crash)
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ] 4.3 Unit tests for `_buildPredecessorSummary`
    - Test: returns null when no predecessors have results
    - Test: returns null when predecessors exist but have no output
    - Test: includes parent node output in summary
    - Test: includes deps entries in summary
    - Test: caps at 5 predecessors when more exist
    - Test: caps each snippet at 300 chars with `…` suffix
    - Test: output format matches `[Prior step results]\n[Completed: {title}]\n{snippet}`
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6_

- [ ] 5. Write property tests (`test/session-performance.property.test.js`)
  - [ ] 5.1 Property tests for spec context trimming (Properties 4, 5)
    - **Property 4**: For any string, trimmed result length ≤ `SPEC_CONTEXT_BUDGET + suffix.length`
    - **Property 5**: For any string with `length ≤ SPEC_CONTEXT_BUDGET`, result equals input exactly
    - Use `fast-check` with `{ numRuns: 150 }`
    - Tag: `Feature: session-performance-optimization, Property 4/5`
    - _Requirements: 2.1, 2.3_

  - [ ] 5.2 Property tests for predecessor summary (Properties 6, 7, 8)
    - **Property 6**: For any set of predecessors (0–20), summary contains at most 5 `[Completed:` entries
    - **Property 7**: For any predecessor with output of any length, snippet in summary is ≤ 300 chars (+ optional `…`)
    - **Property 8**: For any set of predecessors with no output, result is null
    - Use `fast-check` with `{ numRuns: 150 }`
    - Tag: `Feature: session-performance-optimization, Property 6/7/8`
    - _Requirements: 3.3, 3.4, 3.5_

  - [ ] 5.3 Property test for cooldown monotonic decrement (Property 3)
    - **Property 3**: For any N turns after a compaction pass (N ≤ 3), cooldown at start of turn K equals `max(0, 3 - K)`
    - Simulate the decrement logic as a pure function and verify with `fc.integer({ min: 0, max: 10 })`
    - Tag: `Feature: session-performance-optimization, Property 3`
    - _Requirements: 1.2_

- [ ] 6. autotune integration in `server.py` (optional)
  - [ ] 6.1 Add optional autotune middleware import and startup check
    - At server startup, attempt `from llm_autotune import wrap_app` (or equivalent autotune API)
    - If import succeeds, wrap the FastAPI app and log `[server] autotune active — KV cache right-sizing enabled`
    - If import fails, continue silently (no warning, no error)
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ] 6.2 Expose `autotune_enabled` in `GET /memory/status`
    - Add `autotune_enabled: bool` field to the `MemoryStatus` Pydantic model
    - Set to `True` when autotune was successfully imported at startup, `False` otherwise
    - _Requirements: 4.5_

- [ ] 7. Checkpoint — run tests and verify
  - Run `npm test` to verify all new tests pass
  - Manually verify in a long session: after compaction fires, confirm the debug event stream shows "Memory injection suppressed (post-compaction cooldown: N turns remaining)" for 3 turns
  - Confirm spec context in task prompts is capped at ~2000 chars for large specs
  - Confirm predecessor summaries appear in task prompts for multi-step workflows

