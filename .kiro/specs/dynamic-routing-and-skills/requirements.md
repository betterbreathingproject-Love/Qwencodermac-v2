# Requirements Document

## Introduction

This feature adds two capabilities to the QwenCoder Mac Studio IDE: (1) Dynamic Branch Routing, which upgrades the orchestrator to evaluate structured routing decisions returned by agents at branch points, enabling conditional workflows, retry loops, and parallel fan-out patterns; and (2) an Auto-Generating Steering Docs system, where the AI analyzes the project codebase and automatically generates `.maccoder/steering/*.md` context documents that get injected into agent system prompts. Instead of manually writing skill files, the agent explores the project (tech stack, conventions, key patterns, tool usage) and produces steering docs that keep all future agent runs grounded in project-specific context.

## Glossary

- **Orchestrator**: The `Orchestrator` class in `orchestrator.js` that executes a task graph by dispatching tasks to agents and managing state transitions.
- **Task_Graph**: The parsed representation of a `tasks.md` file, consisting of `TaskNode` objects with dependencies, markers, and status.
- **Branch_Point**: A `TaskNode` whose bracket content contains the `?branch:<condition>` marker, indicating a conditional routing decision.
- **Routing_Decision**: A structured JSON object returned by an agent upon completing a branch point task, containing a `route` field that specifies which task ID(s) to activate next.
- **Agent_Pool**: The `AgentPool` class in `agent-pool.js` that selects subagent types and dispatches tasks with concurrency control.
- **Direct_Bridge**: The `DirectBridge` class in `direct-bridge.js` that runs prompts against the local MLX model server with tool calling support.
- **Steering_Doc**: A Markdown file stored at `.maccoder/steering/<name>.md` that contains auto-generated project-specific context for agents (tech stack, conventions, patterns, tool usage).
- **Steering_Generator**: The module responsible for analyzing the project codebase and producing Steering_Doc files automatically via the AI.
- **System_Prompt**: The instruction text prepended to agent conversations that defines the agent's role, available tools, and behavioral guidelines.
- **Fan_Out**: A routing pattern where a single branch point activates multiple downstream tasks for parallel execution.
- **Agent_Factory**: The function in `main.js` that creates agent instances with specialized system prompts for each subagent type.
- **Project_Context**: The collected information about a project's tech stack, file structure, conventions, and patterns used to generate Steering_Docs.

## Requirements

### Requirement 1: Structured Routing Decision Format

**User Story:** As a workflow author, I want branch point tasks to produce structured routing decisions, so that the orchestrator can follow conditional paths through the task graph.

#### Acceptance Criteria

1. WHEN an agent completes a branch point task, THE Orchestrator SHALL parse the agent output for a Routing_Decision JSON object containing a `route` field.
2. THE Routing_Decision SHALL support a `route` field that is either a single task ID string or an array of task ID strings for fan-out.
3. WHEN the Routing_Decision contains a `reason` field, THE Orchestrator SHALL store the reason string in the execution context for that branch point node.
4. IF the agent output for a branch point task does not contain a valid Routing_Decision, THEN THE Orchestrator SHALL fall back to the existing `_evaluateCondition` logic using the branch marker condition string.
5. THE Routing_Decision format SHALL be: `{"route": "<taskId>" | ["<taskId>", ...], "reason": "<optional explanation>"}`.

### Requirement 2: Orchestrator Branch Routing Execution

**User Story:** As a workflow author, I want the orchestrator to follow routing decisions at branch points, so that my task graphs can have conditional paths, retries, and parallel fan-out.

#### Acceptance Criteria

1. WHEN a Routing_Decision specifies a single task ID, THE Orchestrator SHALL mark that target task as `not_started` (if previously skipped or completed) and add it to the next execution set.
2. WHEN a Routing_Decision specifies an array of task IDs, THE Orchestrator SHALL mark all specified target tasks as `not_started` and dispatch them concurrently (fan-out).
3. WHEN a Routing_Decision routes to a task ID that does not exist in the Task_Graph, THE Orchestrator SHALL emit a `task-error` event with a descriptive message and mark the branch point as `failed`.
4. WHEN a Routing_Decision routes to a previously completed task, THE Orchestrator SHALL reset that task to `not_started` and re-execute it (retry pattern).
5. WHILE the Orchestrator is in `running` state, THE Orchestrator SHALL skip all sibling tasks that were not selected by the Routing_Decision at a branch point by marking them as `skipped`.
6. WHEN a branch point task completes with a valid Routing_Decision, THE Orchestrator SHALL mark the branch point node as `completed`.

### Requirement 3: Agent Branch Point Prompt Augmentation

**User Story:** As a workflow author, I want agents running branch point tasks to know they must return a routing decision, so that the orchestrator receives structured output it can parse.

#### Acceptance Criteria

