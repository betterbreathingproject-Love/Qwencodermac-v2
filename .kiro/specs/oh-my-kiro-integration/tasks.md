# Tasks

## Task 1: Task Graph Parser Module

- [x] 1.1 Create `task-graph.js` with TaskNode and TaskGraph data structures
  - [x] 1.1.1 Define TaskNode object factory with id, title, status, depth, dependencies, children, parent, markers, parallel, and metadata fields
  - [x] 1.1.2 Define TaskGraph object factory with nodes Map, startNodeId, and errors array
  - [x] 1.1.3 Define ParseError object with line, message, and severity fields
- [x] 1.2 Implement `parseTaskGraph(markdown)` function
  - [x] 1.2.1 Parse task lines using regex matching `- \[.\] X.Y description` with status extraction (`[ ]`, `[x]`, `[-]`, `[!]`, `[~]`)
  - [x] 1.2.2 Parse special markers: `[^]` for start, `[?branch:condition]` for branch, `[$]` for terminal, `[~loop:targetId#maxIter]` for loop
  - [x] 1.2.3 Determine depth from indentation and build parent-child relationships
  - [x] 1.2.4 Compute dependencies from ordering and nesting — sequential siblings depend on prior sibling
  - [x] 1.2.5 Detect parallelizable siblings (same depth, no explicit dependency)
  - [x] 1.2.6 Collect syntax errors with line numbers for malformed lines
- [x] 1.3 Implement `printTaskGraph(graph)` function
  - [x] 1.3.1 Serialize each TaskNode back to markdown line with correct status bracket and markers
  - [x] 1.3.2 Preserve indentation based on node depth
  - [x] 1.3.3 Preserve node ordering (by ID sort or insertion order)
- [x] 1.4 Implement `validateTaskGraph(graph)` function
  - [x] 1.4.1 Check for circular dependencies via DFS cycle detection
  - [x] 1.4.2 Check for duplicate node IDs
  - [x] 1.4.3 Check for missing start node (warning if multiple roots and no `^start`)
- [x] 1.5 Implement `updateNodeStatus(graph, nodeId, status)` and `getNextExecutableNodes(graph)` utility functions
  - [x] 1.5.1 `updateNodeStatus` returns a new graph with the specified node's status changed
  - [x] 1.5.2 `getNextExecutableNodes` returns all nodes whose dependencies are all `completed` and whose own status is `not_started`
- [x] 1.6 Write unit tests for task-graph.js
  - [x] 1.6.1 Test parsing known Tasks.md fixtures (linear, nested, all markers)
  - [x] 1.6.2 Test edge cases: empty file, single node, deeply nested (10+ levels)
  - [x] 1.6.3 Test syntax error reporting with known-bad inputs
  - [x] 1.6.4 Test print output matches expected markdown format
- [x] 1.7 Write property-based tests for task-graph.js using fast-check
  - [x] 1.7.1 Install fast-check as dev dependency
  - [x] 1.7.2 Implement `arbitraryTaskGraph()` generator producing valid TaskGraph structures
  - [x] 1.7.3 Property 1 test: round-trip (print → parse → compare) with 100+ iterations
  - [x] 1.7.4 Property 2 test: parallel sibling detection invariant with 100+ iterations
  - [x] 1.7.5 Property 3 test: syntax error reporting for generated invalid markdown with 100+ iterations

## Task 2: Orchestrator Module

- [x] 2.1 Create `orchestrator.js` with Orchestrator class extending EventEmitter
  - [x] 2.1.1 Constructor accepts taskGraph, agentPool, tasksFilePath, and callback options
  - [x] 2.1.2 Implement internal state: `idle`, `running`, `paused`, `completed`, `aborted`
- [x] 2.2 Implement execution loop in `start()` method
  - [x] 2.2.1 Find start node (^start or first root), set status to in_progress, emit task-status-event
  - [x] 2.2.2 Main loop: call `getNextExecutableNodes()`, dispatch each to AgentPool, await results
  - [x] 2.2.3 On node completion: update status to completed, emit event, persist graph to Tasks.md
  - [x] 2.2.4 On node failure: update status to failed, emit event, pause execution
  - [x] 2.2.5 Handle parallel nodes: dispatch all eligible nodes concurrently using Promise.all
