# Requirements Document

## Introduction

This feature adds Playwright video recording and Telegram bot integration to QwenCoder Mac Studio, enabling users to remotely trigger agent jobs via Telegram, watch the agent work through recorded browser sessions, and receive video recordings back through the chat. The agent can also request clarification from the user mid-job via Telegram messages, creating a fully remote-controlled agentic coding workflow.

## Glossary

- **Video_Recorder**: The module that wraps Playwright's native `browserContext.recordVideo()` API to capture browser automation sessions as video files.
- **Telegram_Bot**: The Node.js module that connects to the Telegram Bot API using long-polling, sends and receives messages, photos, videos, and documents.
- **Remote_Controller**: The module that bridges Telegram messages to the DirectBridge agent loop, translating incoming chat commands into agent job invocations.
- **QR_Linker**: The component that generates a QR code encoding the Telegram bot's `t.me/<bot_username>` deep link so users can quickly open the bot chat on their phone.
- **Clarification_Channel**: The mechanism by which the agent pauses execution, sends a question to the user via Telegram, waits for a reply, and resumes with the user's answer.
- **Recording_Directory**: The local filesystem directory where Playwright video recordings are stored (default: `./recordings`).
- **Bot_Token**: The Telegram Bot API token used to authenticate with the Telegram API.
- **Agent_Session**: A single end-to-end run of the DirectBridge agent loop triggered by a Telegram command, including all tool calls and the resulting video recording.

## Requirements

### Requirement 1: Video Recording of Browser Sessions

**User Story:** As a user, I want the agent's browser automation sessions to be recorded as video files, so that I can review what the agent did visually.

#### Acceptance Criteria

1. WHEN a browser instance is created with recording enabled, THE Video_Recorder SHALL create a Playwright browser context with `recordVideo` configured to save `.webm` files to the Recording_Directory.
2. WHEN the browser context is closed, THE Video_Recorder SHALL return the absolute file path of the completed video recording.
3. THE Video_Recorder SHALL preserve all existing browser tool functionality (navigate, click, type, screenshot, evaluate, wait_for, select_option, get_text, get_html, close) without behavioral changes.
4. WHEN `createPlaywrightInstance()` is called with `{ recordVideo: true }`, THE Video_Recorder SHALL pass `recordVideo: { dir: <Recording_Directory>, size: { width: 1280, height: 720 } }` to `browser.newContext()`.
5. WHEN `createPlaywrightInstance()` is called without the `recordVideo` option, THE Video_Recorder SHALL create a browser context without video recording, matching current behavior.
6. IF the Recording_Directory does not exist, THEN THE Video_Recorder SHALL create it before launching the browser context.
7. WHEN `browser_close` is called on a recording-enabled instance, THE Video_Recorder SHALL wait for the video file to be finalized before returning the file path.

### Requirement 2: Telegram Bot Connection and Authentication

**User Story:** As a user, I want to connect QwenCoder Mac Studio to a Telegram bot using my bot token, so that I can control the agent remotely.

#### Acceptance Criteria

1. WHEN a bot token is provided, THE Telegram_Bot SHALL validate the token by calling the Telegram `getMe` API and return the bot's username and display name.
2. IF the bot token is invalid or the `getMe` call fails, THEN THE Telegram_Bot SHALL return a descriptive error message including the Telegram API error description.
3. WHEN the token is validated successfully, THE Telegram_Bot SHALL store the token and bot info in memory for use by the polling loop.
4. THE Telegram_Bot SHALL expose a `getStatus()` method returning an object with `connected` (boolean), `botUsername` (string or null), `polling` (boolean), `lastError` (string or null), and `messagesProcessed` (number).
5. WHEN `connect(token)` is called, THE Telegram_Bot SHALL make a single HTTP GET request to `https://api.telegram.org/bot<token>/getMe` with a 10-second timeout.

### Requirement 3: Telegram Long-Polling Message Loop

**User Story:** As a user, I want the bot to continuously listen for my messages, so that I can send commands at any time.

#### Acceptance Criteria

1. WHEN polling is started, THE Telegram_Bot SHALL call `getUpdates` with a 30-second long-poll timeout and process each returned message sequentially.
2. WHEN an update is received, THE Telegram_Bot SHALL track the `update_id` and use `offset = last_update_id + 1` on the next poll to acknowledge processed updates.
3. IF a `getUpdates` call fails due to a network error, THEN THE Telegram_Bot SHALL retry with exponential backoff starting at 2 seconds, doubling each retry, capped at 60 seconds, for up to 10 retries.
4. WHEN polling is stopped via `stopPolling()`, THE Telegram_Bot SHALL abort the current `getUpdates` request and cease further polling.
5. WHILE polling is active, THE Telegram_Bot SHALL increment the `messagesProcessed` counter for each message dispatched to a handler.

### Requirement 4: Telegram Message Sending

**User Story:** As a user, I want the agent to send me text messages, photos, and videos through Telegram, so that I can see results remotely.

#### Acceptance Criteria

1. WHEN `sendMessage(chatId, text)` is called, THE Telegram_Bot SHALL POST to the Telegram `sendMessage` API with the given chat ID and text, using a 10-second timeout.
2. WHEN `sendVideo(chatId, filePath, caption)` is called, THE Telegram_Bot SHALL POST a multipart form to the Telegram `sendVideo` API with the video file read from disk, using a 300-second timeout.
3. WHEN `sendPhoto(chatId, filePath, caption)` is called, THE Telegram_Bot SHALL POST a multipart form to the Telegram `sendPhoto` API with the image file read from disk, using a 60-second timeout.
4. IF any send operation fails, THEN THE Telegram_Bot SHALL return a rejected Promise with the Telegram API error description.
5. IF the file at `filePath` does not exist, THEN THE Telegram_Bot SHALL reject with an error message stating the file was not found.

