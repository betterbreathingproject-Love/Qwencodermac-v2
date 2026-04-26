# Bugfix Requirements Document

## Introduction

HTTP 500 errors and mid-stream MLX server crashes interrupt the agent's coding flow, causing it to stop instead of retrying and continuing until the task is finished. There are three interrelated failure modes: (1) mid-stream SSE errors from the server are silently swallowed, (2) the orchestrator doesn't recognize HTTP 500 as a transient/retryable error, and (3) the streaming path in server.py cannot signal errors via HTTP status since headers are already sent with 200. Together, these cause the agent to halt on recoverable server failures that should be retried automatically.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the MLX server crashes mid-stream (e.g., OOM during generation) and sends an `event: error` SSE event THEN the system silently resolves `_streamCompletion` with partial/empty data instead of throwing an error, so the `_agentLoop` retry logic never triggers

1.2 WHEN the bridge throws a "Server returned HTTP 500" error and it propagates to the orchestrator THEN the system treats it as a permanent failure because the `_handleFailure` transient-error regex does not match "HTTP 500", causing execution to pause after only bridge-level retries

1.3 WHEN `run_stream()` in server.py encounters an exception (MLX OOM, etc.) during streaming THEN the system sends an `event: error` SSE event but the HTTP status remains 200 (since headers were already sent), providing no HTTP-level signal that the response is an error

1.4 WHEN `_streamCompletion` receives an SSE `event: error` line mid-stream THEN the system ignores it because the SSE parsing logic only processes lines starting with `data: ` and does not handle `event:` lines

### Expected Behavior (Correct)

2.1 WHEN the MLX server sends an `event: error` SSE event mid-stream THEN the system SHALL detect the error event in `_streamCompletion`, reject the promise with an error, and allow the `_agentLoop` retry logic to handle it as a transient failure

2.2 WHEN the bridge throws a "Server returned HTTP 500" (or 502/503) error and it propagates to the orchestrator THEN the system SHALL recognize it as a transient error in `_handleFailure` and auto-retry (up to the configured retry limit) before pausing execution

2.3 WHEN `run_stream()` in server.py encounters an exception during streaming THEN the system SHALL send a clearly structured SSE error event (e.g., `event: error\ndata: {"error": "...", "type": "server_error"}`) that the client can reliably detect and act upon

2.4 WHEN `_streamCompletion` receives an SSE error event mid-stream THEN the system SHALL parse the `event:` line, recognize it as an error, and throw an error with the message from the accompanying `data:` line so that retry logic is triggered

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the server returns a successful streaming response with no errors THEN the system SHALL CONTINUE TO accumulate tokens, tool calls, and usage stats and resolve normally

3.2 WHEN a non-streaming request returns HTTP 500 THEN the system SHALL CONTINUE TO throw an error and retry at the bridge level as it does today

3.3 WHEN a transient connection error (ECONNRESET, ECONNREFUSED, EPIPE) occurs THEN the system SHALL CONTINUE TO retry at both the bridge level and orchestrator level as it does today

3.4 WHEN the agent is aborted mid-stream THEN the system SHALL CONTINUE TO respect the abort signal and resolve/return without retrying

3.5 WHEN the orchestrator encounters a non-transient permanent error THEN the system SHALL CONTINUE TO pause execution and report the error without retrying
