# Requirements Document

## Introduction

This feature adds video recording capability to the existing Playwright browser automation and integrates a Telegram bot into the Electron app, enabling users to remotely trigger agent jobs via Telegram, record the agent's browser session as video, and receive the recording back through Telegram. Users pair their Telegram chat to the desktop app via QR code, then can issue commands, receive progress updates, and get video recordings or screenshots of completed work. The agent can also request further input from the user via Telegram mid-job.

## Glossary

- **Video_Recorder**: The module within playwright-tool.js responsible for starting, stopping, and managing Playwright video recording on browser contexts.
- **Telegram_Bot**: The Node.js CommonJS module that connects to the Telegram Bot API, handles incoming messages/commands, and sends media (video, photo, text) back to users.
- **Pairing_Manager**: The component that generates QR codes encoding a pairing URL/token and links a specific Telegram chat ID to the running desktop app instance.
- **Remote_Job_Controller**: The component that receives job requests from Telegram, dispatches them through the existing DirectBridge/Orchestrator pipeline, and tracks job lifecycle.
- **Recording_Manager**: The component that manages recording file paths, formats, and lifecycle — ensuring recordings are saved, retrievable, and cleaned up.
- **Input_Requester**: The mechanism by which the agent pauses execution to ask the user a question via Telegram and waits for their reply before continuing.

## Requirements

### Requirement 1: Playwright Video Recording

**User Story:** As a developer, I want the Playwright browser automation to record video of browser sessions, so that I can review what the agent did visually.

#### Acceptance Criteria

1. WHEN a browser context is created with recording enabled, THE Video_Recorder SHALL configure Playwright to record video to a specified directory path.
2. WHEN a browser context is created with recording enabled, THE Video_Recorder SHALL accept a recording format parameter supporting "mp4" and "webm" values.
3. WHEN a browser context is created with recording enabled, THE Video_Recorder SHALL accept a video size parameter with width and height values, defaulting to 1280x720.
4. WHEN the browser is closed after a recorded session, THE Video_Recorder SHALL save the video file to the configured directory and return the absolute file path of the saved recording.
5. WHEN recording is enabled, THE Video_Recorder SHALL expose a method to retrieve the recording file path before browser close, returning null if recording has not yet produced a file.
6. IF the configured recording directory does not exist, THEN THE Video_Recorder SHALL create the directory recursively before launching the browser context.
7. IF Playwright fails to initialize video recording, THEN THE Video_Recorder SHALL return an error message describing the failure and fall back to a non-recording browser context.

### Requirement 2: Recording Lifecycle Management

**User Story:** As a developer, I want recordings to be managed with clear lifecycle rules, so that disk space is not wasted and recordings are easy to find.

#### Acceptance Criteria

1. THE Recording_Manager SHALL store all recordings in a configurable base directory, defaulting to `{app_data}/telegram-recordings/`.
2. WHEN a new recording is started, THE Recording_Manager SHALL generate a unique filename using the pattern `recording_{timestamp}_{jobId}.{format}`.
3. THE Recording_Manager SHALL provide a method to list all existing recordings with their file paths, sizes, and creation timestamps.
4. WHEN a recording file is requested for sending, THE Recording_Manager SHALL verify the file exists and is readable before returning the path.
5. IF a recording file exceeds 50 MB, THEN THE Recording_Manager SHALL report the file size to the caller so the caller can decide how to handle the Telegram upload limit.

### Requirement 3: Telegram Bot Integration

**User Story:** As a developer, I want a Telegram bot module in the Electron app, so that I can send commands and receive responses from the agent remotely.

#### Acceptance Criteria

1. WHEN a valid bot token is provided, THE Telegram_Bot SHALL validate the token by calling the Telegram getMe API and return the bot username on success.
2. WHEN the bot is started, THE Telegram_Bot SHALL begin long-polling for updates from the Telegram API with a 30-second timeout per poll.
3. WHEN a text message is received, THE Telegram_Bot SHALL parse the message and emit an event with the chat ID, message text, and message ID.
4. THE Telegram_Bot SHALL provide a send_message method that sends a text message to a specified chat ID and returns success or an error description.
5. THE Telegram_Bot SHALL provide a send_video method that sends a video file from a local path to a specified chat ID with an optional caption.
6. THE Telegram_Bot SHALL provide a send_photo method that sends a photo file from a local path to a specified chat ID with an optional caption.
7. IF the Telegram API returns an error during polling, THEN THE Telegram_Bot SHALL apply exponential backoff starting at 2 seconds, doubling up to a maximum of 60 seconds, and resume polling after the delay.
8. WHEN the bot is stopped, THE Telegram_Bot SHALL cease polling and release all network resources within 5 seconds.
9. THE Telegram_Bot SHALL expose a get_status method returning an object with connected (boolean), bot_username (string or null), polling (boolean), and last_error (string or null) fields.

### Requirement 4: QR Code Pairing

