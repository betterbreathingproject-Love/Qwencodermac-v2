# Requirements Document

## Introduction

Adaptive Agent Calibration automatically benchmarks the loaded MLX model on startup and uses the resulting performance metrics to calculate optimal agent loop settings. Instead of hardcoded constants (maxTurns=50, timeout=600000ms, MAX_INPUT_TOKENS=24000), the system derives these values from actual model performance — generation TPS, prompt processing TPS, memory usage, and context window size. Combined with the existing compactor, this enables the agent to work indefinitely until the task is done, with turn limits serving only as a safety valve rather than a practical constraint. Settings are recalculated whenever a new model is loaded.

## Glossary

- **Calibrator**: The Node.js module (`calibrator.js`) that orchestrates benchmarking and computes adaptive settings
- **Benchmark_Endpoint**: The FastAPI endpoint (`/admin/benchmark`) on the MLX server that runs a short inference pass and returns performance metrics
- **Calibration_Profile**: A plain JavaScript object containing all computed settings for a given model (maxTurns, timeoutPerTurn, maxInputTokens, compactionThreshold, contextBudget)
- **Agent_Loop**: The `_agentLoop` method in `DirectBridge` that iterates tool-use turns with the model
- **Agent_Pool**: The `AgentPool` class that dispatches tasks to agents with timeout and concurrency controls
- **Compactor**: The context compression system (`compactor.js` / `compactor-bridge.py`) that compresses messages when they exceed a token threshold
- **Metal_Memory**: Apple Silicon unified GPU/CPU memory managed by the MLX framework
- **Generation_TPS**: Tokens per second during output generation (decoding)
- **Prompt_TPS**: Tokens per second during prompt processing (prefill)
- **Context_Window**: The maximum number of tokens the loaded model supports as input
- **IPC_Server**: The Electron main-process module (`main/ipc-server.js`) that manages the MLX server lifecycle and model loading

## Requirements

### Requirement 1: Model Benchmarking Endpoint

**User Story:** As a developer, I want the MLX server to expose a benchmark endpoint, so that the Calibrator can obtain real performance metrics for the currently loaded model.

#### Acceptance Criteria

1. WHEN a POST request is sent to `/admin/benchmark`, THE Benchmark_Endpoint SHALL run a short inference pass using the loaded model and return a JSON object containing `generation_tps`, `prompt_tps`, `peak_memory_gb`, `available_memory_gb`, and `context_window` fields
2. WHEN no model is loaded, THE Benchmark_Endpoint SHALL return HTTP 503 with a descriptive error message
3. WHILE the benchmark inference is running, THE Benchmark_Endpoint SHALL use the existing inference semaphore to prevent concurrent inference requests from conflicting
4. THE Benchmark_Endpoint SHALL complete the benchmark pass within 15 seconds using a short fixed prompt (under 200 tokens) and a limited generation length (under 100 tokens)
5. WHEN the benchmark inference encounters a Metal memory error, THE Benchmark_Endpoint SHALL clear the Metal cache, run garbage collection, and return an error response with the current memory state

### Requirement 2: Calibration Profile Computation

**User Story:** As a developer, I want benchmark metrics to be automatically converted into a Calibration_Profile, so that all agent settings are derived from actual model performance rather than hardcoded constants.

#### Acceptance Criteria

