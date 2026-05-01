# Requirements Document

## Introduction

This feature integrates key capabilities from the oh-my-maccoder project into the existing QwenCoder Mac Studio Electron app. The integration brings dynamic task graph execution, multi-agent/subagent architecture, background (parallel) task execution, AST-based code search, and a spec-driven development workflow. These capabilities transform the app from a single-agent chat tool into a structured, multi-agent coding environment that can plan, decompose, and execute complex development tasks.

## Glossary

- **Task_Graph**: A directed graph of tasks parsed from a Tasks.md file, supporting sequential execution, branching (`?branch`), terminal nodes (`$terminal`), start markers (`^start`), loops, and parallel execution paths.
- **Task_Node**: A single node in the Task_Graph representing one unit of work with a status (not_started, in_progress, completed, skipped), dependencies, and optional branch/loop metadata.
- **Subagent**: A specialized agent instance that runs with a focused system prompt and tool set, spawned by the Orchestrator to handle a specific type of task (e.g., code search, requirements gathering, task execution).
- **Orchestrator**: The top-level agent coordinator that parses the Task_Graph, dispatches Task_Nodes to appropriate Subagents, tracks progress, and manages execution flow.
- **Background_Task**: A Subagent execution that runs in a separate process/worker without blocking the main conversation thread, reporting results asynchronously.
- **AST_Search_Engine**: A code search module that uses abstract syntax tree parsing (via ast-grep or tree-sitter) to find and match structural code patterns rather than plain text.
- **Spec_Workflow**: A structured development process consisting of phases: Requirements gathering, Design creation, Task decomposition, and Implementation — each producing a markdown artifact.
- **QwenBridge**: The existing class in qwen-bridge.js that wraps @qwen-code/sdk to run agent queries with tool use and streaming events.
- **Agent_Pool**: A managed collection of Subagent instances with concurrency limits, lifecycle management, and event routing.
- **Task_Status_Event**: An IPC event emitted when a Task_Node changes status, used to update the UI task panel in real time.

## Requirements

### Requirement 1: Task Graph Parser

**User Story:** As a developer, I want the app to parse Tasks.md files into an executable task graph, so that complex multi-step development plans can be automatically executed with branching, looping, and parallel paths.

#### Acceptance Criteria

1. WHEN a Tasks.md file is provided, THE Task_Graph_Parser SHALL parse it into a Task_Graph data structure containing Task_Nodes with their dependencies, statuses, and metadata.
2. WHEN a Task_Node is marked with `^start`, THE Task_Graph_Parser SHALL designate it as the entry point of the Task_Graph.
3. WHEN a Task_Node is marked with `?branch`, THE Task_Graph_Parser SHALL create conditional branch edges that the Orchestrator evaluates at runtime.
4. WHEN a Task_Node is marked with `$terminal`, THE Task_Graph_Parser SHALL designate it as a terminal node that ends its execution path.
5. WHEN multiple Task_Nodes at the same nesting level have no dependencies on each other, THE Task_Graph_Parser SHALL mark them as parallelizable.
6. WHEN a Task_Node contains loop syntax, THE Task_Graph_Parser SHALL create a loop edge back to the specified target node with an iteration counter.
7. IF the Tasks.md file contains syntax errors, THEN THE Task_Graph_Parser SHALL return a descriptive error identifying the line and nature of the problem.
8. THE Task_Graph_Printer SHALL format a Task_Graph data structure back into a valid Tasks.md file preserving all markers and indentation.
9. FOR ALL valid Task_Graph structures, parsing then printing then parsing SHALL produce an equivalent Task_Graph (round-trip property).

### Requirement 2: Task Graph Executor

**User Story:** As a developer, I want the Orchestrator to execute task graphs step by step, so that I can run complex development plans with automatic dependency resolution and progress tracking.

#### Acceptance Criteria

1. WHEN execution begins, THE Orchestrator SHALL start from the `^start` node and traverse the Task_Graph respecting dependency order.
2. WHILE a Task_Node is being executed, THE Orchestrator SHALL set its status to `in_progress` and emit a Task_Status_Event.
3. WHEN a Task_Node completes, THE Orchestrator SHALL set its status to `completed`, emit a Task_Status_Event, and advance to the next eligible node.
4. WHEN a `?branch` node is reached, THE Orchestrator SHALL evaluate the branch condition and follow the matching edge.
5. WHEN parallel Task_Nodes are eligible, THE Orchestrator SHALL dispatch them concurrently to the Agent_Pool.
6. WHEN a loop edge is encountered, THE Orchestrator SHALL re-execute the target node up to the specified iteration limit.
7. IF a Task_Node execution fails, THEN THE Orchestrator SHALL mark it as failed, emit a Task_Status_Event, and pause execution awaiting user decision (retry, skip, or abort).
8. WHEN execution completes or is paused, THE Orchestrator SHALL persist the current Task_Graph state to the Tasks.md file with updated statuses.

