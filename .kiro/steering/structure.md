# Project Structure

```
qwencoder-mac-studio/
├── main.js                    # Electron entry point — IPC wiring, agent factory, role overlays
├── config.js                  # Token budgets, model paths, compaction thresholds (single source of truth)
├── package.json
│
├── main/                      # IPC handler modules — one file per domain
│   ├── ipc-server.js          # Server lifecycle (start/stop MLX server)
│   ├── ipc-chat.js            # Chat/conversation IPC
│   ├── ipc-files.js           # File read/write IPC
│   ├── ipc-projects.js        # Project management IPC
│   ├── ipc-tasks.js           # Task graph IPC
│   ├── ipc-watcher.js         # File watcher IPC
│   ├── ipc-lsp.js             # LSP diagnostics IPC
│   └── ipc-calibration.js     # Calibration IPC
│
├── renderer/                  # Renderer process — vanilla JS, no framework
│   ├── index.html
│   ├── app.js                 # Main renderer logic (direct DOM manipulation)
│   ├── style.css
│   └── lib/                   # Renderer utility modules
│
├── agent-pool.js              # Semaphore-based concurrency, keyword routing, type registry
├── direct-bridge.js           # Qwen SDK wrapper, system prompt builder, full tool execution loop
├── orchestrator.js            # DAG execution engine, branch/loop logic, SAFE_EDIT_INSTRUCTIONS
├── task-graph.js              # Task graph data structures and traversal
├── spec-workflow.js           # Spec-driven development workflow
├── lsp-manager.js             # LSP lifecycle and diagnostics
├── compactor.js               # Conversation compaction (JS side)
├── compactor-bridge.py        # Conversation compaction (Python bridge)
├── compactor-builtin.js       # Built-in compaction logic
├── memory-client.js           # Memory backend client (optional — degrades gracefully)
├── memory-bridge.py           # Memory backend Python bridge
├── assist-client.js           # Assist client (optional — degrades gracefully)
├── calibrator.js              # Adaptive calibration logic
├── playwright-tool.js         # Playwright browser automation tool definitions
├── web-tools.js               # Web search/fetch tool definitions
├── vision-tool.js             # Vision/image tool definitions
├── ast-search.js              # AST-based code search
├── search-worker.js           # Background search worker
├── steering-loader.js         # Loads .kiro/steering docs into agent prompts
├── steering-generator.js      # Generates steering docs
├── projects.js                # Project/session management, API key storage
├── preload.js                 # Electron preload script (contextBridge)
│
├── telegram-bot.js            # Telegram bot for remote job control
├── telegram-miniapp-server.js # Mini app HTTP/WS server
├── telegram-miniapp.html      # Telegram mini app UI
├── recording-manager.js       # Video recording management
├── remote-job-controller.js   # Remote job orchestration via Telegram
│
├── server.py                  # FastAPI + MLX inference server (port 8090)
│
├── test/                      # All tests
│   ├── *.test.js              # Unit / integration tests
│   ├── *.property.test.js     # Property-based tests (fast-check)
│   └── *.preservation.property.test.js  # Bugfix preservation properties
│
├── assets/                    # Static assets (icons, jinja templates, Rust reference files)
├── resources/bin/             # Bundled binaries (sg/ast-grep, agent-lsp)
├── src/                       # Miscellaneous source files (camera.js, scene.js)
│
└── .kiro/
    ├── specs/                 # Spec-driven development specs (requirements/design/tasks per feature)
    ├── steering/              # Steering docs injected into agent prompts
    └── hooks/                 # Agent automation hooks
```

## Key Relationships

- `main.js` creates `DirectBridge` and `AgentPool`, registers all IPC modules via `register(ipcMain, ctx)`.
- `AgentPool` dispatches tasks to agents created by the `agentFactory` in `main.js`.
- `DirectBridge` builds system prompts (with role overlays from `ROLE_OVERLAYS`) and runs the tool loop.
- `Orchestrator` drives DAG execution by calling `agentPool.dispatch()` for each node.
- `steering-loader.js` reads `.kiro/steering/*.md` and injects content into agent system prompts.
- Optional modules (`memory-client.js`, `assist-client.js`) are loaded with `try/require` — absence is non-fatal.