1. WHEN the Agent_Factory creates an agent for a branch point task, THE Agent_Factory SHALL append routing instructions to the system prompt explaining the Routing_Decision JSON format.
2. THE routing instructions SHALL include the list of valid downstream task IDs that the branch point can route to (derived from the branch point node's sibling and child tasks in the Task_Graph).
3. WHEN the routing instructions are appended, THE Agent_Factory SHALL include an example Routing_Decision JSON in the prompt.

### Requirement 4: Routing Decision Parsing and Validation

**User Story:** As a workflow author, I want the orchestrator to robustly parse routing decisions from agent output, so that minor formatting variations do not break conditional workflows.

#### Acceptance Criteria

1. THE Orchestrator SHALL extract a Routing_Decision from agent output by searching for a JSON object containing a `route` key, even if the JSON is embedded within surrounding text.
2. WHEN the `route` field contains a task ID string, THE Orchestrator SHALL validate that the task ID exists in the Task_Graph before acting on it.
3. WHEN the `route` field contains an array, THE Orchestrator SHALL validate that every task ID in the array exists in the Task_Graph.
4. IF the `route` field is an empty string or an empty array, THEN THE Orchestrator SHALL treat the Routing_Decision as invalid and fall back to the existing condition evaluation.
5. THE Orchestrator SHALL parse the Routing_Decision using `JSON.parse` and handle parse errors gracefully by falling back to the existing condition evaluation.

### Requirement 5: Steering Doc Auto-Generation

**User Story:** As a developer, I want the AI to automatically analyze my project and generate steering docs, so that all agents get project-specific context without me writing guidance files manually.

#### Acceptance Criteria

1. WHEN the Steering_Generator is invoked for a project directory, THE Steering_Generator SHALL use an explore-type agent to read key project files (package.json, config files, entry points, directory structure).
2. THE Steering_Generator SHALL produce one or more Steering_Doc files in the `.maccoder/steering/` directory based on the analysis.
3. THE Steering_Generator SHALL generate a `project-overview.md` Steering_Doc containing the tech stack, project structure summary, and key entry points.
4. WHEN the project contains recognizable framework patterns (React, Express, Electron, etc.), THE Steering_Generator SHALL generate a framework-specific Steering_Doc with conventions and best practices relevant to that project.
5. WHEN the project contains tool configuration files (ESLint, Prettier, TypeScript config, test config), THE Steering_Generator SHALL generate a `tooling.md` Steering_Doc summarizing the configured tools and how agents should respect those configurations.
6. IF the `.maccoder/steering/` directory already contains Steering_Docs, THEN THE Steering_Generator SHALL overwrite existing docs with updated content (regeneration replaces stale context).

### Requirement 6: Steering Doc Format and Structure

**User Story:** As a developer, I want steering docs to have a consistent format, so that they are predictable and easy to review or manually edit after generation.

#### Acceptance Criteria

1. THE Steering_Doc SHALL begin with a YAML front matter block delimited by `---` lines containing `name` (string), `description` (string), and `auto_generated` (boolean) fields.
2. THE Steering_Doc body SHALL be Markdown text organized with headings that describe specific aspects of the project context.
3. THE Steering_Doc `auto_generated` field SHALL be set to `true` when produced by the Steering_Generator.
4. FOR ALL valid Steering_Doc objects, parsing the front matter and body then printing them back SHALL produce content that re-parses to an equivalent Steering_Doc object (round-trip property).

### Requirement 7: Steering Doc Injection into Agent System Prompts

**User Story:** As a developer, I want steering docs to be automatically injected into agent system prompts, so that every agent run benefits from project-specific context.

#### Acceptance Criteria

1. WHEN the Agent_Factory creates an agent and Steering_Docs exist in `.maccoder/steering/`, THE Agent_Factory SHALL load all Steering_Doc files and append their content to the system prompt under a `## Project Context` section.
2. THE Agent_Factory SHALL separate each injected Steering_Doc with a header containing the doc name (e.g., `### project-overview`).
3. WHEN no Steering_Docs exist for the current project, THE Agent_Factory SHALL not modify the system prompt (no empty project context section).
4. THE Agent_Factory SHALL inject Steering_Docs after the base system prompt and before any task-specific instructions (such as routing instructions for branch points).

### Requirement 8: Steering Doc Generation Trigger

**User Story:** As a developer, I want to trigger steering doc generation easily, so that I can refresh project context whenever my project changes significantly.

#### Acceptance Criteria

1. WHEN the user opens a project for the first time and no `.maccoder/steering/` directory exists, THE System SHALL prompt the user to generate steering docs.
2. WHEN the user triggers a "Regenerate Steering Docs" action via IPC, THE Steering_Generator SHALL re-analyze the project and overwrite existing Steering_Docs.
3. THE System SHALL expose an IPC handler `steering-generate` that accepts a project directory path and returns a success or error result.
4. WHILE the Steering_Generator is running, THE System SHALL emit progress events so the renderer can display generation status.
