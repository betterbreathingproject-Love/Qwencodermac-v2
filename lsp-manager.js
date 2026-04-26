'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { execSync, spawn } = require('node:child_process');

// --- Constants ---

const LSP_STATUSES = ['stopped', 'starting', 'ready', 'error', 'degraded'];

const DEFAULT_BINARY_PATH = null; // auto-discover
const DEFAULT_HEALTH_CHECK_INTERVAL = 30000; // 30s
const DEFAULT_MAX_RESTARTS = 3;
const BINARY_NAME = 'agent-lsp';
const BUNDLED_BINARY_PATH = path.join(__dirname, 'resources', 'bin', BINARY_NAME);
const KNOWN_LANGUAGE_SERVERS = [
  'gopls',
  'typescript-language-server',
  'pyright',
  'rust-analyzer',
  'clangd',
  'jdtls',
];

const LANGUAGE_SERVER_LANGUAGES = {
  'gopls': ['go'],
  'typescript-language-server': ['javascript', 'typescript'],
  'pyright': ['python'],
  'rust-analyzer': ['rust'],
  'clangd': ['c', 'cpp'],
  'jdtls': ['java'],
};

// --- LspManager ---

class LspManager extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string|null} [options.binaryPath] - Path to agent-lsp binary (null = auto-discover)
   * @param {number} [options.healthCheckInterval] - Health check interval in ms (default 30000)
   * @param {number} [options.maxRestarts] - Max restart attempts on unexpected exit (default 3)
   */
  constructor(options = {}) {
    super();
    this._binaryPath = options.binaryPath ?? DEFAULT_BINARY_PATH;
    this._healthCheckInterval = options.healthCheckInterval ?? DEFAULT_HEALTH_CHECK_INTERVAL;
    this._maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;

    this._status = 'stopped';
    this._servers = [];
    this._projectDir = null;
    this._startedAt = null;
    this._process = null;
    this._restartCount = 0;
    this._healthTimer = null;
    this._requestId = 1; // start at 1, 0 is reserved for MCP init
    this._pendingRequests = new Map();
    this._stopping = false;
    this._restartTimer = null;
    this._restarting = false;
    this._initHandler = null;
  }

  /**
   * Returns the current LSP status snapshot.
   * @returns {{ status: string, servers: Array, projectDir: string|null, uptime: number|null }}
   */
  getStatus() {
    return {
      status: this._status,
      servers: [...this._servers],
      projectDir: this._projectDir,
      uptime: this._startedAt ? Date.now() - this._startedAt : null,
    };
  }

  /**
   * Transition to a new status and emit 'status-change' event.
   * @param {string} newStatus - Must be one of LSP_STATUSES
   */
  _setStatus(newStatus) {
    if (!LSP_STATUSES.includes(newStatus)) {
      throw new Error(`Invalid LSP status: ${newStatus}`);
    }
    const oldStatus = this._status;
    if (oldStatus === newStatus) return;
    this._status = newStatus;
    this.emit('status-change', { oldStatus, newStatus });
  }

  /**
   * Discover the agent-lsp binary path.
   * Checks the bundled resources/bin/agent-lsp first, then falls back to system PATH.
   * If a custom binaryPath was provided in the constructor, uses that directly.
   * @returns {string|null} Resolved binary path, or null if not found
   */
  _findBinary() {
    // If a custom path was explicitly provided, check it directly
    if (this._binaryPath) {
      try {
        fs.accessSync(this._binaryPath, fs.constants.X_OK);
        return this._binaryPath;
      } catch {
        return null;
      }
    }

    // 1. Check bundled binary in resources/bin/agent-lsp
    try {
      fs.accessSync(BUNDLED_BINARY_PATH, fs.constants.X_OK);
      return BUNDLED_BINARY_PATH;
    } catch {
      // Not found in bundled location, fall through
    }

    // 2. Fall back to system PATH via `which`
    try {
      const resolved = execSync(`which ${BINARY_NAME}`, { encoding: 'utf8', timeout: 5000 }).trim();
      if (resolved) return resolved;
    } catch {
      // Not found on PATH
    }

    return null;
  }

  /**
   * Detect installed language servers on the system PATH.
   * Scans for known language server binaries and returns the list of found ones.
   * @returns {string[]} Array of detected language server binary names
   */
  _detectLanguageServers() {
    const found = [];
    for (const server of KNOWN_LANGUAGE_SERVERS) {
      try {
        execSync(`which ${server}`, { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
        found.push(server);
      } catch {
        // Not found on PATH, skip
      }
    }
    return found;
  }

  /**
   * Spawn the agent-lsp process for the given project directory.
   * Transitions: stopped → starting → ready (or error/degraded).
   *
   * @param {string} projectDir - Absolute path to the project root
   */
  async start(projectDir) {
    // --- Binary discovery ---
    const binaryPath = this._findBinary();
    if (!binaryPath) {
      console.info('[LspManager] agent-lsp binary not found; staying stopped');
      this._setStatus('stopped');
      return;
    }

    this._setStatus('starting');
    this._projectDir = projectDir;

    // --- Language server detection ---
    const detectedServers = this._detectLanguageServers();
    this._servers = detectedServers.map((name) => ({
      name,
      languages: LANGUAGE_SERVER_LANGUAGES[name] || [],
    }));

    if (detectedServers.length === 0) {
      console.warn('[LspManager] No language servers found on PATH; status will be degraded');
    }

    // --- Build spawn arguments ---
    // agent-lsp auto-detects language servers when run with no args.
    // Pass the project directory via env so it indexes the right workspace.
    const spawnEnv = { ...process.env }
    if (projectDir) {
      spawnEnv.AGENT_LSP_PROJECT = projectDir
    }

    // --- Spawn the process ---
    try {
      const proc = spawn(binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: projectDir || process.cwd(),
        env: spawnEnv,
      });

      this._process = proc;
      this._startedAt = Date.now();

      // --- stdout: line-buffered JSON-RPC response reader ---
      let stdoutBuffer = '';
      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        let newlineIdx;
        while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
          const line = stdoutBuffer.slice(0, newlineIdx).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            // Skip server-sent notifications (no id)
            if (msg.id == null) continue;
            // Route id=0 to the init handler during startup
            if (msg.id === 0 && this._initHandler) {
              this._initHandler(msg);
              continue;
            }
            if (this._pendingRequests.has(msg.id)) {
              const pending = this._pendingRequests.get(msg.id);
              this._pendingRequests.delete(msg.id);
              if (msg.error) {
                pending.reject(new Error(msg.error.message || 'JSON-RPC error'));
              } else {
                pending.resolve(msg.result);
              }
            }
          } catch {
            console.warn('[LspManager] Failed to parse stdout line:', line);
          }
        }
      });

      // --- stderr: logging ---
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString().trim();
        if (text) {
          console.error('[agent-lsp stderr]', text);
        }
      });

      // --- Handle spawn error ---
      proc.on('error', (err) => {
        console.error('[LspManager] Spawn error:', err.message);
        this._process = null;
        this._startedAt = null;
        // Reject all pending requests
        for (const [id, pending] of this._pendingRequests) {
          pending.reject(new Error('agent-lsp process error'));
          this._pendingRequests.delete(id);
        }
        this._setStatus('error');
        this.emit('error', { message: err.message });
      });

      // --- Handle process exit ---
      proc.on('close', (code, signal) => {
        // Only handle if this is still the active process
        if (this._process !== proc) return;
        this._stopHealthCheck();
        this._process = null;
        this._startedAt = null;
        // Reject all pending requests
        for (const [id, pending] of this._pendingRequests) {
          pending.reject(new Error(`agent-lsp exited (code=${code}, signal=${signal})`));
          this._pendingRequests.delete(id);
        }
        if (!this._stopping && (this._status === 'ready' || this._status === 'starting' || this._status === 'degraded')) {
          console.warn(`[LspManager] agent-lsp exited unexpectedly (code=${code}, signal=${signal})`);
          this._handleUnexpectedExit();
        }
      });

      // --- MCP initialization handshake ---
      // agent-lsp requires initialize → notifications/initialized before tools/call
      await new Promise((resolve, reject) => {
        const initTimeout = setTimeout(() => reject(new Error('MCP init timed out')), 10000);

        // Wait for the initialize response
        const onceReady = (msg) => {
          if (msg.id === 0 && msg.result) {
            clearTimeout(initTimeout);
            // Send initialized notification
            const notif = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
            proc.stdin.write(notif + '\n');
            resolve();
          } else if (msg.id === 0 && msg.error) {
            clearTimeout(initTimeout);
            reject(new Error(msg.error.message || 'MCP init failed'));
          }
        };
        this._initHandler = onceReady;

        // Send initialize
        const initMsg = JSON.stringify({
          jsonrpc: '2.0', id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'qwencoder-mac-studio', version: '1.0' },
          },
        });
        proc.stdin.write(initMsg + '\n');
      });
      this._initHandler = null;

      // Transition to ready (or degraded if no language servers detected)
      if (detectedServers.length === 0) {
        this._setStatus('degraded');
      } else {
        this._setStatus('ready');
      }

      // Reset restart count on successful start (only for fresh starts, not auto-restarts)
      if (!this._restarting) {
        this._restartCount = 0;
      }
      this._restarting = false;
      this._startHealthCheck();
    } catch (err) {
      console.error('[LspManager] Failed to spawn agent-lsp:', err.message);
      this._process = null;
      this._startedAt = null;
      this._setStatus('error');
      this.emit('error', { message: err.message });
    }
  }

  /**
   * Gracefully stop the agent-lsp process.
   * Sends SIGTERM, waits up to 5s, then SIGKILL if still alive.
   * Clears health timer, pending requests, and resets state.
   */
  async stop() {
    this._stopping = true;
    this._stopHealthCheck();

    // Clear any pending restart timer
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }

    const proc = this._process;
    if (proc) {
      // Reject all pending requests
      for (const [id, pending] of this._pendingRequests) {
        pending.reject(new Error('LSP manager is shutting down'));
        this._pendingRequests.delete(id);
      }

      await new Promise((resolve) => {
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        }, 5000);

        proc.once('close', () => {
          clearTimeout(killTimer);
          resolve();
        });

        try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      });

      this._process = null;
      this._startedAt = null;
    }

    this._setStatus('stopped');
    this._stopping = false;
  }

  /**
   * Restart the agent-lsp process.
   * Calls stop() then start() with the given or previously used project directory.
   * @param {string} [projectDir] - Project directory (defaults to the last used one)
   */
  async restart(projectDir) {
    await this.stop();
    await this.start(projectDir || this._projectDir);
  }

  /**
   * Start periodic health-check pings to the agent-lsp process.
   * Sends a ping via call() every healthCheckInterval ms.
   * If the ping fails, logs a warning.
   */
  _startHealthCheck() {
    this._stopHealthCheck();
    this._healthTimer = setInterval(async () => {
      try {
        await this.call('lsp_get_diagnostics', { path: this._projectDir || '.' });
      } catch (err) {
        console.warn('[LspManager] Health check failed:', err.message);
      }
    }, this._healthCheckInterval);
    // Allow the process to exit even if the timer is still running
    if (this._healthTimer.unref) {
      this._healthTimer.unref();
    }
  }

  /**
   * Stop the periodic health-check timer.
   */
  _stopHealthCheck() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  /**
   * Handle an unexpected process exit.
   * If restarts remain, schedule a restart with exponential backoff.
   * Otherwise, set status to error.
   */
  _handleUnexpectedExit() {
    if (this._restartCount < this._maxRestarts) {
      const backoffDelay = Math.pow(2, this._restartCount + 1) * 1000; // 2s, 4s, 8s
      this._restartCount++;
      console.info(`[LspManager] Scheduling restart ${this._restartCount}/${this._maxRestarts} in ${backoffDelay}ms`);
      this._setStatus('starting');
      this._restartTimer = setTimeout(() => {
        this._restartTimer = null;
        this._restarting = true;
        this.start(this._projectDir).catch((err) => {
          console.error('[LspManager] Restart failed:', err.message);
          this._setStatus('error');
          this.emit('error', { message: err.message });
        });
      }, backoffDelay);
    } else {
      console.error(`[LspManager] Max restarts (${this._maxRestarts}) reached; giving up`);
      this._setStatus('error');
    }
  }

  /**
   * Send a JSON-RPC tool call to the agent-lsp process and return the result.
   * Throws if the process is not running, on JSON-RPC error, or on 30s timeout.
   *
   * @param {string} toolName - The tool name (e.g. 'lsp_get_document_symbols')
   * @param {object} [args={}] - Arguments to pass to the tool
   * @returns {Promise<*>} Parsed result from the JSON-RPC response
   */
  async call(toolName, args = {}) {
    if (this._status !== 'ready' && this._status !== 'degraded') {
      throw new Error(`LSP not available (status: ${this._status})`);
    }

    const id = this._requestId++;
    const request = {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`LSP tool timed out after 30s: ${toolName}`));
      }, 30000);

      this._pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this._process.stdin.write(JSON.stringify(request) + '\n');
    });
  }
}

module.exports = { LspManager, LSP_STATUSES, KNOWN_LANGUAGE_SERVERS, LANGUAGE_SERVER_LANGUAGES, BUNDLED_BINARY_PATH };