### Requirement 5: QR Code Generation for Bot Linking

**User Story:** As a user, I want to scan a QR code to quickly open the Telegram bot chat on my phone, so that I can start remote control without manually searching for the bot.

#### Acceptance Criteria

1. WHEN the bot is connected and the bot username is known, THE QR_Linker SHALL generate a QR code encoding the URL `https://t.me/<botUsername>`.
2. THE QR_Linker SHALL return the QR code as a `data:image/png;base64,...` string suitable for rendering in an `<img>` tag.
3. IF the bot is not connected, THEN THE QR_Linker SHALL return null.

### Requirement 6: Remote Agent Job Triggering via Telegram

**User Story:** As a user, I want to send a message to the Telegram bot describing a task, so that the agent starts working on it remotely.

#### Acceptance Criteria

1. WHEN a text message is received that is not a recognized command, THE Remote_Controller SHALL treat the message text as a user prompt and start a new Agent_Session with video recording enabled.
2. WHEN an Agent_Session is started, THE Remote_Controller SHALL send an acknowledgment message to the Telegram chat confirming the job has started.
3. WHEN an Agent_Session completes successfully, THE Remote_Controller SHALL send the video recording of the browser session to the Telegram chat via `sendVideo`.
4. WHEN an Agent_Session completes, THE Remote_Controller SHALL send a text summary of the agent's actions and results to the Telegram chat.
5. IF an Agent_Session fails with an error, THEN THE Remote_Controller SHALL send an error message to the Telegram chat describing the failure.
6. WHILE an Agent_Session is running, THE Remote_Controller SHALL reject new job requests from the same chat with a message indicating a job is already in progress.
7. WHEN the `/status` command is received, THE Remote_Controller SHALL reply with the current agent status (idle, running, job description).
8. WHEN the `/stop` command is received while a job is running, THE Remote_Controller SHALL abort the current Agent_Session and notify the user.


### Requirement 7: Agent Clarification via Telegram

**User Story:** As a user, I want the agent to ask me questions via Telegram when it needs more information, so that I can guide the agent without being at my desk.

#### Acceptance Criteria

1. WHEN the agent invokes a `telegram_ask_user` tool call during an Agent_Session, THE Clarification_Channel SHALL send the question text to the Telegram chat.
2. WHEN a reply is received from the user in the same chat while a clarification is pending, THE Clarification_Channel SHALL resolve the pending request with the user's reply text.
3. IF no reply is received within 5 minutes, THEN THE Clarification_Channel SHALL resolve with a timeout indicator so the agent can proceed with a default action.
4. THE Clarification_Channel SHALL expose a `telegram_ask_user` tool definition compatible with the DirectBridge tool format, accepting a `question` string parameter and returning the user's reply string.

### Requirement 8: Telegram Bot Tool Definitions for the Agent

**User Story:** As a developer, I want the agent to have Telegram-specific tools available during remote sessions, so that it can communicate with the user through Telegram.

#### Acceptance Criteria

1. THE Remote_Controller SHALL register the following tool definitions when a Telegram-triggered Agent_Session is active: `telegram_send_message`, `telegram_send_photo`, `telegram_ask_user`.
2. WHEN `telegram_send_message` is called with a `text` parameter, THE Remote_Controller SHALL send the text to the active Telegram chat.
3. WHEN `telegram_send_photo` is called with a `path` parameter and optional `caption`, THE Remote_Controller SHALL send the photo to the active Telegram chat.
4. WHEN `telegram_ask_user` is called with a `question` parameter, THE Remote_Controller SHALL send the question and wait for the user's reply via the Clarification_Channel.

### Requirement 9: IPC Integration for Electron UI

**User Story:** As a user, I want to configure and monitor the Telegram bot from the QwenCoder Mac Studio UI, so that I can manage the connection without using the terminal.

#### Acceptance Criteria

1. THE IPC layer SHALL expose a `telegram:connect` handler that accepts a bot token string and returns the connection result (success with bot info, or error).
2. THE IPC layer SHALL expose a `telegram:disconnect` handler that stops polling and clears the stored token.
3. THE IPC layer SHALL expose a `telegram:status` handler that returns the current Telegram_Bot status object.
4. THE IPC layer SHALL expose a `telegram:qr-code` handler that returns the QR code data URL or null.
5. WHEN the Telegram bot receives a message or a job completes, THE IPC layer SHALL emit a `telegram:event` message to the renderer process with the event type and payload.

### Requirement 10: Video Recording Cleanup

**User Story:** As a user, I want old video recordings to be cleaned up automatically, so that they do not consume excessive disk space.

#### Acceptance Criteria

1. WHEN an Agent_Session completes and the video has been sent via Telegram, THE Video_Recorder SHALL delete the local video file after a configurable retention period (default: 1 hour).
2. WHEN the application starts, THE Video_Recorder SHALL delete any video files in the Recording_Directory older than 24 hours.
3. IF a video file deletion fails, THEN THE Video_Recorder SHALL log the error and continue without interrupting application operation.
