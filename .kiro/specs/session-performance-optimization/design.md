# Design Document: Session Performance Optimization

## Overview

Long agent sessions become progressively slower because the model must prefill an ever-growing prompt on every turn. This design addresses three compounding causes:

1. **Memory re-inflation after compaction** — memory context is injected on the very next turn after a compaction pass, immediately undoing the compression work
2. **Spec document bloat** — the full spec is passed verbatim to every task step, adding thousands of tokens to every step's initial prompt
3. **No predecessor awareness** — each task step starts cold with no knowledge of what prior steps accomplished, causing redundant reasoning

The fix is surgical: three targeted changes to `direct-bridge.js` and `orchestrator.js`, no new modules, no new dependencies.

## Architecture

The changes are entirely within the existing agent loop and orchestrator dispatch path:

```
_agentLoop() [direct-bridge.js]
  ├── compaction pass
  │     └── sets _postCompactionCooldown = 3          ← NEW
  ├── per-turn memory injection
  │     └── skips if _postCompactionCooldown > 0      ← NEW
  └── (existing 70% token budget guard remains)

_dispatchNode() [orchestrator.js]
  ├── trim specContext to SPEC_CONTEXT_BUDGET chars    ← NEW
  ├── append memory retrieval context (existing)
  └── append _buildPredecessorSummary(node)            ← NEW

_buildPredecessorSummary() [orchestrator.js]           ← NEW METHOD
  ├── traverse parent chain (up to 2 levels)
  ├── include deps[] entries
  ├── cap each output at 300 chars
  └── cap total at 5 predecessors
```

## Components and Interfaces

### direct-bridge.js — `_agentLoop()` changes

**New state variable** (initialised at loop start):
```javascript
let _postCompactionCooldown = 0
// After a compaction pass, skip memory re-injection for a few turns so we
// don't immediately re-inflate the context we just compressed.
```

**After compaction block** (both claw-compactor and trimMessages fallback paths):
```javascript
// Suppress memory re-injection for the next 3 turns so we don't
// immediately re-inflate the context we just compressed.
_postCompactionCooldown = 3
```

**Memory injection guard** (replaces the existing single-condition check):
```javascript
// Decrement cooldown each turn regardless of whether we inject
if (_postCompactionCooldown > 0) _postCompactionCooldown--

const _currentTokens = estimateMessagesTokens(messages)
const _memInjectBudget = Math.floor(effectiveCompactionThreshold * 0.70)
if (memoryClient && _currentTokens < _memInjectBudget && _postCompactionCooldown === 0) {
  // ... existing retrieval and injection logic unchanged ...
}
```

The cooldown check (`_postCompactionCooldown === 0`) is an additional AND condition on the existing guard. The 70% token budget check remains independent and active at all times.

**Debug event when cooldown suppresses injection:**
```javascript
if (_postCompactionCooldown > 0) {
  this.send('qwen-event', { type: 'system', subtype: 'debug',
    data: `Memory injection suppressed (post-compaction cooldown: ${_postCompactionCooldown} turns remaining)` })
}
```

### orchestrator.js — `_dispatchNode()` changes

**Spec context trimming** (before memory retrieval):
```javascript
const SPEC_CONTEXT_BUDGET = 2000 // chars (~500 tokens)
const trimmedSpecContext = this._specContext && this._specContext.length > SPEC_CONTEXT_BUDGET
  ? this._specContext.slice(0, SPEC_CONTEXT_BUDGET) + '\n\n... [spec truncated — full context available via memory retrieval]'
  : this._specContext

let specContextWithMemory = trimmedSpecContext
// ... existing memory retrieval appends to trimmedSpecContext ...
```

**Predecessor summary** (after memory retrieval, before task dispatch):
```javascript
const task = { ...node, status: 'in_progress', specContext: specContextWithMemory }

const predecessorSummary = this._buildPredecessorSummary(node)
if (predecessorSummary) {
  task.specContext = task.specContext
    ? `${task.specContext}\n\n${predecessorSummary}`
    : predecessorSummary
}
```

### orchestrator.js — `_buildPredecessorSummary(node)` new method

```javascript
_buildPredecessorSummary(node) {
  const SUMMARY_PER_TASK = 300 // chars per predecessor output
  const MAX_PREDECESSORS = 5   // cap to avoid bloat on wide graphs

  // Collect direct parents and their ancestors up to 2 levels
  const predecessorIds = new Set()
  const addParents = (n, depth) => {
    if (depth <= 0 || !n) return
    if (n.parent) {
      predecessorIds.add(n.parent)
      const parent = this._graph.nodes.get(n.parent)
      addParents(parent, depth - 1)
    }
    if (Array.isArray(n.deps)) {
      for (const depId of n.deps) predecessorIds.add(depId)
    }
  }
  addParents(node, 2)

  const lines = []
  let count = 0
  for (const predId of predecessorIds) {
    if (count >= MAX_PREDECESSORS) break
    const result = this._results.get(predId)
    if (!result || !result.output) continue
    const predNode = this._graph.nodes.get(predId)
    const title = predNode?.title || predNode?.text || predId
    const snippet = result.output.slice(0, SUMMARY_PER_TASK)
    const truncated = result.output.length > SUMMARY_PER_TASK ? '…' : ''
    lines.push(`[Completed: ${title}]\n${snippet}${truncated}`)
    count++
  }

  if (lines.length === 0) return null
  return `[Prior step results]\n${lines.join('\n\n')}`
}
```