- [x] 2.3 Implement branch evaluation
  - [x] 2.3.1 When a `?branch` node is reached, evaluate the condition string against current context
  - [x] 2.3.2 Follow the matching edge; if no match, treat as failure
- [x] 2.4 Implement loop handling
  - [x] 2.4.1 Track iteration count per loop node
  - [x] 2.4.2 Re-execute target node up to maxIterations, then advance
- [x] 2.5 Implement `pause()`, `resume()`, `retry(nodeId)`, `skip(nodeId)`, `abort()` methods
- [x] 2.6 Implement `getStatus()` and `getNodeResult(nodeId)` query methods
- [x] 2.7 Implement Tasks.md persistence — write updated graph after each status change
- [x] 2.8 Write unit tests for orchestrator.js
  - [x] 2.8.1 Test linear execution order with mock AgentPool
  - [x] 2.8.2 Test parallel fan-out/fan-in execution
  - [x] 2.8.3 Test branch evaluation with true/false conditions
  - [x] 2.8.4 Test failure handling: pause, retry, skip, abort
  - [x] 2.8.5 Test loop execution with iteration limits
- [x] 2.9 Write property-based tests for orchestrator.js
  - [x] 2.9.1 Property 4 test: dependency-respecting traversal order with 100+ iterations
  - [x] 2.9.2 Property 5 test: status lifecycle state machine with 100+ iterations

## Task 3: Agent Pool Module

- [x] 3.1 Create `agent-pool.js` with AgentPool class extending EventEmitter
  - [x] 3.1.1 Constructor accepts maxConcurrency and defaultTimeout options
  - [x] 3.1.2 Implement subagent type registry (Map of name → SubagentType config)
  - [x] 3.1.3 Implement semaphore-based concurrency control
- [x] 3.2 Implement `registerType(type)` method for registering SubagentType configs
- [x] 3.3 Implement `dispatch(task, context)` method
  - [x] 3.3.1 Select subagent type based on task category keywords in title/metadata
  - [x] 3.3.2 Acquire semaphore slot, spawn QwenBridge instance with CallbackSink and type's system prompt and tools
  - [x] 3.3.3 Forward streaming events (text-delta, tool-use, tool-result) to the orchestrator
  - [x] 3.3.4 On completion: collect result, release semaphore slot, return TaskResult
  - [x] 3.3.5 On timeout: terminate agent, release slot, return timeout error
- [x] 3.4 Implement `dispatchBackground(task, context)` method
  - [x] 3.4.1 Spawn a worker_thread with its own QwenBridge instance using WorkerSink
  - [x] 3.4.2 Return task ID immediately, buffer streaming events in BackgroundTask object
  - [x] 3.4.3 On worker completion: update BackgroundTask status, store result
- [x] 3.5 Implement `cancel(taskId)` method — terminate worker thread, mark as cancelled
- [x] 3.6 Implement `getRunningTasks()`, `getBackgroundTasks()`, and `shutdown()` methods
- [x] 3.7 Write unit tests for agent-pool.js
  - [x] 3.7.1 Test type registration and selection with mock agents
  - [x] 3.7.2 Test timeout behavior with delayed mock agents
  - [x] 3.7.3 Test background task lifecycle: spawn, buffer events, complete, cancel
- [x] 3.8 Write property-based tests for agent-pool.js
  - [x] 3.8.1 Property 6 test: agent type selection correctness with 100+ iterations
  - [x] 3.8.2 Property 7 test: concurrency limit enforcement with 100+ iterations

## Task 4: AST-Based Code Search Module

- [x] 4.1 Create `ast-search.js` module
  - [x] 4.1.1 Implement `detectBackend()` — check for `sg` (ast-grep), then `rg` (ripgrep), then fallback to built-in Node.js fs+regex
  - [x] 4.1.2 Implement `validatePattern(pattern, language)` — check pattern syntax before search
  - [x] 4.1.3 Implement `astSearch(pattern, cwd)` — shell out to `sg run --pattern <pattern> --json`, parse results
  - [x] 4.1.4 Implement ripgrep fallback when ast-grep is not installed
  - [x] 4.1.5 Implement built-in Node.js fallback using `fs.readdirSync` recursive + regex matching when neither `sg` nor `rg` is available
  - [x] 4.1.6 Implement `getSupportedPatterns()` returning example patterns for each supported construct
  - [x] 4.1.7 Implement `getSearchStatus()` returning current backend (ast-grep/ripgrep/builtin), version, and path
