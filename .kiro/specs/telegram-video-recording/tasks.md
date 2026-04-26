# Implementation Plan: Telegram Video Recording

## Overview

Bottom-up implementation: recording-manager first (no external deps), then telegram-bot (standalone module), then playwright-tool modifications, then direct-bridge wiring (ask_user, screenshot forwarding, remote job controller), and finally integration. Each task builds on the previous so there is no orphaned code.

## Tasks

- [x] 1. Create `recording-manager.js` — recording file lifecycle
  - [x] 1.1 Implement `RecordingManager` class with constructor and filename generation
    - Create `recording-manager.js` with `'use strict'`, CommonJS exports
    - Constructor accepts `{ baseDir }`, defaulting to `{app_data}/telegram-recordings/`
    - `generateFilename(jobId, format = 'webm')` returns `recording_{timestamp}_{jobId}.{format}`
    - `getRecordingDir(jobId)` returns `{baseDir}/{jobId}/`, creating it recursively if missing
    - _Requirements: 2.1, 2.2_

  - [x] 1.2 Implement listing, validation, and size checking
    - `listRecordings()` returns array of `{ filePath, filename, sizeBytes, createdAt }` for all files in baseDir
    - `validateRecording(filePath)` checks file exists and is readable, returns `{ ok, sizeBytes }` or `{ ok: false, error }`
    - `checkSizeLimit(filePath)` returns `{ withinLimit, sizeBytes }` using 50 MB threshold
    - _Requirements: 2.3, 2.4, 2.5_

  - [x] 1.3 Write unit tests for RecordingManager (`test/recording-manager.test.js`)
    - Test filename pattern matching for various jobIds and formats
    - Test directory creation when baseDir doesn't exist
    - Test listRecordings with mock files
    - Test validateRecording for existing, missing, and unreadable files
    - Test checkSizeLimit for files above and below 50 MB
    - _Requirements: 2.1–2.5_

  - [x] 1.4 Write property test: recording filename pattern (Property 1)
    - **Property 1: Recording filename matches pattern**
    - For any jobId string and format ("mp4" or "webm"), generated filename matches `recording_{timestamp}_{jobId}.{format}`
    - **Validates: Requirements 2.2**

