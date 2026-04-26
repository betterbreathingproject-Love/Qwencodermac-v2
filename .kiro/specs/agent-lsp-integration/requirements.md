# Requirements Document

## Introduction

This specification covers the foundational integration of agent-lsp — a stateful MCP server bridging Language Server Protocol intelligence to AI agents — across the entire QwenCoder Mac Studio application. agent-lsp provides 53 tools covering navigation, analysis, refactoring, and speculative execution for 30 CI-verified languages via a single Go binary. The integration makes semantic code understanding available to every agent interaction: lifecycle management, tool exposure in DirectBridge, subagent-specific tool sets, LSP-powered context building, speculative edit previews, post-edit diagnostics, orchestrator safe-edit workflows, UI status indicators, and graceful degradation when agent-lsp is not installed.

## Glossary

- **Agent_LSP**: The agent-lsp Go binary running as a stateful MCP server (stdio transport) that manages language servers and exposes 53 tools for code intelligence.
- **LSP_Manager**: The Node.js module (`lsp-manager.js`) responsible for spawning, health-checking, and shutting down the Agent_LSP process within the Electron main process.
- **DirectBridge**: The existing `DirectBridge` class in `direct-bridge.js` that handles the agent tool execution loop, streaming from the local MLX server, and routing tool calls.
- **Tool_Router**: The logic within DirectBridge's `executeTool` function that dispatches tool calls to the appropriate handler (built-in, browser, web, or LSP).
- **AgentPool**: The existing `AgentPool` class in `agent-pool.js` that manages subagent type registration, keyword-based routing, and concurrent task dispatch.
- **Orchestrator**: The existing `Orchestrator` class in `orchestrator.js` that executes task graphs with DAG-based scheduling.
- **Subagent_Type**: A registered agent configuration in AgentPool with a name, system prompt, and allowed tool list (e.g., `explore`, `implementation`, `general`).
- **Speculative_Edit**: An in-memory simulation of a file edit via agent-lsp's `simulate_edit_atomic` tool that reports diagnostic changes without writing to disk.
- **Blast_Radius**: The set of files and symbols affected by a proposed change, computed by agent-lsp's `get_change_impact` and `get_references` tools.
- **LSP_Status**: The connection state of the Agent_LSP process: `stopped`, `starting`, `ready`, `error`, or `degraded`.
- **Project_Context**: The compact representation of the workspace sent to agents on session resume, currently built from a file tree and task graph in `buildProjectContext()`.
- **Skill**: A pre-built multi-step agent-lsp workflow (e.g., `/lsp-safe-edit`, `/lsp-impact`) that encodes correct tool sequences with phase enforcement.
- **Renderer**: The Electron renderer process (`renderer/app.js`) providing the UI.

## Requirements

### Requirement 1: LSP Manager Lifecycle

**User Story:** As a developer, I want agent-lsp to start automatically when I open a project and shut down when I close it, so that LSP intelligence is always available without manual setup.

#### Acceptance Criteria

1. WHEN a project directory is set via `setCurrentProject`, THE LSP_Manager SHALL spawn the Agent_LSP process using stdio transport with language server arguments derived from the project contents.
2. WHILE the Agent_LSP process is running, THE LSP_Manager SHALL send periodic health-check pings and track the LSP_Status as `ready`.
3. IF the Agent_LSP process exits unexpectedly, THEN THE LSP_Manager SHALL attempt to restart it up to 3 times with exponential backoff starting at 2 seconds.
4. WHEN the application receives a `window-all-closed` event, THE LSP_Manager SHALL send a shutdown signal to the Agent_LSP process and wait up to 5 seconds before force-killing it.
5. WHEN the user switches to a different project directory, THE LSP_Manager SHALL shut down the current Agent_LSP process and start a new one for the new project directory.
6. THE LSP_Manager SHALL detect installed language servers on the system PATH and configure Agent_LSP arguments accordingly.
7. IF no language servers are found on the system PATH, THEN THE LSP_Manager SHALL set LSP_Status to `degraded` and log a warning without blocking application startup.

### Requirement 2: Tool Exposure in DirectBridge

**User Story:** As an AI agent, I want access to agent-lsp's tools alongside existing file/bash/browser tools, so that I can use semantic code intelligence during task execution.

#### Acceptance Criteria