- [x] 4.2 Support JavaScript, TypeScript, Python, and JSON file types via language detection from file extension
- [x] 4.3 Parse ast-grep JSON output into SearchResult objects with file, startLine, endLine, snippet
- [x] 4.4 Write unit tests for ast-search.js
  - [x] 4.4.1 Test pattern validation for valid and invalid patterns
  - [x] 4.4.2 Test search against fixture source files for each supported language
  - [x] 4.4.3 Test ripgrep fallback behavior
- [x] 4.5 Write property-based tests for ast-search.js
  - [x] 4.5.1 Property 8 test: search result completeness (all fields present) with 100+ iterations
  - [x] 4.5.2 Property 9 test: invalid pattern error descriptiveness with 100+ iterations

## Task 5: Spec-Driven Development Workflow Module

- [x] 5.1 Create `spec-workflow.js` module
  - [x] 5.1.1 Implement `initSpec(featureName, projectDir)` — create `.kiro/specs/{name}/` directory with `.config.kiro`
  - [x] 5.1.2 Implement `getSpecPhase(specDir)` — read config and determine current phase
  - [x] 5.1.3 Implement `advancePhase(specDir)` — move to next phase in sequence (requirements → design → tasks → implementation)
  - [x] 5.1.4 Implement `getSpecArtifacts(specDir)` — read and return all existing spec files
  - [x] 5.1.5 Implement `generateTaskGraphFromDesign(designMd)` — extract tasks from design document into Tasks.md format
- [x] 5.2 Write unit tests for spec-workflow.js
  - [x] 5.2.1 Test initSpec creates directory and config file
  - [x] 5.2.2 Test phase transitions follow correct order
  - [x] 5.2.3 Test advancePhase from implementation does not change phase
  - [x] 5.2.4 Test getSpecArtifacts returns existing files
- [x] 5.3 Write property-based tests for spec-workflow.js
  - [x] 5.3.1 Property 10 test: spec phase transition validity with 100+ iterations

## Task 6: IPC and UI Integration

- [x] 6.1 Add IPC handlers to `main.js`
  - [x] 6.1.1 Task graph IPC: `task-graph-parse`, `task-graph-execute`, `task-graph-pause`, `task-graph-resume`, `task-graph-status`
  - [x] 6.1.2 Background task IPC: `bg-task-list`, `bg-task-cancel`, `bg-task-output`
  - [x] 6.1.3 AST search IPC: `ast-search`, `ast-patterns`, `ast-search-status`
  - [x] 6.1.4 Spec workflow IPC: `spec-init`, `spec-phase`, `spec-advance`
  - [x] 6.1.5 Event forwarding: forward `task-status-event` and `bg-task-event` from orchestrator/pool to renderer
- [x] 6.2 Update `preload.js` with new IPC channel bindings
  - [x] 6.2.1 Expose task graph operations: `taskGraphParse`, `taskGraphExecute`, `taskGraphPause`, `taskGraphResume`, `taskGraphStatus`
  - [x] 6.2.2 Expose background task operations: `bgTaskList`, `bgTaskCancel`, `bgTaskOutput`
  - [x] 6.2.3 Expose AST search operations: `astSearch`, `astPatterns`, `astSearchStatus`
  - [x] 6.2.4 Expose spec workflow operations: `specInit`, `specPhase`, `specAdvance`
  - [x] 6.2.5 Expose event listeners: `onTaskStatusEvent`, `onBgTaskEvent`
- [x] 6.3 Add Task Graph Panel to renderer
  - [x] 6.3.1 Create task graph panel HTML structure in `renderer/index.html` with node list and status indicators
  - [x] 6.3.2 Add CSS styles for task node statuses: not_started (gray), in_progress (blue), completed (green), failed (red)
  - [x] 6.3.3 Implement task panel JS in `renderer/app.js`: render task graph, listen for status events, update node visuals
  - [x] 6.3.4 Implement task detail view: on node click, show output, agent type, and execution duration
- [x] 6.4 Add Background Tasks Panel to renderer
  - [x] 6.4.1 Create background tasks panel HTML with task list, status indicators, and elapsed time
  - [x] 6.4.2 Implement background panel JS: list tasks, show progress, handle cancel button
  - [x] 6.4.3 Implement background task output viewer for reviewing completed task results
