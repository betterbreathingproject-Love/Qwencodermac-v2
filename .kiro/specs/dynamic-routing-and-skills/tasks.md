# Implementation Plan: Dynamic Routing and Skills

## Overview

This plan implements two capabilities: (1) Dynamic Branch Routing — adding `parseRoutingDecision`, `validateRoutingDecision`, and `_applyRoutingDecision` to the orchestrator so branch points can follow structured agent output, and (2) Auto-Generating Steering Docs — a `steering-generator.js` module, a `steering-loader.js` module, steering doc injection into agent system prompts, and IPC handlers for triggering generation. All code is JavaScript using Node.js built-in test runner with fast-check for property-based tests.

## Tasks

- [x] 1. Implement routing decision parser and validator in orchestrator
  - [x] 1.1 Add `parseRoutingDecision(agentOutput)` function to `orchestrator.js`
    - Search agent output for JSON objects containing a `route` key using regex to find `{...}` blocks
    - Attempt `JSON.parse` on each candidate, return first valid object with a `route` property
    - Return `null` if no valid routing decision found (malformed JSON, missing `route`, empty string)
    - Support `route` as a single string or array of strings, and optional `reason` field
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 4.1, 4.5_

  - [x] 1.2 Add `validateRoutingDecision(decision, graph)` function to `orchestrator.js`
    - Validate that `route` is non-empty (not empty string, not empty array)
    - If `route` is a string, check it exists in `graph.nodes`
    - If `route` is an array, check every element exists in `graph.nodes`
    - Return `{ valid: true, errors: [] }` or `{ valid: false, errors: [...] }` with descriptive messages
    - _Requirements: 2.3, 4.2, 4.3, 4.4_

  - [x] 1.3 Write property tests for routing decision parsing (`test/routing-decision.property.test.js`)
    - **Property 1: Routing decision extraction from embedded text**
    - **Validates: Requirements 1.1, 1.2, 4.1**

  - [x] 1.4 Write property tests for invalid input handling
    - **Property 2: Invalid input yields null**
    - **Validates: Requirements 1.4, 4.5**

  - [x] 1.5 Write property tests for route validation
    - **Property 3: Route validation accepts existing IDs and rejects missing IDs**
    - **Validates: Requirements 2.3, 4.2, 4.3, 4.4**

  - [x] 1.6 Write unit tests for routing decision parser and validator (`test/routing-decision.test.js`)
    - Test parsing clean JSON, JSON embedded in markdown, JSON with `reason` field
    - Test validation with existing IDs, non-existent IDs, empty string, empty array
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 2. Refactor orchestrator branch handling to use routing decisions
  - [x] 2.1 Add `_getRoutableSiblings(branchNode)` method to `Orchestrator`
    - Return sibling task IDs (same parent, same depth) that come after the branch node, plus direct children
    - _Requirements: 3.2_

  - [x] 2.2 Add `_applyRoutingDecision(branchNode, decision)` method to `Orchestrator`
    - For single route string: mark target as `not_started`, skip non-selected siblings
    - For array route (fan-out): mark all targets as `not_started`, skip non-selected siblings
    - For retry (routing to a completed task): reset target to `not_started`
    - _Requirements: 2.1, 2.2, 2.4, 2.5_

  - [x] 2.3 Refactor `_handleBranch(node)` in `Orchestrator`
    - Dispatch branch node to agent pool instead of evaluating condition directly
    - Parse agent output with `parseRoutingDecision()`
    - If valid: store reason in `_context`, apply routing decision, mark branch as completed
    - If invalid/missing: fall back to existing `_evaluateCondition` logic
    - On dispatch failure: mark branch as failed, pause orchestrator
    - _Requirements: 1.1, 1.3, 1.4, 2.6_

  - [x] 2.4 Write property tests for route application
    - **Property 4: Route application activates all target tasks**
    - **Validates: Requirements 2.1, 2.2, 2.4**

  - [x] 2.5 Write property tests for sibling skipping
    - **Property 5: Non-selected siblings are skipped**
    - **Validates: Requirements 2.5**

  - [x] 2.6 Write unit tests for branch handling refactor
    - Test single route dispatch, fan-out dispatch, retry pattern, fallback to condition evaluation
    - Test branch failure handling and orchestrator pause
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 3. Checkpoint — Ensure all routing tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement agent prompt augmentation for branch points
  - [x] 4.1 Extend agent factory in `main.js` to detect branch point tasks
    - Check if task has `markers.branch` set
    - Get routable sibling/child task IDs via `_getRoutableSiblings`
    - Append routing instruction block to system prompt with RoutingDecision JSON format, valid task IDs, and example JSON
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 4.2 Write property tests for routing instructions
    - **Property 6: Routing instructions contain all routable task IDs**
    - **Validates: Requirements 3.2**

  - [x] 4.3 Write unit tests for branch point prompt augmentation
    - Test that branch point prompt includes example JSON and valid task IDs
    - Test that non-branch tasks do not get routing instructions
    - _Requirements: 3.1, 3.2, 3.3_