### Requirement 3: Multi-Agent Subagent Architecture

**User Story:** As a developer, I want specialized subagents for different task types, so that code search, requirements gathering, and implementation tasks each get optimized prompts and tool sets.

#### Acceptance Criteria

1. THE Agent_Pool SHALL support registering Subagent types with distinct system prompts, allowed tools, and concurrency limits.
2. WHEN the Orchestrator dispatches a Task_Node, THE Agent_Pool SHALL select the appropriate Subagent type based on the task category (code-search, requirements, design, implementation, general).
3. WHEN a Subagent is spawned, THE Agent_Pool SHALL provide it with the task context, working directory, and a scoped set of tools.
4. WHEN a Subagent completes its task, THE Agent_Pool SHALL return the result to the Orchestrator and release the Subagent resources.
5. IF a Subagent exceeds its timeout, THEN THE Agent_Pool SHALL terminate the Subagent and report a timeout error to the Orchestrator.
6. WHILE a Subagent is running, THE Agent_Pool SHALL forward its streaming events (text-delta, tool-use, tool-result) to the renderer via IPC for live display.
7. THE Agent_Pool SHALL enforce a configurable maximum concurrency limit for simultaneous Subagent executions.

### Requirement 4: Background Task Execution

**User Story:** As a developer, I want to run subagent tasks in the background without blocking my main chat, so that I can continue working while long-running tasks complete in parallel.

#### Acceptance Criteria

1. WHEN the user requests a background task, THE Orchestrator SHALL spawn the Subagent in a separate worker process and return control to the main conversation immediately.
2. WHILE a Background_Task is running, THE Orchestrator SHALL display a status indicator in the UI showing the task name and elapsed time.
3. WHEN a Background_Task completes, THE Orchestrator SHALL notify the user with a summary of the result and make the full output available for review.
4. WHEN a Background_Task emits streaming events, THE Orchestrator SHALL buffer them and make them available in a dedicated background task panel.
5. IF the user requests cancellation of a Background_Task, THEN THE Orchestrator SHALL terminate the worker process and mark the task as cancelled.
6. THE Orchestrator SHALL persist Background_Task results to the session so they survive app restarts.
7. WHILE multiple Background_Tasks are running, THE Orchestrator SHALL display each one independently in the background task panel with individual progress indicators.

### Requirement 5: AST-Based Code Search

**User Story:** As a developer, I want structural code search using AST patterns, so that I can find code by structure (e.g., all async functions that call a specific API) rather than just text matching.

#### Acceptance Criteria

1. WHEN a structural search pattern is provided, THE AST_Search_Engine SHALL parse the pattern and match it against source files in the project directory.
2. THE AST_Search_Engine SHALL support patterns for function declarations, class definitions, method calls, import statements, and variable assignments.
3. WHEN matches are found, THE AST_Search_Engine SHALL return the file path, line range, and matched code snippet for each result.
4. THE AST_Search_Engine SHALL support JavaScript, TypeScript, Python, and JSON file types.
5. IF the search pattern is syntactically invalid, THEN THE AST_Search_Engine SHALL return a descriptive error explaining the expected pattern format.
6. WHEN the AST_Search_Engine is registered as a Subagent tool, THE Agent_Pool SHALL make it available to code-search and implementation Subagent types.
7. THE AST_Search_Engine SHALL complete searches of projects with up to 10,000 files within 10 seconds.

### Requirement 6: Spec-Driven Development Workflow

**User Story:** As a developer, I want a structured spec workflow (requirements → design → tasks → implementation), so that I can plan features systematically before coding.

#### Acceptance Criteria

1. WHEN the user initiates a spec workflow, THE Spec_Workflow SHALL create a `.maccoder/specs/{feature_name}/` directory with a config file.
2. WHEN the requirements phase begins, THE Spec_Workflow SHALL generate a requirements.md file following EARS patterns and INCOSE quality rules.
3. WHEN the design phase begins, THE Spec_Workflow SHALL generate a design.md file based on the approved requirements.
4. WHEN the tasks phase begins, THE Spec_Workflow SHALL generate a tasks.md file with a Task_Graph derived from the design.
5. WHEN the implementation phase begins, THE Orchestrator SHALL execute the Task_Graph, dispatching each task to the appropriate Subagent.
6. WHILE a spec workflow is active, THE Spec_Workflow SHALL track the current phase and allow the user to navigate between phases.
7. IF the user provides feedback on a spec artifact, THEN THE Spec_Workflow SHALL incorporate the feedback and regenerate the artifact.
8. THE Spec_Workflow SHALL persist all artifacts (requirements.md, design.md, tasks.md) in the project's spec directory.