**User Story:** As a user, I want to scan a QR code with my phone to link my Telegram chat to the desktop app, so that I can start controlling the agent remotely without manual configuration.

#### Acceptance Criteria

1. WHEN pairing is initiated, THE Pairing_Manager SHALL generate a unique pairing token of at least 32 random hexadecimal characters.
2. WHEN a pairing token is generated, THE Pairing_Manager SHALL encode a deep-link URL containing the token into a QR code and return the QR code as a PNG data URL.
3. WHEN the user sends the pairing token to the Telegram bot (via the deep-link start parameter), THE Pairing_Manager SHALL associate the sender's chat ID with the desktop app instance.
4. WHEN pairing is completed, THE Pairing_Manager SHALL persist the paired chat ID so it survives app restarts.
5. IF a pairing token is used more than once, THEN THE Pairing_Manager SHALL reject the duplicate attempt and send an error message to the Telegram chat.
6. IF a pairing token is older than 10 minutes, THEN THE Pairing_Manager SHALL reject the token as expired and require a new QR code to be generated.

### Requirement 5: Remote Job Triggering

**User Story:** As a user, I want to send a message to the Telegram bot to start an agent job, so that I can remotely control the app from my phone.

#### Acceptance Criteria

1. WHEN a paired user sends a `/run <prompt>` command, THE Remote_Job_Controller SHALL create a new agent job with the provided prompt text.
2. WHEN a job is created via Telegram, THE Remote_Job_Controller SHALL dispatch the job through the existing DirectBridge agent tool loop with video recording enabled.
3. WHEN a job starts executing, THE Remote_Job_Controller SHALL send a confirmation message to the Telegram chat including the job ID.
4. WHILE a job is in progress, THE Remote_Job_Controller SHALL send periodic status updates to the Telegram chat at intervals no shorter than 30 seconds.
5. WHEN a job completes successfully, THE Remote_Job_Controller SHALL send the recorded video to the Telegram chat with a caption summarizing the result.
6. IF a job fails with an error, THEN THE Remote_Job_Controller SHALL send an error message to the Telegram chat describing the failure reason.
7. WHEN a paired user sends a `/status` command, THE Remote_Job_Controller SHALL reply with the current job state (idle, running, completed, or failed) and job ID if applicable.
8. WHEN a paired user sends a `/stop` command while a job is running, THE Remote_Job_Controller SHALL abort the current job and send a confirmation message.

### Requirement 6: Agent Input Request via Telegram

**User Story:** As a user, I want the agent to ask me questions via Telegram when it needs more information, so that I can provide input without being at my desk.

#### Acceptance Criteria

1. WHEN the agent calls an `ask_user` tool during a Telegram-initiated job, THE Input_Requester SHALL send the question text to the paired Telegram chat.
2. WHILE waiting for user input, THE Input_Requester SHALL pause the agent tool loop and hold the pending request with a reference to the originating tool call.
3. WHEN the user replies to the question in the Telegram chat, THE Input_Requester SHALL deliver the reply text back to the agent tool loop as the tool call result.
4. IF the user does not reply within 5 minutes, THEN THE Input_Requester SHALL resume the agent with a timeout message indicating no user response was received.
5. WHILE an input request is pending, THE Input_Requester SHALL reject new `/run` commands and inform the user that the agent is waiting for their reply.

### Requirement 7: Progress Screenshots

**User Story:** As a user, I want to receive screenshots of the agent's browser during a job, so that I can see what is happening without waiting for the full video.

#### Acceptance Criteria

1. WHEN the agent executes a `browser_screenshot` tool during a Telegram-initiated job, THE Remote_Job_Controller SHALL send the screenshot image to the paired Telegram chat.
2. WHEN a paired user sends a `/screenshot` command during a running job, THE Remote_Job_Controller SHALL capture a screenshot of the current browser page and send it to the Telegram chat.
3. IF no browser page is currently open when a screenshot is requested, THEN THE Remote_Job_Controller SHALL reply with a message stating that no browser session is active.

### Requirement 8: Telegram Bot Serialization

**User Story:** As a developer, I want the bot configuration to be saved and loaded from disk, so that the bot reconnects automatically on app restart.

#### Acceptance Criteria

1. THE Telegram_Bot SHALL serialize its configuration (bot token, paired chat ID) to a JSON file at `{app_data}/telegram-bot-config.json`.
2. WHEN the app starts, THE Telegram_Bot SHALL attempt to load the configuration file and automatically start polling if a valid token and paired chat ID are found.
3. WHEN the bot token or paired chat ID changes, THE Telegram_Bot SHALL persist the updated configuration to disk within 1 second.
4. THE Serializer SHALL format the configuration as a JSON object with `token`, `pairedChatId`, and `botUsername` string fields.
5. FOR ALL valid configuration objects, serializing then deserializing SHALL produce an equivalent configuration object (round-trip property).