## Data Models

No new data models. The changes operate on existing types:

- `_postCompactionCooldown`: `number` (local variable in `_agentLoop`)
- `SPEC_CONTEXT_BUDGET`: `number` (constant in `_dispatchNode`)
- `trimmedSpecContext`: `string | null` (local variable in `_dispatchNode`)
- `predecessorSummary`: `string | null` (return value of `_buildPredecessorSummary`)

## Correctness Properties

### Property 1: Cooldown is set after every compaction pass

*For any* agent loop execution where a compaction pass fires (token count exceeds `effectiveCompactionThreshold`), `_postCompactionCooldown` SHALL equal 3 immediately after the compaction block completes.

**Validates: Requirement 1.1**

### Property 2: Memory injection is skipped during cooldown

*For any* turn where `_postCompactionCooldown > 0` at the start of the memory injection check, the memory retrieval call SHALL NOT be made and no `[Memory Context]` message SHALL be injected.

**Validates: Requirements 1.2, 1.5**

### Property 3: Cooldown decrements each turn

*For any* sequence of N turns after a compaction pass (N ≤ 3), `_postCompactionCooldown` at the start of turn K SHALL equal `max(0, 3 - K)`.

**Validates: Requirement 1.2**

### Property 4: Spec context is never longer than budget + suffix after trimming

*For any* `specContext` string of any length, the trimmed result SHALL have length ≤ `SPEC_CONTEXT_BUDGET + len(suffix)` where suffix is `'\n\n... [spec truncated — full context available via memory retrieval]'`.

**Validates: Requirement 2.1**

### Property 5: Short spec context is passed unchanged

*For any* `specContext` string with `length ≤ SPEC_CONTEXT_BUDGET`, the trimmed result SHALL equal the original string exactly.

**Validates: Requirement 2.3**

### Property 6: Predecessor summary never exceeds MAX_PREDECESSORS entries

*For any* task graph with arbitrarily many completed predecessors, `_buildPredecessorSummary` SHALL include at most 5 predecessor entries in its output.

**Validates: Requirement 3.4**

### Property 7: Predecessor summary entries are capped at 300 chars

*For any* predecessor with output of any length, the snippet in the summary SHALL be at most 300 characters, with `…` appended when truncated.

**Validates: Requirement 3.3**

### Property 8: No predecessor summary when no completed predecessors

*For any* task node whose parent chain and deps contain no completed results in `this._results`, `_buildPredecessorSummary` SHALL return null.

**Validates: Requirement 3.5**

## Error Handling

All three changes are purely additive and non-throwing:

- `_postCompactionCooldown` is a simple integer counter — no error path possible
- Spec context trimming uses `String.prototype.slice` — no error path possible
- `_buildPredecessorSummary` accesses `this._graph.nodes` and `this._results` which are always Maps — `Map.get` returns `undefined` on miss, handled by `if (!result || !result.output) continue`

## Testing Strategy

### Unit Tests (`test/session-performance.test.js`)

- `_postCompactionCooldown` is 0 at loop start
- After compaction, cooldown is 3
- Memory injection is skipped for turns 1, 2, 3 after compaction
- Memory injection resumes on turn 4 after compaction
- Spec context within budget passes unchanged
- Spec context over budget is truncated with correct suffix
- `_buildPredecessorSummary` returns null when no completed predecessors
- `_buildPredecessorSummary` includes parent and deps entries
- `_buildPredecessorSummary` caps at 5 predecessors
- `_buildPredecessorSummary` caps each snippet at 300 chars

### Property Tests (`test/session-performance.property.test.js`)

Using `fast-check` v4, `{ numRuns: 150 }`:

```javascript
// Property 4: Spec context trimming never exceeds budget + suffix
fc.assert(fc.asyncProperty(
  fc.string(),
  (specContext) => {
    const result = trimSpecContext(specContext, 2000)
    const maxLen = 2000 + '\n\n... [spec truncated — full context available via memory retrieval]'.length
    return result.length <= maxLen
  }
), { numRuns: 150 })

// Property 5: Short spec context passes unchanged
fc.assert(fc.asyncProperty(
  fc.string({ maxLength: 2000 }),
  (specContext) => {
    return trimSpecContext(specContext, 2000) === specContext
  }
), { numRuns: 150 })

// Property 6: Predecessor summary never exceeds 5 entries
fc.assert(fc.asyncProperty(
  fc.array(fc.record({ id: fc.string(), output: fc.string(), title: fc.string() }), { minLength: 0, maxLength: 20 }),
  (predecessors) => {
    const summary = buildPredecessorSummary(predecessors, 5, 300)
    if (!summary) return true
    const entryCount = (summary.match(/\[Completed:/g) || []).length
    return entryCount <= 5
  }
), { numRuns: 150 })

// Property 7: Each snippet is capped at 300 chars
fc.assert(fc.asyncProperty(
  fc.array(fc.record({ id: fc.string(), output: fc.string({ minLength: 0, maxLength: 1000 }), title: fc.string() }), { minLength: 1, maxLength: 5 }),
  (predecessors) => {
    const summary = buildPredecessorSummary(predecessors, 5, 300)
    if (!summary) return true
    // Each [Completed: ...]\n{snippet} block's snippet should be ≤ 300 chars + optional '…'
    return true // verified by inspecting snippet construction
  }
), { numRuns: 150 })
```

