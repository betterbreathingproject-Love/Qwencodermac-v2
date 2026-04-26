# Bugfix Requirements Document

## Introduction

HTTP 500 errors and mid-stream MLX server crashes interrupt the agent's coding flow, causing it to stop instead of retrying and continuing until the task is finished. There are three interrelated failure modes: (1) mid-stream SSE errors from the server are silently swallowed, (2) the orchestrator doesn't recognize HTTP 500 as a transient/retryable error, and (3) the streaming path in server.py cannot signal errors via HTTP status since headers are already sent with 200. Together, these cause the agent to halt on recoverable server failures that should be retried automatically.

In addition to these defensive/reactive measures, the system also lacks preventive safeguards that could avoid many of these failures in the first place. The server does not check available Metal memory before starting inference, the client does not validate prompt size before sending to the server, the server does not reject dangerously large prompts, and cache clearing between requests is not aggressive enough to prevent memory accumulation. Adding preventive guards at both the server and client layers will significantly reduce the frequency of OOM crashes and HTTP 500 errors.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the MLX server crashes mid-stream (e.g., OOM during generation) and sends an `event: error` SSE event THEN the system silently resolves `_streamCompletion` with partial/empty data instead of throwing an error, so the `_agentLoop` retry logic never triggers

1.2 WHEN the bridge throws a "Server returned HTTP 500" error and it propagates to the orchestrator THEN the system treats it as a permanent failure because the `_handleFailure` transient-error regex does not match "HTTP 500", causing execution to pause after only bridge-level retries

1.3 WHEN `run_stream()` in server.py encounters an exception (MLX OOM, etc.) during streaming THEN the system sends an `event: error` SSE event but the HTTP status remains 200 (since headers were already sent), providing no HTTP-level signal that the response is an error

1.4 WHEN `_streamCompletion` receives an SSE `event: error` line mid-stream THEN the system ignores it because the SSE parsing logic only processes lines starting with `data: ` and does not handle `event:` lines

1.5 WHEN Metal active memory is already high (e.g., >80% of system memory) before inference begins THEN the server starts inference anyway without checking available memory, leading to OOM crashes mid-stream that produce HTTP 500 or `event: error` SSE events

1.6 WHEN `_streamCompletion` sends a request with a very large prompt (e.g., >30K tokens) THEN the client does not validate or guard prompt size before sending, even though `_agentLoop` trims messages at 24K tokens — the trimming does not apply to the initial prompt or to prompts constructed outside `_agentLoop`

1.7 WHEN the server receives a prompt that is dangerously large (e.g., >30K tokens worth of characters) THEN the server attempts inference regardless of prompt length, making OOM crashes highly likely for large prompts

1.8 WHEN the server encounters an error during inference and clears the Metal cache THEN the cache clearing only happens inside the `run_stream` finally block, and there is no proactive cache clearing after errors or between requests at the endpoint level to prevent memory accumulation across sequential requests

### Expected Behavior (Correct)

2.1 WHEN the MLX server sends an `event: error` SSE event mid-stream THEN the system SHALL detect the error event in `_streamCompletion`, reject the promise with an error, and allow the `_agentLoop` retry logic to handle it as a transient failure

2.2 WHEN the bridge throws a "Server returned HTTP 500" (or 502/503) error and it propagates to the orchestrator THEN the system SHALL recognize it as a transient error in `_handleFailure` and auto-retry (up to the configured retry limit) before pausing execution

2.3 WHEN `run_stream()` in server.py encounters an exception during streaming THEN the system SHALL send a clearly structured SSE error event (e.g., `event: error\ndata: {"error": "...", "type": "server_error"}`) that the client can reliably detect and act upon

2.4 WHEN `_streamCompletion` receives an SSE error event mid-stream THEN the system SHALL parse the `event:` line, recognize it as an error, and throw an error with the message from the accompanying `data:` line so that retry logic is triggered

2.5 WHEN Metal active memory exceeds a configurable threshold (e.g., >80% of system memory) before inference begins THEN the server SHALL proactively return HTTP 503 with a "Server busy, retry later" message WITHOUT starting inference, allowing the client to back off and retry after memory is freed

2.6 WHEN `_streamCompletion` is about to send a request THEN the system SHALL estimate the prompt token count and, if it exceeds a safe limit (e.g., 30K tokens), proactively trim or truncate the messages before sending to the server, preventing OOM-inducing large prompts from reaching the inference engine

2.7 WHEN the server receives a prompt whose character length suggests it exceeds a safe token limit (e.g., >30K estimated tokens) THEN the server SHALL reject the request with HTTP 413 and a structured error message (e.g., `{"error": "Prompt too large", "estimated_tokens": N, "limit": 30000}`) that the client can handle by trimming and retrying

2.8 WHEN the server finishes processing a request (whether successful or failed) THEN the server SHALL clear the Metal cache at the endpoint level after each request completes, and SHALL clear the cache more aggressively after errors, to prevent memory accumulation across sequential requests

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the server returns a successful streaming response with no errors THEN the system SHALL CONTINUE TO accumulate tokens, tool calls, and usage stats and resolve normally

3.2 WHEN a non-streaming request returns HTTP 500 THEN the system SHALL CONTINUE TO throw an error and retry at the bridge level as it does today

3.3 WHEN a transient connection error (ECONNRESET, ECONNREFUSED, EPIPE) occurs THEN the system SHALL CONTINUE TO retry at both the bridge level and orchestrator level as it does today

3.4 WHEN the agent is aborted mid-stream THEN the system SHALL CONTINUE TO respect the abort signal and resolve/return without retrying

3.5 WHEN the orchestrator encounters a non-transient permanent error THEN the system SHALL CONTINUE TO pause execution and report the error without retrying

3.6 WHEN Metal active memory is below the threshold before inference THEN the server SHALL CONTINUE TO proceed with inference normally without returning 503

3.7 WHEN the prompt size is within the safe token limit THEN `_streamCompletion` SHALL CONTINUE TO send the request without trimming or modification

3.8 WHEN the server receives a prompt within the safe character/token limit THEN the server SHALL CONTINUE TO accept and process the request normally without returning 413

3.9 WHEN the server successfully completes inference THEN the server SHALL CONTINUE TO return the full streaming response with usage stats, and the post-request cache clearing SHALL NOT interfere with the response delivery
