# Bugfix Requirements Document

## Introduction

The agent layer (QwenBridge + @qwen-code/sdk) introduces significant latency overhead compared to direct LLM streaming via the `chat-stream` IPC path. Direct streaming forwards raw SSE chunks from the Python server to the renderer with minimal processing, while the agent path adds multiple layers of overhead: per-run MCP server instantiation, conversation history re-serialization as a text transcript, SDK message buffering/processing, and an inflated system prompt that increases prompt token count. This results in noticeably slower time-to-first-token and lower perceived throughput for agent responses.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a user sends a prompt via the agent mode (qwen-run) THEN the system creates fresh Playwright and Vision MCP server instances on every single run, adding startup latency before the LLM request is even made

1.2 WHEN a user sends a prompt via the agent mode with conversation history THEN the system serializes the entire conversation history into a plain-text transcript prepended to the prompt, significantly inflating the prompt token count and increasing prompt processing time on the LLM

1.3 WHEN the agent mode streams tokens from the LLM THEN the system routes tokens through the @qwen-code/sdk async iterator and QwenBridge._handleMessage() processing before forwarding to the renderer, adding per-token processing latency compared to the direct SSE passthrough in chat-stream

1.4 WHEN the agent mode constructs the LLM request THEN the system injects a large system prompt containing full tool descriptions (Playwright, Vision, permission mode instructions) on every request, increasing prompt token count and LLM processing time even when those tools are not needed

1.5 WHEN the orchestrator dispatches a task to the agent pool THEN the system performs semaphore acquisition, agent type selection via keyword matching, timeout promise racing, and agent factory creation on every dispatch, adding overhead before the actual LLM call begins

1.6 WHEN multiple agent requests are made in rapid succession THEN the Python server's threading.Lock (_inference_lock) serializes all inference, causing subsequent requests to queue and wait even though the agent layer could pipeline preparation work

1.7 WHEN the agent mode is invoked without any images attached THEN the system still creates a Vision MCP server instance and calls clearImages(), performing unnecessary work

### Expected Behavior (Correct)

2.1 WHEN a user sends a prompt via the agent mode THEN the system SHALL reuse existing MCP server instances across runs (lazy initialization) and only create them when the corresponding tools are actually needed, eliminating per-run startup latency

2.2 WHEN a user sends a prompt via the agent mode with conversation history THEN the system SHALL pass conversation history in a structured format (e.g., as proper message objects) to the SDK rather than serializing it into a text transcript, avoiding prompt token inflation

2.3 WHEN the agent mode streams tokens from the LLM THEN the system SHALL minimize per-token processing overhead by forwarding text deltas to the renderer as soon as they are received from the SDK, without unnecessary intermediate transformations

2.4 WHEN the agent mode constructs the LLM request THEN the system SHALL only include tool descriptions in the system prompt for tools that are relevant to the current request context (e.g., omit Playwright descriptions when no browsing is requested, omit Vision descriptions when no images are attached)

2.5 WHEN the orchestrator dispatches a task to the agent pool THEN the system SHALL minimize dispatch overhead by caching agent type selections and pre-allocating resources where possible, reducing the time between task readiness and actual LLM invocation

2.6 WHEN multiple agent requests are made in sequence THEN the system SHALL allow preparation work (prompt building, context assembly) to proceed concurrently with ongoing inference, reducing end-to-end latency for sequential operations

2.7 WHEN the agent mode is invoked without images attached THEN the system SHALL skip Vision MCP server creation and image cleanup entirely, avoiding unnecessary object instantiation

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a user sends a prompt via direct streaming (chat-stream) THEN the system SHALL CONTINUE TO forward raw SSE chunks from the Python server to the renderer with the current minimal-latency passthrough behavior

3.2 WHEN the agent uses Playwright or Vision tools during a run THEN the system SHALL CONTINUE TO provide fully functional MCP server instances with proper browser isolation and image analysis capabilities

3.3 WHEN the agent processes tool_use and tool_result messages THEN the system SHALL CONTINUE TO correctly parse, forward, and display tool interactions in the renderer UI

3.4 WHEN the orchestrator executes a task graph with dependencies THEN the system SHALL CONTINUE TO respect task ordering, semaphore concurrency limits, and timeout constraints

3.5 WHEN the Python server receives concurrent requests THEN the system SHALL CONTINUE TO serialize MLX inference via the inference lock to prevent thread-safety issues

3.6 WHEN conversation history is provided to the agent THEN the system SHALL CONTINUE TO give the agent full multi-turn context so it can reference prior conversation turns

3.7 WHEN the agent runs in auto-edit permission mode THEN the system SHALL CONTINUE TO auto-approve actions without requiring user confirmation