- [x] 5. Implement steering doc format and loader
  - [x] 5.1 Create `steering-loader.js` with `parseSteeringDoc(content)` and `printSteeringDoc(frontMatter, body)`
    - Parse YAML front matter delimited by `---` lines, extracting `name`, `description`, `auto_generated` fields
    - Serialize back to YAML front matter + markdown body format
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 5.2 Add `loadSteeringDocs(projectDir)` to `steering-loader.js`
    - Read all `.md` files from `.maccoder/steering/` directory
    - Parse front matter from each, return array of SteeringDoc objects
    - Return empty array if directory doesn't exist or files have malformed front matter (skip bad files, log warning)
    - _Requirements: 7.1_

  - [x] 5.3 Add `formatSteeringForPrompt(docs)` to `steering-loader.js`
    - Format loaded docs into a string with `## Project Context` header
    - Each doc gets a `### <name>` sub-header followed by its body
    - Return empty string for empty array input
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 5.4 Write property tests for steering doc round-trip (`test/steering-doc.property.test.js`)
    - **Property 7: Steering doc serialization round-trip**
    - **Validates: Requirements 6.4**

  - [x] 5.5 Write property tests for prompt injection completeness
    - **Property 8: Steering doc prompt injection completeness**
    - **Validates: Requirements 7.1, 7.2**

  - [x] 5.6 Write unit tests for steering doc parsing and formatting (`test/steering-doc.test.js`)
    - Test parsing valid YAML front matter, missing fields, empty array formatting, single doc formatting
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3_

- [x] 6. Implement steering doc injection into agent system prompts
  - [x] 6.1 Extend agent factory in `main.js` to inject steering docs
    - Load steering docs via `loadSteeringDocs(currentProject)` when creating agents
    - Append formatted steering content after base system prompt and before task-specific instructions
    - Skip injection when no steering docs exist (no empty `## Project Context` section)
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 6.2 Write unit tests for steering doc injection
    - Test injection order (after base prompt, before routing instructions)
    - Test no injection when no docs exist
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 7. Checkpoint — Ensure all steering loader and injection tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement steering doc generator
  - [x] 8.1 Create `steering-generator.js` with `generateSteeringDocs(projectDir, agentPool)`
    - Dispatch an explore-type agent to analyze project files (package.json, config files, entry points, directory structure)
    - Parse agent output to extract project context
    - Generate `project-overview.md` steering doc (always)
    - Generate framework-specific doc if recognizable framework detected (React, Express, Electron, etc.)
    - Generate `tooling.md` if tool config files found (ESLint, Prettier, TypeScript, test config)
    - Write files to `.maccoder/steering/` with proper YAML front matter (`auto_generated: true`)
    - Overwrite existing docs on regeneration
    - Return `SteeringResult` with `docsGenerated` and `errors` arrays
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3_

  - [x] 8.2 Write unit tests for steering generator (`test/steering-generator.test.js`)
    - Test generation for mock project with package.json → project-overview.md created
    - Test Electron project → framework doc created
    - Test ESLint config → tooling.md created
    - Test regeneration overwrites existing docs
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 9. Implement IPC handlers for steering generation
  - [x] 9.1 Add `steering-generate` and `steering-status` IPC handlers in `main/ipc-tasks.js`
    - `steering-generate`: accept `{ projectDir }`, invoke `generateSteeringDocs`, emit `steering-progress` events, return `{ ok: true }` or `{ error }`
    - `steering-status`: return whether steering docs exist for the current project
    - _Requirements: 8.2, 8.3, 8.4_

  - [x] 9.2 Add first-time project open prompt logic
    - When user opens a project and no `.maccoder/steering/` directory exists, emit an event to prompt the user to generate steering docs
    - _Requirements: 8.1_

  - [x] 9.3 Write unit tests for steering IPC handlers
    - Test `steering-generate` handler invokes generator and returns result
    - Test progress events emitted during generation
    - _Requirements: 8.2, 8.3, 8.4_

- [x] 10. Integration wiring and final verification
  - [x] 10.1 Wire all new modules together
    - Ensure `orchestrator.js` exports `parseRoutingDecision` and `validateRoutingDecision`
    - Ensure `steering-loader.js` and `steering-generator.js` are required in `main.js` and `main/ipc-tasks.js`
    - Verify agent factory uses both steering injection and routing instructions in correct order
    - _Requirements: 7.4, 3.1_

  - [x] 10.2 Write integration tests
    - Test end-to-end: orchestrator executes task graph with branch point, agent returns RoutingDecision, correct path followed
    - Test IPC `steering-generate` handler invokes generator and returns result
    - _Requirements: 1.1, 2.1, 2.2, 8.2_

- [x] 11. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses `node --test` runner with `fast-check` for property-based testing