1. THE Tool_Router SHALL route tool calls with the `lsp_` prefix to the Agent_LSP process via stdio JSON-RPC.
2. WHEN the LSP_Manager reports LSP_Status as `ready`, THE DirectBridge SHALL include agent-lsp tool definitions in the tool list sent to the model.
3. WHEN the LSP_Manager reports LSP_Status as `stopped` or `error`, THE DirectBridge SHALL exclude agent-lsp tool definitions from the tool list and rely on built-in tools only.
4. WHEN an `lsp_` prefixed tool call is received, THE Tool_Router SHALL forward the call to Agent_LSP and return the result within 30 seconds.
5. IF an `lsp_` tool call times out after 30 seconds, THEN THE Tool_Router SHALL return an error message indicating the LSP tool timed out and suggest using a built-in alternative.
6. THE DirectBridge SHALL expose a curated subset of agent-lsp tools relevant to the agent's current role rather than all 53 tools at once.

### Requirement 3: Subagent Tool Set Enhancement

**User Story:** As a system architect, I want each subagent type to have LSP tools appropriate to its role, so that agents use the right level of code intelligence without being overwhelmed by irrelevant tools.

#### Acceptance Criteria

1. WHEN an `explore` Subagent_Type is created, THE AgentPool SHALL include `lsp_get_document_symbols`, `lsp_get_hover`, `lsp_get_definition`, `lsp_get_references`, and `lsp_get_call_hierarchy` in its allowed tools.
2. WHEN a `context-gather` Subagent_Type is created, THE AgentPool SHALL include `lsp_get_document_symbols`, `lsp_get_definition`, `lsp_get_references`, and `lsp_get_type_definition` in its allowed tools.
3. WHEN a `code-search` Subagent_Type is created, THE AgentPool SHALL include `lsp_get_document_symbols`, `lsp_get_references`, `lsp_workspace_symbol`, and `lsp_get_call_hierarchy` in its allowed tools.
4. WHEN an `implementation` Subagent_Type is created, THE AgentPool SHALL include `lsp_simulate_edit_atomic`, `lsp_get_diagnostics`, `lsp_get_definition`, `lsp_get_references`, `lsp_get_change_impact`, and `lsp_apply_code_action` in its allowed tools.
5. WHEN a `general` Subagent_Type is created, THE AgentPool SHALL include the same LSP tools as the `implementation` type.
6. WHILE LSP_Status is not `ready`, THE AgentPool SHALL omit all `lsp_` prefixed tools from every Subagent_Type's allowed tool list.

### Requirement 4: LSP-Powered Context Building

**User Story:** As a developer resuming a session, I want the project context to include semantic symbol outlines instead of just a file tree, so that the agent has richer understanding of the codebase structure.

#### Acceptance Criteria

1. WHEN `buildProjectContext` is called and LSP_Status is `ready`, THE DirectBridge SHALL request `lsp_get_document_symbols` for key entry-point files and include a symbol outline section in the context string.
2. THE DirectBridge SHALL limit the symbol outline to the top 10 files by relevance (entry points, recently edited files, files referenced in the task graph).
3. WHEN `buildProjectContext` is called and LSP_Status is not `ready`, THE DirectBridge SHALL fall back to the existing file-tree-only context without error.
4. THE DirectBridge SHALL cap the combined context string (file tree + symbol outlines + task graph) to 4000 characters to stay within token budget.

### Requirement 5: Speculative Edit Preview

**User Story:** As an AI agent, I want to simulate edits in memory before writing to disk, so that I can catch errors before they happen.

#### Acceptance Criteria

1. WHEN the `implementation` or `general` agent is about to call `write_file`, THE DirectBridge SHALL first call `lsp_simulate_edit_atomic` with the same file path and content to preview diagnostic changes.
2. IF the Speculative_Edit reports new diagnostic errors, THEN THE DirectBridge SHALL include the diagnostic diff in the tool result and allow the agent to decide whether to proceed.
3. IF the Speculative_Edit reports no new errors, THEN THE DirectBridge SHALL proceed with the `write_file` call and include a confirmation that the edit passed speculative validation.
4. WHILE LSP_Status is not `ready`, THE DirectBridge SHALL skip the speculative edit step and execute `write_file` directly as it does today.
5. IF the `lsp_simulate_edit_atomic` call fails or times out, THEN THE DirectBridge SHALL proceed with the `write_file` call and log a warning.

### Requirement 6: Post-Edit Diagnostic Verification

**User Story:** As an AI agent, I want to check for errors immediately after editing a file, so that I can fix problems before moving on.

