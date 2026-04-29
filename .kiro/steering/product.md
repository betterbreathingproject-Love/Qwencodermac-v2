# QwenCoder Mac Studio — Product Overview

QwenCoder Mac Studio is a native macOS (Apple Silicon) desktop application for local AI-assisted coding. It bundles a local MLX inference server with an Electron-based IDE — no cloud dependency required.

## Core Capabilities

- **Local LLM inference** via MLX on Apple Silicon (primary: Qwen3.6 35B A3B 8bit, fast: Qwen3.5 0.8B 8bit)
- **Vision model support** for image analysis via MLX VLM
- **Agentic coding** with tool use: file read/write, bash, search, browser automation (Playwright)
- **Spec-driven development**: requirements → design → tasks → implementation
- **DAG-based task orchestration** with branching, looping, and parallel execution
- **Multi-agent architecture** with specialized subagent roles (explore, debug, tester, implementation, etc.)
- **Project/session management** with conversation history and compaction
- **Telegram bot integration** for remote job control and video recording
- **LSP integration** (`lsp-manager.js`, `agent-lsp` binary) for diagnostics and safe-edit workflows

## Subagent Roles

Agents are routed by keyword matching (`CATEGORY_KEYWORDS` in `agent-pool.js`) with a fast-model fallback.

| Role | Purpose |
|---|---|
| `explore` | Open-ended codebase investigation |
| `context-gather` | Task-scoped file/line retrieval |
| `code-search` | Pattern/definition/usage lookup |
| `debug` | Diagnose-first bug fixing |
| `tester` | Browser-based UI/E2E verification via Playwright |
| `requirements` | Structured requirements authoring |
| `design` | Architecture and interface design |
| `implementation` | Code writing and modification |
| `general` | Fallback for ambiguous tasks |