- [x] 6.5 Add Spec Workflow Panel to renderer
  - [x] 6.5.1 Create spec workflow panel HTML with phase indicator and navigation controls
  - [x] 6.5.2 Implement spec panel JS: show current phase, advance phase button, display artifacts
- [x] 6.6 Add search engine status to setup panel
  - [x] 6.6.1 Add "Search Engine" field to the setup panel showing current backend (ast-grep/ripgrep/builtin) and version
  - [x] 6.6.2 Show installation instructions link when ast-grep is not available
- [x] 6.7 Write smoke tests for IPC integration
  - [x] 6.7.1 Verify all new IPC channels are exposed in preload.js
  - [x] 6.7.2 Verify AST search tool is registered in Agent Pool for code-search and implementation types

## Task 7: Integration Testing and Wiring

- [x] 7.1 Wire all modules together in `main.js`
  - [x] 7.1.1 Initialize AgentPool with default subagent types (code-search, requirements, design, implementation, general)
  - [x] 7.1.2 Initialize Orchestrator factory that creates orchestrator instances per task graph execution
  - [x] 7.1.3 Register AST search as a tool available to code-search and implementation subagent types
  - [x] 7.1.4 Initialize SpecWorkflow module with project directory
- [x] 7.2 Write integration tests
  - [x] 7.2.1 Test full IPC round-trip: renderer → main → module → main → renderer for each channel
  - [x] 7.2.2 Test Orchestrator + AgentPool: execute a small task graph with mock QwenBridge, verify all status events
  - [x] 7.2.3 Test background task: spawn worker, verify events buffered, results persisted to session
  - [x] 7.2.4 Test spec workflow end-to-end: init spec, advance through phases, verify artifacts created
- [x] 7.3 Update `package.json` with new dependencies
  - [x] 7.3.1 Add `fast-check` as devDependency
  - [x] 7.3.2 Add test script to package.json (e.g., `"test": "node --test"` or jest/vitest configuration)

## Task 8: Multi-Instance QwenBridge Refactor

- [x] 8.1 Refactor `qwen-bridge.js` to use EventSink interface instead of direct BrowserWindow reference
  - [x] 8.1.1 Create `WindowSink` class that wraps BrowserWindow.webContents.send (existing behavior)
  - [x] 8.1.2 Create `CallbackSink` class that routes events through an EventEmitter with a taskId prefix
  - [x] 8.1.3 Create `WorkerSink` class that sends events via worker_thread MessagePort
  - [x] 8.1.4 Change QwenBridge constructor to accept an EventSink instead of BrowserWindow
  - [x] 8.1.5 Update QwenBridge.send() to use `this.sink.send()` instead of `this.win.webContents.send()`
- [x] 8.2 Update `main.js` to create QwenBridge with WindowSink for the main agent
  - [x] 8.2.1 Replace `new QwenBridge(mainWindow)` with `new QwenBridge(new WindowSink(mainWindow))`
- [x] 8.3 Update QwenBridge.close() to clean up Playwright browsers per-instance
  - [x] 8.3.1 Track Playwright server per QwenBridge instance instead of global singleton
  - [x] 8.3.2 On interrupt/close, only close the instance's own Playwright browser
- [x] 8.4 Write unit tests for multi-instance QwenBridge
  - [x] 8.4.1 Test WindowSink routes events to BrowserWindow mock
  - [x] 8.4.2 Test CallbackSink routes events through EventEmitter with correct taskId
  - [x] 8.4.3 Test WorkerSink routes events through MessagePort mock
  - [x] 8.4.4 Test two QwenBridge instances can run concurrently with independent sinks

## Task 9: UI Navigation and Activity Bar

- [x] 9.1 Add new activity bar buttons to `renderer/index.html`
  - [x] 9.1.1 Add "Tasks" button (📋) with `data-panel="tasks"` after the Git button
  - [x] 9.1.2 Add "Specs" button (📐) with `data-panel="specs"` after the Tasks button
- [x] 9.2 Add Task Graph side panel to `renderer/index.html`
  - [x] 9.2.1 Create `<div class="side-panel" id="sp-tasks">` with task list container, execution controls (Run, Pause, Resume, Abort), and status indicator
  - [x] 9.2.2 Add empty state: "No task graph loaded. Open a Tasks.md file or start a spec workflow."
  - [x] 9.2.3 Add "Open Tasks.md" button that triggers file picker filtered to *.md