1. WHEN benchmark metrics are available, THE Calibrator SHALL compute `timeoutPerTurn` as `(max_tokens / generation_tps) * 1000` milliseconds plus a fixed overhead of 30 seconds for tool execution, with a minimum floor of 60000 milliseconds
2. WHEN benchmark metrics are available, THE Calibrator SHALL compute `maxInputTokens` as `context_window * 0.6` clamped between 8000 and 200000 tokens, reserving the remaining context for generation output and safety margin
3. WHEN benchmark metrics are available, THE Calibrator SHALL compute `compactionThreshold` as `maxInputTokens * 0.85`, representing the token count at which the Compactor triggers compression
4. WHEN benchmark metrics are available, THE Calibrator SHALL set `maxTurns` to 500, serving as a safety valve rather than a practical limit
5. WHEN benchmark metrics are available, THE Calibrator SHALL compute `poolTimeout` as `timeoutPerTurn * 3` clamped to a minimum of 120000 milliseconds, representing the Agent_Pool dispatch timeout for a multi-turn task segment
6. THE Calibrator SHALL return a Calibration_Profile object containing all computed fields: `maxTurns`, `timeoutPerTurn`, `maxInputTokens`, `compactionThreshold`, `poolTimeout`, and the raw benchmark metrics that produced them
7. FOR ALL valid benchmark metrics, computing a Calibration_Profile and then recomputing from the same metrics SHALL produce an identical Calibration_Profile (deterministic computation, round-trip property)

### Requirement 3: Automatic Calibration on Model Load

**User Story:** As a developer, I want calibration to run automatically when a model is loaded, so that the agent is always tuned to the current model without manual intervention.

#### Acceptance Criteria

1. WHEN a model is successfully loaded via the `load-model` IPC handler, THE IPC_Server SHALL trigger a benchmark request to the Benchmark_Endpoint and pass the results to the Calibrator
2. WHEN calibration completes successfully, THE IPC_Server SHALL store the resulting Calibration_Profile and emit a `calibration-complete` event to the renderer with the profile data
3. IF the benchmark request fails or times out, THEN THE IPC_Server SHALL fall back to a default Calibration_Profile using conservative hardcoded values (maxTurns=50, timeoutPerTurn=120000, maxInputTokens=24000, compactionThreshold=20000, poolTimeout=600000)
4. WHEN a model is unloaded, THE IPC_Server SHALL clear the stored Calibration_Profile

### Requirement 4: Agent Loop Integration

**User Story:** As a developer, I want the Agent_Loop to use calibrated settings, so that turn limits, context budgets, and compaction thresholds adapt to the loaded model.

#### Acceptance Criteria

1. WHEN a Calibration_Profile is available, THE Agent_Loop SHALL use `maxTurns` from the profile instead of the hardcoded default of 50
2. WHEN a Calibration_Profile is available, THE Agent_Loop SHALL use `maxInputTokens` from the profile as the token threshold for triggering context compression instead of the hardcoded 24000
3. WHEN a Calibration_Profile is available, THE Agent_Loop SHALL use `compactionThreshold` from the profile as the trigger point passed to the Compactor
4. IF no Calibration_Profile is available, THEN THE Agent_Loop SHALL use the existing hardcoded defaults (maxTurns=50, MAX_INPUT_TOKENS=24000)
5. WHEN the Agent_Loop is within 5 turns of `maxTurns`, THE Agent_Loop SHALL inject a system message warning the model to wrap up, preserving the existing graceful-shutdown behavior

### Requirement 5: Agent Pool Timeout Integration

**User Story:** As a developer, I want the Agent_Pool to use calibrated timeouts, so that slow models get more time and fast models fail faster on genuine hangs.

#### Acceptance Criteria

1. WHEN a Calibration_Profile is available, THE Agent_Pool SHALL use `poolTimeout` from the profile as the default timeout for dispatched tasks instead of the hardcoded 600000 milliseconds
2. WHEN a task-specific timeout is provided via agent type configuration, THE Agent_Pool SHALL use the task-specific timeout rather than the calibrated `poolTimeout`
3. IF no Calibration_Profile is available, THEN THE Agent_Pool SHALL use the existing DEFAULT_TIMEOUT of 600000 milliseconds

### Requirement 6: Calibration Profile Retrieval

**User Story:** As a developer, I want to query the current calibration profile, so that the UI can display model performance data and the renderer can show adaptive settings.

#### Acceptance Criteria