- [x] 2. Create `telegram-bot.js` — Telegram Bot API client
  - [x] 2.1 Implement `TelegramBot` class skeleton, `telegramRequest`, and `calculateBackoffDelay`
    - Create `telegram-bot.js` with `'use strict'`, CommonJS exports, extends `EventEmitter`
    - Implement `telegramRequest(method, token, params)` using `node:https`
    - Implement `telegramUpload(method, token, chatId, fieldName, filePath, caption)` with hand-rolled multipart/form-data
    - Export `calculateBackoffDelay(retryCount)` as a pure function: `Math.min(2 * 2^retryCount, 60)`
    - Constructor accepts `{ configPath, appDataDir }`
    - _Requirements: 3.1, 3.7_

  - [x] 2.2 Implement `start(token)`, `stop()`, `getStatus()`, and long-polling loop
    - `start(token)` validates token via `getMe`, stores bot username, begins `_pollLoop()`
    - `_pollLoop()` calls `getUpdates` with 30s timeout, applies exponential backoff on errors
    - `stop()` sets `_polling = false`, resolves within 5 seconds
    - `getStatus()` returns `{ connected, bot_username, polling, last_error }`
    - _Requirements: 3.1, 3.2, 3.7, 3.8, 3.9_

  - [x] 2.3 Implement message parsing and event emission
    - `_handleUpdate(update)` parses text messages, commands (`/run`, `/status`, `/stop`, `/screenshot`), and photos
    - Emits `'message'` with `{ chatId, text, messageId }`
    - Emits `'command'` with `{ chatId, command, args, messageId }`
    - Emits `'photo'` with `{ chatId, fileId, caption, messageId }`
    - _Requirements: 3.3_

  - [x] 2.4 Implement `sendMessage`, `sendVideo`, `sendPhoto`
    - `sendMessage(chatId, text)` calls Telegram `sendMessage` API
    - `sendVideo(chatId, filePath, caption)` uses multipart upload to Telegram `sendVideo`
    - `sendPhoto(chatId, filePath, caption)` uses multipart upload to Telegram `sendPhoto`
    - All return `{ ok }` or `{ error }` objects
    - _Requirements: 3.4, 3.5, 3.6_

  - [x] 2.5 Implement pairing: `generatePairingToken`, `validatePairingToken`, `getPairedChatId`
    - `generatePairingToken()` returns `{ token, qrDataUrl, expiresAt }` with 32+ hex chars via `crypto.randomBytes`
    - `validatePairingToken(token, chatId)` checks expiry (10 min), single-use, associates chatId
    - `getPairedChatId()` returns stored chatId or null
    - Handle `/start {token}` messages in `_handleUpdate` to trigger pairing validation
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6_

  - [x] 2.6 Implement config persistence: `saveConfig`, `loadConfig`
    - `saveConfig()` writes `{ token, pairedChatId, botUsername }` to `{appDataDir}/telegram-bot-config.json`
    - `loadConfig()` reads and parses config file, returns object or null on missing/corrupt
    - Call `saveConfig()` after pairing completes and after token changes
    - _Requirements: 4.4, 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 3. Checkpoint — RecordingManager and TelegramBot core
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Write tests for `telegram-bot.js`
  - [x] 4.1 Write unit tests (`test/telegram-bot.test.js`)
    - Test `calculateBackoffDelay` for retryCount 0–15
    - Test `_handleUpdate` emits correct events for text, command, photo messages
    - Test `getStatus()` returns correct shape in all states
    - Test `generatePairingToken` produces 32+ hex char tokens
    - Test `validatePairingToken` accepts valid token, rejects consumed, rejects expired
    - Test `/run`, `/status`, `/stop` command parsing
    - Test `saveConfig`/`loadConfig` round-trip with mock filesystem
    - Test `start()` rejects invalid token
    - Test `stop()` ceases polling
    - _Requirements: 3.1–3.9, 4.1–4.6, 8.1–8.5_

  - [x] 4.2 Write property test: message parsing (Property 2)
    - **Property 2: Telegram message parsing extracts correct fields**
    - For any valid Telegram update with text, parsing emits event with exact chat.id, text, message_id
    - **Validates: Requirements 3.3**

  - [x] 4.3 Write property test: exponential backoff (Property 3)
    - **Property 3: Exponential backoff delay follows formula**
    - For any non-negative retryCount, delay equals `min(2 * 2^retryCount, 60)`
    - **Validates: Requirements 3.7**

  - [x] 4.4 Write property test: bot status shape (Property 4)
    - **Property 4: Bot status object has required fields**
    - For any bot state, `getStatus()` returns object with `connected`, `bot_username`, `polling`, `last_error`
    - **Validates: Requirements 3.9**

  - [x] 4.5 Write property test: pairing token generation (Property 5)
    - **Property 5: Pairing token generation produces valid tokens**
    - For any invocation, token is 32+ hex chars, no two tokens are equal
    - **Validates: Requirements 4.1**

  - [x] 4.6 Write property test: pairing token single-use (Property 6)
    - **Property 6: Pairing tokens are single-use**
    - First `validatePairingToken` succeeds, subsequent calls with same token are rejected
    - **Validates: Requirements 4.5**

  - [x] 4.7 Write property test: pairing token expiry (Property 7)
    - **Property 7: Pairing tokens expire after 10 minutes**
    - Tokens older than 10 minutes are rejected; tokens within 10 minutes are accepted (if not consumed)
    - **Validates: Requirements 4.6**

  - [x] 4.8 Write property test: /run command parsing (Property 8)
    - **Property 8: /run command parsing extracts prompt text**
    - For any prompt string, parsing `/run {prompt}` produces a command event with the exact prompt
    - **Validates: Requirements 5.1**

  - [x] 4.9 Write property test: /status reply (Property 9)
    - **Property 9: /status reply includes current job state**
    - For any job state, the /status response contains the state string and job ID when not idle
    - **Validates: Requirements 5.7**

  - [x] 4.10 Write property test: config round-trip (Property 11)
    - **Property 11: Configuration serialization round-trip**
    - For any valid config with token, pairedChatId, botUsername, serialize then deserialize produces deep-equal object
    - **Validates: Requirements 8.4, 8.5**

- [x] 5. Checkpoint — TelegramBot tests
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Modify `playwright-tool.js` — add recording support
  - [x] 6.1 Add `recordingOptions` parameter to `createPlaywrightInstance`
    - Modify `createPlaywrightInstance(options = {})` to accept `{ recordingOptions }` parameter
    - `recordingOptions`: `{ dir, size?, format? }` — passed to Playwright's `recordVideo` context option
    - Create recording directory recursively if it doesn't exist
    - Add `_recordingPath` variable to track the video file path
    - _Requirements: 1.1, 1.2, 1.3, 1.6_

  - [x] 6.2 Implement recording path retrieval and graceful fallback
    - Add `getRecordingPath()` method returning `_recordingPath` (null if not recording)
    - In `closeBrowser()`, retrieve video path via `_page.video().path()` before closing
    - If recording initialization fails, fall back to non-recording context and log warning
    - Return `{ execute, closeBrowser, getRecordingPath }` from factory
    - _Requirements: 1.4, 1.5, 1.7_

  - [x] 6.3 Write unit tests for recording support (`test/playwright-tool.test.js`)
    - Test that `createPlaywrightInstance()` without options works as before (backward compat)
    - Test that `getRecordingPath()` returns null before recording
    - Test that `recordingOptions` is passed through to context creation
    - Test fallback behavior when recording fails
    - _Requirements: 1.1–1.7_

