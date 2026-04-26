# Implementation Plan: Agent LSP Integration

## Overview

Integrate the agent-lsp Go binary into the QwenCoder Mac Studio Electron app. The plan proceeds bottom-up: core LSP process manager first, then IPC plumbing, tool routing in DirectBridge, subagent tool sets, orchestrator safe-edit injection, UI status/symbols, and finally wiring everything into the app lifecycle. Each task builds on the previous so there is no orphaned code.

## Tasks

- [x] 1. Create `lsp-manager.js` — LSP process lifecycle manager
  - [x] 1.1 Implement `LspManager` class with constructor, status enum, and EventEmitter base
    - Create `lsp-manager.js` with `'use strict'`, CommonJS exports
    - Define `LSP_STATUSES` array: `['stopped', 'starting', 'ready', 'error', 'degraded']`
    - Constructor accepts `{ binaryPath, healthCheckInterval, maxRestarts }` with sensible defaults
    - Expose `getStatus()` returning `{ status, servers, projectDir, uptime }`
    - _Requirements: 1.1, 1.2, 1.6, 1.7, 9.1_

  - [x] 1.2 Implement binary discovery and language server detection
    - `_findBinary()` checks `resources/bin/agent-lsp` then falls back to system PATH
    - `_detectLanguageServers()` scans PATH for known binaries (`gopls`, `typescript-language-server`, `pyright`, `rust-analyzer`, etc.)
    - If no binary found, set status to `stopped` and log info message
    - If no language servers found, set status to `degraded` and log warning
    - _Requirements: 1.6, 1.7, 9.1_

  - [x] 1.3 Implement `start(projectDir)` — spawn agent-lsp via `child_process.spawn` with stdio
    - Transition status `stopped` → `starting` → `ready`
    - Pass detected language server arguments to the binary
    - Set up stdout line-buffered JSON-RPC response reader
    - Set up stderr logging
    - Handle spawn errors and set status to `error`
    - Emit `'status-change'` events on every transition
    - _Requirements: 1.1, 1.2, 9.4_

  - [x] 1.4 Implement `call(toolName, args)` — JSON-RPC request/response over stdio
    - Send `{ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments } }` to stdin
    - Read matching response from stdout by `id`
    - 30-second timeout per call
    - Return parsed result or throw on error/timeout
    - _Requirements: 2.1, 2.4, 2.5_

  - [x] 1.5 Implement health check, restart policy, and `stop()`
    - Periodic health-check ping every 30s (configurable via `healthCheckInterval`)
    - On unexpected exit: restart up to `maxRestarts` (default 3) with exponential backoff (2s, 4s, 8s)
    - `stop()`: send shutdown signal, wait 5s, then SIGKILL
    - `restart(projectDir)`: `stop()` then `start()`
    - _Requirements: 1.2, 1.3, 1.4, 1.5_


  - [x] 1.6 Write unit tests for `LspManager` (`test/lsp-manager.test.js`)
    - Test binary discovery with mock filesystem (found in resources, found on PATH, not found)
    - Test language server detection with mock `execSync`/PATH scanning
    - Test status transitions: `stopped` → `starting` → `ready`, error paths, degraded
    - Test `call()` with mock stdio: successful response, timeout, error response
    - Test restart policy: exponential backoff timing, max restart limit
    - Test `stop()`: graceful shutdown within 5s, force kill after timeout
    - Use mock `child_process.spawn` returning fake stdio streams
    - _Requirements: 1.1–1.7, 9.1_

  - [x] 1.7 Write property tests for `LspManager` (`test/lsp-manager.property.test.js`)
    - Status transitions always follow valid state machine paths (no invalid transitions)
    - `call()` request IDs are always unique across arbitrary call sequences
    - Restart count never exceeds `maxRestarts` for any sequence of failures
    - `getStatus()` always returns a valid status enum value
    - Use `fast-check` with `{ numRuns: 150 }`
    - _Requirements: 1.2, 1.3, 1.7_

- [x] 2. Checkpoint — LspManager core
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Create `main/ipc-lsp.js` — IPC handlers for LSP operations
  - [x] 3.1 Implement IPC handler module with `register(ipcMain, ctx)` pattern
    - Follow existing pattern from `main/ipc-tasks.js`
    - `lsp-status` handler: returns `getLspManager()?.getStatus()` or `{ status: 'stopped', servers: [] }`
    - `lsp-symbols` handler: calls `lspManager.call('lsp_get_document_symbols', { path })`, returns `{ symbols: [] }` on failure
    - _Requirements: 10.1, 10.2, 10.4_

  - [x] 3.2 Add LSP IPC channels to `preload.js`
    - Add `lspStatus`, `lspSymbols`, `onLspStatusChange`, `offLspStatusChange` to the `app` context bridge
    - Follow existing naming and style conventions in preload.js
    - _Requirements: 10.1, 10.2, 10.3_

- [x] 4. Modify `direct-bridge.js` — LSP tool routing and edit hooks
  - [x] 4.1 Add `lsp_` tool routing branch in `executeTool`
    - Accept `lspManager` parameter in `executeTool`
    - Route `lsp_`-prefixed tool names to `lspManager.call(name, args)`
    - Check `lspManager.getStatus().status === 'ready'` before routing
    - Return `{ error: 'LSP not available...' }` when not ready
    - 30s timeout via `Promise.race`
    - Return graceful error message on timeout or call failure
    - _Requirements: 2.1, 2.3, 2.4, 2.5_

  - [x] 4.2 Add speculative edit hook before `write_file` execution
    - In the agent loop, before executing `write_file`, call `lsp_simulate_edit_atomic` if LSP is ready
    - If new diagnostics are reported, include them in the tool result for agent review
    - If no new errors, include confirmation that speculative validation passed
    - Skip entirely when LSP is not ready or on failure/timeout
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 4.3 Add post-edit diagnostic hook after `write_file`/`edit_file`
    - After successful `write_file` or `edit_file`, call `lsp_get_diagnostics` for the edited file
    - Prepend warning header if errors with severity `error` are found
    - 10s timeout; skip diagnostics on timeout
    - Skip entirely when LSP is not ready
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 4.4 Add tool list filtering based on LSP status and agent role
    - Implement `getToolDefs(lspManager, agentRole)` that merges built-in `TOOL_DEFS` with role-specific LSP tools
    - Only include LSP tools when `lspManager.getStatus().status === 'ready'`
    - Use `LSP_TOOL_SETS` mapping from agent-pool for role filtering
    - Wire into `_streamCompletion` tool list construction
    - _Requirements: 2.2, 2.3, 2.6_

  - [x] 4.5 Enhance `buildProjectContext` with LSP symbol outlines
    - Accept optional `lspManager` parameter
    - When LSP is ready, call `lsp_get_document_symbols` for top 10 entry-point files
    - `detectEntryPoints(cwd)`: check `package.json` main field, `index.*` files, etc.
    - Format symbol outlines and append to context parts
    - Cap combined context to 4000 characters
    - Fall back to existing file-tree-only context when LSP is not ready
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