### Requirement 7: IPC and UI Integration

**User Story:** As a developer, I want the task graph, subagent activity, and background tasks visible in the UI, so that I can monitor and control all agent activity from the app interface.

#### Acceptance Criteria

1. THE preload.js SHALL expose IPC channels for task graph operations (parse, execute, pause, resume, get-status).
2. THE preload.js SHALL expose IPC channels for background task management (list, cancel, get-output).
3. THE preload.js SHALL expose IPC channels for AST search (search, get-patterns).
4. THE preload.js SHALL expose IPC channels for spec workflow operations (init, get-phase, advance-phase).
5. WHEN a Task_Status_Event is received, THE renderer SHALL update the task panel to reflect the current node status with visual indicators (not_started, in_progress, completed, failed).
6. WHEN a Background_Task status changes, THE renderer SHALL update the background task panel with the current state and elapsed time.
7. WHEN the user clicks a task node in the task panel, THE renderer SHALL display the task details including its output, assigned Subagent type, and execution duration.

### Requirement 8: UI Navigation and Feature Discoverability

**User Story:** As a developer, I want activity bar buttons and tabs to access the new features, so that I can easily navigate to task graphs, background tasks, and spec workflows without hunting through the UI.

#### Acceptance Criteria

1. THE activity bar SHALL include a "Tasks" button (📋) that opens the Task Graph side panel showing the current task graph and execution controls.
2. THE activity bar SHALL include a "Specs" button (📐) that opens the Spec Workflow side panel showing the current spec phase and artifacts.
3. THE editor tabs SHALL include a "Background" tab that shows all running and completed background tasks with their status and output.
4. WHEN no task graph is loaded, THE Task Graph panel SHALL display a prompt to open or create a Tasks.md file.
5. WHEN no spec is active, THE Spec Workflow panel SHALL display a prompt to start a new spec with a feature name input.

### Requirement 9: Slash Commands

**User Story:** As a developer, I want to type slash commands in the chat input (e.g., `/spec`, `/search`, `/tasks`) to quickly trigger features, so that I can access functionality without navigating away from the chat.

#### Acceptance Criteria

1. WHEN the user types `/spec` followed by a feature name in the chat input, THE app SHALL initiate a new spec workflow for that feature and switch to the Spec Workflow panel.
2. WHEN the user types `/spec` without a feature name, THE app SHALL display the current spec status or prompt to start a new one.
3. WHEN the user types `/search` followed by a pattern, THE app SHALL execute an AST search in the current project and display results inline in the chat.
4. WHEN the user types `/tasks` in the chat input, THE app SHALL open the Task Graph panel and display the current task graph status.
5. WHEN the user types `/tasks run` in the chat input, THE app SHALL begin executing the current task graph.
6. WHEN the user types `/bg` in the chat input, THE app SHALL list all background tasks with their current status.
7. IF the user types an unrecognized slash command, THEN THE app SHALL display a help message listing all available commands.

### Requirement 10: Multi-Instance QwenBridge

**User Story:** As a developer, I want the agent pool to run multiple concurrent QwenBridge instances, so that parallel task execution and background tasks each get their own isolated agent session.

#### Acceptance Criteria

1. THE QwenBridge class SHALL support instantiation without a BrowserWindow reference, using an event callback pattern instead for headless/worker usage.
2. WHEN the Agent_Pool spawns a foreground subagent, THE QwenBridge instance SHALL forward events to the main window via the Agent_Pool's event emitter.
3. WHEN the Agent_Pool spawns a background subagent in a worker_thread, THE QwenBridge instance SHALL communicate via the worker's message port instead of IPC.
4. WHEN multiple QwenBridge instances are running concurrently, EACH instance SHALL maintain its own independent session state and tool context.
5. WHEN a QwenBridge instance is terminated (via interrupt or timeout), THE instance SHALL clean up all resources including any spawned Playwright browsers.

### Requirement 11: AST-grep Availability

**User Story:** As a developer, I want the app to handle ast-grep availability gracefully, so that AST search works out of the box or falls back cleanly when ast-grep is not installed.

#### Acceptance Criteria

1. WHEN the app starts, THE AST_Search_Engine SHALL check if `sg` (ast-grep CLI) is available on the system PATH.
2. IF `sg` is not found, THE AST_Search_Engine SHALL display a one-time notification in the setup panel with installation instructions for the user's platform.
3. IF `sg` is not found, THE AST_Search_Engine SHALL fall back to ripgrep (`rg`) for text-based pattern matching with a warning that results are text-based, not structural.
4. IF neither `sg` nor `rg` is found, THE AST_Search_Engine SHALL fall back to Node.js built-in `fs` recursive search with basic regex matching.
5. THE setup panel SHALL display the current AST search engine status (ast-grep, ripgrep, or built-in) under a "Search Engine" field.