- [x] 7. Modify `direct-bridge.js` — ask_user tool, screenshot forwarding, remote jobs
  - [x] 7.1 Add `ask_user` tool definition and `InputRequester` class
    - Add `ask_user` tool definition to `TOOL_DEFS` array
    - Implement `InputRequester` class with `ask(question)` method
    - `ask()` sends question via `telegramBot.sendMessage`, returns Promise resolving on reply or 5-min timeout
    - `hasPendingRequest()` returns boolean for blocking concurrent `/run` commands
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 7.2 Add `ask_user` execution branch in `executeTool`
    - In the tool dispatch, add `case 'ask_user'` that calls `inputRequester.ask(args.question)`
    - Return `{ result: reply }` on success, `{ result: '(User input timed out...)' }` on timeout
    - Return `{ result: '(No input channel available...)' }` when no inputRequester is configured
    - _Requirements: 6.1, 6.3, 6.4_

  - [x] 7.3 Add screenshot forwarding hook in agent loop
    - After `browser_screenshot` execution, check if `this._telegramForwarder` is set
    - Extract base64 PNG from result, save to temp file, send via `telegramBot.sendPhoto`
    - Non-blocking: don't fail the tool call if forwarding fails
    - _Requirements: 7.1_

  - [x] 7.4 Implement `RemoteJobController` class
    - Constructor accepts `{ telegramBot, chatId, recordingManager }`
    - `runJob(prompt)` creates recording path, creates DirectBridge with recording, wires InputRequester, starts agent loop
    - `handleCommand(command, args)` dispatches `/run`, `/status`, `/stop`, `/screenshot`
    - `getJobState()` returns `'idle' | 'running' | 'completed' | 'failed'`
    - Send confirmation on job start, periodic status updates (≥30s apart), video on completion, error on failure
    - _Requirements: 5.1–5.8, 7.2, 7.3_

  - [x] 7.5 Write property test: input request round-trip (Property 10)
    - **Property 10: Input request round-trip preserves reply text**
    - For any question and reply string, `ask_user` delivers the exact reply string to the agent
    - **Validates: Requirements 6.3**

  - [x] 7.6 Write unit tests for ask_user and RemoteJobController (`test/direct-bridge-telegram.test.js`)
    - Test `ask_user` with mock TelegramBot: question sent, reply received
    - Test `ask_user` timeout after 5 minutes
    - Test `InputRequester.hasPendingRequest()` state tracking
    - Test `RemoteJobController.handleCommand` dispatches `/run`, `/status`, `/stop`
    - Test screenshot forwarding extracts base64 and calls sendPhoto
    - Test `/run` rejected while input request pending
    - _Requirements: 5.1–5.8, 6.1–6.5, 7.1–7.3_

- [x] 8. Checkpoint — All modules implemented
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Wire everything together in `main.js`
  - [x] 9.1 Initialize TelegramBot and RecordingManager in main process
    - Import `telegram-bot.js` and `recording-manager.js`
    - Create `TelegramBot` instance with config path from app data directory
    - Create `RecordingManager` instance with base directory from app data directory
    - Load saved config on startup; if valid token + chatId found, auto-start bot
    - Wire `'command'` event from bot to `RemoteJobController`
    - _Requirements: 3.1, 8.1, 8.2_

  - [x] 9.2 Add IPC handlers for Telegram pairing and bot control
    - `telegram-pair` handler: calls `generatePairingToken()`, returns QR data URL
    - `telegram-status` handler: returns `bot.getStatus()`
    - `telegram-start` handler: calls `bot.start(token)`, saves config
    - `telegram-stop` handler: calls `bot.stop()`
    - Add corresponding preload.js bridge methods
    - _Requirements: 4.1, 4.2, 3.8, 3.9_

  - [x] 9.3 Write integration tests (`test/telegram-bot-integration.test.js`)
    - Test bot start/stop lifecycle with mocked HTTPS
    - Test QR pairing end-to-end flow with mock Telegram API
    - Test remote job dispatch with mocked DirectBridge
    - Test config persistence to/from disk
    - _Requirements: 3.1–3.9, 4.1–4.6, 5.1–5.8, 8.1–8.5_

- [x] 10. Final checkpoint — Full integration
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 11 universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All modules use `'use strict'`, CommonJS, and `node:` built-in modules per codebase conventions