#### Acceptance Criteria

1. WHEN a `write_file` or `edit_file` tool call completes successfully, THE DirectBridge SHALL call `lsp_get_diagnostics` for the edited file and append any errors or warnings to the tool result.
2. IF `lsp_get_diagnostics` returns errors with severity `error`, THEN THE DirectBridge SHALL prepend a warning header to the tool result indicating the edit introduced errors.
3. WHILE LSP_Status is not `ready`, THE DirectBridge SHALL skip the post-edit diagnostic check and return the tool result as it does today.
4. THE DirectBridge SHALL complete the `lsp_get_diagnostics` call within 10 seconds; IF it exceeds 10 seconds, THEN THE DirectBridge SHALL return the original tool result without diagnostics.

### Requirement 7: Orchestrator Safe-Edit Integration

**User Story:** As a task orchestrator, I want implementation agents to use LSP-powered safe editing workflows, so that task graph execution produces fewer broken edits.

#### Acceptance Criteria

1. WHEN the Orchestrator dispatches a task to an `implementation` Subagent_Type and LSP_Status is `ready`, THE Orchestrator SHALL inject safe-edit workflow instructions into the agent's system prompt.
2. THE safe-edit workflow instructions SHALL direct the agent to: (a) check Blast_Radius via `lsp_get_change_impact` before modifying exported symbols, (b) use `lsp_simulate_edit_atomic` before writing, and (c) call `lsp_get_diagnostics` after writing.
3. WHILE LSP_Status is not `ready`, THE Orchestrator SHALL use the existing system prompt without safe-edit instructions.

### Requirement 8: UI Status and Navigation

**User Story:** As a developer, I want to see the LSP connection status in the UI and navigate symbols from the sidebar, so that I know when code intelligence is active and can browse the codebase semantically.

#### Acceptance Criteria

1. THE Renderer SHALL display an LSP_Status indicator in the status bar area showing the current state: a green dot for `ready`, yellow for `starting`, red for `error`, and gray for `stopped`.
2. WHEN the user clicks the LSP_Status indicator, THE Renderer SHALL show a tooltip or popover with the list of active language servers and their languages.
3. WHEN the user opens the file explorer side panel and LSP_Status is `ready`, THE Renderer SHALL show a "Symbols" sub-section listing document symbols for the currently viewed file.
4. WHEN the user clicks a symbol in the Symbols sub-section, THE Renderer SHALL scroll the file view to that symbol's location.
5. WHILE LSP_Status is not `ready`, THE Renderer SHALL hide the Symbols sub-section and show only the file tree.

### Requirement 9: Graceful Degradation

**User Story:** As a developer who has not installed agent-lsp, I want the application to work exactly as it does today, so that agent-lsp is a pure enhancement with no regressions.

#### Acceptance Criteria

1. WHEN the application starts and the `agent-lsp` binary is not found on the system PATH or in the bundled resources, THE LSP_Manager SHALL set LSP_Status to `stopped` and log an informational message.
2. WHILE LSP_Status is `stopped`, THE DirectBridge SHALL operate with its existing built-in tools only, with no errors or warnings shown to the user.
3. WHILE LSP_Status is `stopped`, THE Renderer SHALL hide all LSP-specific UI elements (status indicator shows gray, Symbols sub-section hidden).
4. THE application SHALL start and become interactive within the same time budget whether or not Agent_LSP is available; THE LSP_Manager SHALL spawn Agent_LSP asynchronously without blocking the main window creation.
5. IF Agent_LSP transitions from `ready` to `error` during a session, THEN THE DirectBridge SHALL remove `lsp_` tools from subsequent model calls and continue operating with built-in tools only.

### Requirement 10: IPC Bridge for LSP Operations

**User Story:** As a renderer process, I want IPC channels to query LSP status and request symbol data, so that the UI can display LSP information without direct access to the main process.

#### Acceptance Criteria

1. THE preload script SHALL expose an `lspStatus` method that returns the current LSP_Status and list of active language servers.
2. THE preload script SHALL expose an `lspSymbols` method that accepts a file path and returns the document symbols for that file.
3. THE preload script SHALL expose an `onLspStatusChange` event listener that fires whenever LSP_Status transitions between states.
4. WHEN the renderer calls `lspStatus` and LSP_Status is `stopped`, THE main process SHALL return `{ status: 'stopped', servers: [] }` without error.