- [x] 9.3 Add Spec Workflow side panel to `renderer/index.html`
  - [x] 9.3.1 Create `<div class="side-panel" id="sp-specs">` with phase indicator (requirements → design → tasks → implementation), artifact links, and advance button
  - [x] 9.3.2 Add empty state: "No spec active. Type /spec <name> or click New Spec."
  - [x] 9.3.3 Add "New Spec" button with feature name input field
- [x] 9.4 Add "Background" tab to editor tabs in `renderer/index.html`
  - [x] 9.4.1 Add `<button class="ed-tab" data-tab="background">⚡ Background</button>` after the Vision tab
  - [x] 9.4.2 Create `<div class="main-panel" id="mt-background">` with background task list, cancel buttons, and output viewer
- [x] 9.5 Add CSS styles for new panels in `renderer/style.css`
  - [x] 9.5.1 Task node status colors: not_started (#666), in_progress (#4fc3f7), completed (#66bb6a), failed (#ef5350)
  - [x] 9.5.2 Spec phase indicator styles: completed phases green, current phase blue, future phases gray
  - [x] 9.5.3 Background task card styles with elapsed time counter and progress indicator
- [x] 9.6 Implement panel JS logic in `renderer/app.js`
  - [x] 9.6.1 Implement `showPanel('tasks', btn)` handler — load and render task graph from current project's Tasks.md
  - [x] 9.6.2 Implement `showPanel('specs', btn)` handler — load and render current spec phase and artifacts
  - [x] 9.6.3 Implement `switchMainTab('background', btn)` handler — load and render background task list
  - [x] 9.6.4 Wire execution control buttons (Run/Pause/Resume/Abort) to task graph IPC channels
  - [x] 9.6.5 Wire spec advance button and new spec form to spec workflow IPC channels
  - [x] 9.6.6 Wire background task cancel buttons and output viewer to background task IPC channels
  - [x] 9.6.7 Listen for `task-status-event` and `bg-task-event` to update panels in real time

## Task 10: Slash Command System

- [x] 10.1 Implement slash command parser in `renderer/app.js`
  - [x] 10.1.1 Create `parseSlashCommand(input)` function — returns `{ command, args }` or null if not a slash command
  - [x] 10.1.2 Create `SLASH_COMMANDS` Map with registered command handlers
- [x] 10.2 Implement `/spec` command handler
  - [x] 10.2.1 `/spec <name>` — call `window.app.specInit(name)`, switch to specs panel, show confirmation
  - [x] 10.2.2 `/spec` (no args) — call `window.app.specPhase()`, display current phase in chat
- [x] 10.3 Implement `/search` command handler
  - [x] 10.3.1 `/search <pattern>` — call `window.app.astSearch({ pattern }, currentProject)`, render results inline in chat output
  - [x] 10.3.2 Format results as clickable file links that open in the editor tab
- [x] 10.4 Implement `/tasks` command handler
  - [x] 10.4.1 `/tasks` — switch to tasks panel, display current graph status in chat
  - [x] 10.4.2 `/tasks run` — call `window.app.taskGraphExecute()`, show execution started message
  - [x] 10.4.3 `/tasks pause` / `/tasks resume` — call corresponding IPC channels
- [x] 10.5 Implement `/bg` command handler
  - [x] 10.5.1 `/bg` or `/bg list` — call `window.app.bgTaskList()`, display task list in chat
  - [x] 10.5.2 `/bg cancel <id>` — call `window.app.bgTaskCancel(id)`, show confirmation
- [x] 10.6 Implement `/help` command handler
  - [x] 10.6.1 Display all available commands with descriptions in chat output
- [x] 10.7 Integrate slash command parser into `sendAgent()` function
  - [x] 10.7.1 Before sending to the agent, check if input starts with `/` and route to `parseSlashCommand`
  - [x] 10.7.2 If command is recognized, execute handler and don't send to agent
  - [x] 10.7.3 If command is unrecognized, show help message
- [x] 10.8 Add autocomplete dropdown for slash commands
  - [x] 10.8.1 When user types `/` in the chat input, show a dropdown with available commands
  - [x] 10.8.2 Filter dropdown as user types more characters
  - [x] 10.8.3 On selection, insert command text and focus input for args