1. WHEN a `get-calibration` IPC request is received, THE IPC_Server SHALL return the current Calibration_Profile or null if no profile is available
2. THE Calibration_Profile returned by the IPC handler SHALL include both the computed settings and the raw benchmark metrics that produced them
3. WHEN the `calibration-complete` event is emitted, THE event payload SHALL include the model identifier alongside the Calibration_Profile so the renderer can associate settings with the correct model

### Requirement 7: Calibration Profile Serialization

**User Story:** As a developer, I want calibration profiles to be serializable to JSON and back, so that profiles can be cached, logged, or transmitted via IPC without data loss.

#### Acceptance Criteria

1. THE Calibrator SHALL format all Calibration_Profile fields as JSON-safe types (numbers, strings, plain objects)
2. FOR ALL valid Calibration_Profiles, serializing to JSON and then parsing back SHALL produce an equivalent Calibration_Profile (round-trip property)
3. WHEN a Calibration_Profile contains benchmark metrics with floating-point values, THE Calibrator SHALL round `generation_tps` and `prompt_tps` to 2 decimal places and `peak_memory_gb` and `available_memory_gb` to 3 decimal places

### Requirement 8: Calibration Status Chip

**User Story:** As a developer, I want a status chip in the title bar showing the current calibration state, so that I can see at a glance whether calibration is active, complete, or unavailable.

#### Acceptance Criteria

1. THE Renderer SHALL display a calibration status chip in the `titlebar-status` area, following the same HTML structure as the existing LSP chip (a container span with a colored dot span and a text label span)
2. WHEN calibration is in progress, THE Calibration_Chip SHALL display an amber dot and the text "Calibrating"
3. WHEN calibration has completed successfully, THE Calibration_Chip SHALL display a green dot and the text "Calibrated"
4. WHEN no Calibration_Profile is available and no calibration is in progress, THE Calibration_Chip SHALL display a gray dot and the text "Uncalibrated"
5. WHEN the user clicks the Calibration_Chip, THE Renderer SHALL display a popover showing the current Calibration_Profile summary: model name, generation TPS, prompt TPS, computed maxTurns, timeoutPerTurn, and maxInputTokens
6. WHEN the `calibration-complete` event is received from the main process, THE Renderer SHALL update the Calibration_Chip to the "Calibrated" state and store the profile data for the popover
7. WHEN a model is unloaded, THE Renderer SHALL reset the Calibration_Chip to the "Uncalibrated" state

### Requirement 9: Calibration Dashboard Tab

**User Story:** As a developer, I want a dedicated tab in the main area showing calibration data, so that I can inspect benchmark results, computed settings, and model performance metrics in detail.

#### Acceptance Criteria

1. THE Renderer SHALL add a "Calibration" tab button to the editor tabs bar, following the same `ed-tab` pattern as the existing Agent, Editor, Vision, and Tools tabs
2. WHEN the Calibration tab is selected, THE Renderer SHALL display a main panel (`mt-calibration`) containing three sections: Benchmark Results, Computed Settings, and Model Info
3. WHEN a Calibration_Profile is available, THE Benchmark Results section SHALL display `generation_tps`, `prompt_tps`, `peak_memory_gb`, `available_memory_gb`, and `context_window` values from the raw benchmark metrics
4. WHEN a Calibration_Profile is available, THE Computed Settings section SHALL display `maxTurns`, `timeoutPerTurn`, `maxInputTokens`, `compactionThreshold`, and `poolTimeout` values with human-readable labels and units
5. WHEN no Calibration_Profile is available, THE Calibration tab panel SHALL display a placeholder message indicating that no calibration data is available and that loading a model will trigger calibration
6. WHEN the `calibration-complete` event is received, THE Calibration tab panel SHALL update all displayed values to reflect the new Calibration_Profile without requiring a manual refresh
7. THE Calibration tab panel SHALL use the existing stat-chip styling pattern for displaying individual metrics, consistent with the agent stats bar visual style
