# Tech Stack & Build

## Runtime

- **Electron 41.x** — main process + renderer; Node.js with CommonJS throughout
- **Python 3.12+** — FastAPI + MLX inference server on port 8090
- **Target platform:** macOS Apple Silicon (arm64) only

## Key Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@qwen-code/sdk` | ^0.1.6 | Qwen Code agent SDK |
| `openai` | ^4.0.0 | OpenAI-compatible API client |
| `playwright` | ^1.59.1 | Browser automation for agent tool use |
| `chokidar` | ^5.0.0 | File watching |
| `node-pty` | ^1.1.0 | Terminal/PTY support |
| `ws` | ^8.20.0 | WebSocket server |
| `sharp` | ^0.34.5 | Image processing |
| `fast-check` | ^4.7.0 (dev) | Property-based testing |
| `electron-builder` | ^26.0.12 (dev) | Packaging |

Minimize external dependencies — justify any new addition before adding it.

## Python Backend

- FastAPI + MLX for local model inference; OpenAI-compatible `/v1/chat/completions` with streaming SSE
- Vision support via MLX VLM models
- Models loaded from `~/.lmstudio/models/`
  - Primary: `TheCluster/Qwen3.6-35B-A3B-MLX-8bit`
  - Fast: `mlx-community/Qwen3.5-0.8B-MLX-8bit`

## Common Commands

```bash
npm start        # launch Electron (development)
npm test         # node --test 'test/*.test.js'
npm run build    # electron-builder --mac --dir
npm run dist     # electron-builder --mac (produces .dmg)
```

---

## Code Style — Critical Rules

These rules are non-negotiable. Apply them to every file you create or modify.

1. **`'use strict'`** at the top of every Node.js module — no exceptions.
2. **CommonJS only** — `require` / `module.exports`; never `import` / `export`.
3. **No TypeScript** — plain JavaScript throughout.
4. **Renderer is vanilla JS** — direct DOM manipulation; no React, Vue, or any framework.
5. **Prefer Node.js built-ins** — `node:events`, `node:fs`, `node:crypto`, `node:test`, `node:assert`.
6. **File size** — keep each `write_file` call under 300 lines; split into multiple files if needed.
7. **Token budgets** — centralized in `config.js`; never hardcode token limits elsewhere.
8. **Optional dependencies** (e.g. `memory-client.js`, `assist-client.js`) — load with `try/require` and degrade gracefully if unavailable.

---

## Architecture Patterns

### IPC

- Split into domain modules under `main/ipc-*.js`, each exporting `register(ipcMain, ctx)`.
- Add new IPC domains as separate files; do not add handlers directly to `main.js`.

### Agent Routing

- `agent-pool.js` routes by keyword matching via `CATEGORY_KEYWORDS`.
- Explicit `metadata.category` on a request overrides keyword matching.

### DirectBridge (Tool Execution Loop)

- Owns system prompt construction and the full tool loop: model → `tool_calls` → execute → feed back → repeat until `finish_reason: stop`.
- Do not replicate this loop elsewhere.

### LSP Integration

- LSP tools are merged into `allowedTools` at dispatch time only when `lspManager.getStatus().status === 'ready'`.
- Never assume LSP is available; always guard with a status check.

### Context & Token Management

- Spec context passed to agents is truncated to 2000 chars to avoid prompt bloat.
- Token estimation: `chars / 4` — matches the server-side heuristic in `server.py`.
- Compaction triggers at 65% of context window (`COMPACTION_THRESHOLD` in `config.js`).

---

## Testing

- **Runner:** Node.js built-in `node:test`; assertions via `node:assert/strict`.
- **Property-based testing:** `fast-check` v4, target 100–150 runs (`{ numRuns: 150 }`).
- **No external mocking library** — use mock objects and factory functions.

### Test File Conventions (`test/`)

| Pattern | Purpose |
|---|---|
| `*.test.js` | Unit / integration tests |
| `*.property.test.js` | Property-based tests |
| `*.preservation.property.test.js` | Preservation properties (bugfix verification) |

Run all tests: `npm test` → `node --test 'test/*.test.js'`

---

## Task Graph Markers (`tasks.md`)

| Marker | Meaning |
|---|---|
| `- [ ]` | Not started |
| `- [-]` | In progress |
| `- [x]` | Completed |
| `- [~]` | Queued |
| `- [ ]*` | Optional task |

- Branch nodes: annotate with `^branch`; loop nodes: `^loop`.
- Branch agents return `RoutingDecision` JSON: `{"route": "<taskId>", "reason": "..."}`.
