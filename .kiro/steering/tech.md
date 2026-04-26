# Tech Stack & Build

## Runtime
- Electron 41.x (main process + renderer)
- Node.js with CommonJS modules (`require`/`module.exports` throughout)
- Python 3.12+ backend (FastAPI server for MLX inference)

## Key Dependencies
- `@qwen-code/sdk` — Qwen Code agent SDK
- `openai` — OpenAI-compatible API client
- `playwright` — Browser automation for agent tool use
- `chokidar` — File watching
- `node-pty` — Terminal/PTY support
- `fast-check` — Property-based testing (dev)
- `electron-builder` — Packaging/distribution (dev)

## Python Backend
- FastAPI with MLX for local model inference
- OpenAI-compatible `/v1/chat/completions` endpoint with streaming SSE
- Vision support via MLX VLM models
- Models loaded from `~/.lmstudio/models/`

## Common Commands

```bash
# Run the app in development
npm start              # launches Electron

# Run all tests
npm test               # runs: node --test 'test/*.test.js'

# Build for distribution
npm run build          # electron-builder --mac --dir
npm run dist           # electron-builder --mac (produces .dmg)
```

## Testing
- Test runner: Node.js built-in `node:test` module
- Assertions: `node:assert/strict`
- Property-based testing: `fast-check` (v4)
- Test files live in `test/` with naming conventions:
  - `*.test.js` — unit/integration tests
  - `*.property.test.js` — property-based tests
  - `*.preservation.property.test.js` — preservation property tests (bugfix verification)
- Tests use mock objects and factory functions (no external mocking library)
- Property tests target 100-150 runs (`{ numRuns: 150 }`)

## Code Style
- `'use strict'` at the top of all Node.js modules
- CommonJS (`require`/`module.exports`), not ES modules
- No TypeScript — plain JavaScript throughout
- Minimal external dependencies; prefer Node.js built-in modules (`node:events`, `node:fs`, `node:crypto`, `node:test`, `node:assert`)
- Renderer code is vanilla JS (no React/Vue/framework), directly manipulating the DOM
