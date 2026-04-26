'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LspManager, LSP_STATUSES, KNOWN_LANGUAGE_SERVERS, LANGUAGE_SERVER_LANGUAGES, BUNDLED_BINARY_PATH } = require('../lsp-manager.js');

// --- Helpers ---

/**
 * Creates a fake child process with EventEmitter + mock stdio streams.
 */
function createFakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = {
    _written: [],
    write(data) { proc.stdin._written.push(data); },
  };
  proc.pid = 12345;
  proc._killed = [];
  proc.kill = (signal) => { proc._killed.push(signal); };

  proc.pushStdout = (data) => proc.stdout.emit('data', Buffer.from(data));
  proc.pushStderr = (data) => proc.stderr.emit('data', Buffer.from(data));
  proc.simulateClose = (code, signal) => proc.emit('close', code, signal);
  proc.simulateError = (msg) => proc.emit('error', new Error(msg));

  return proc;
}

/**
 * Creates an LspManager with _findBinary and _detectLanguageServers overridden,
 * and start() patched to use a fake spawn. This avoids needing to mock
 * module-level destructured imports (fs.accessSync, execSync, spawn).
 */
function createTestManager(opts = {}) {
  const {
    binaryPath = '/fake/agent-lsp',
    detectedServers = ['gopls'],
    fakeProc = createFakeProcess(),
    healthCheckInterval = 999999,
    maxRestarts = 3,
    findBinaryReturn, // override: null means not found, string means found
  } = opts;

  const mgr = new LspManager({ binaryPath, healthCheckInterval, maxRestarts });

  // Override _findBinary
  mgr._findBinary = () => {
    if (findBinaryReturn !== undefined) return findBinaryReturn;
    return binaryPath;
  };

  // Override _detectLanguageServers
  mgr._detectLanguageServers = () => detectedServers;

  // Patch start() to use fakeProc instead of real spawn
  const origStart = mgr.start.bind(mgr);
  mgr._fakeProc = fakeProc;
  mgr._spawnCalls = [];

  // We need to intercept the spawn call inside start().
  // Since spawn is a module-level destructured import, we override start() to
  // inject our fake process. We replicate the start() logic but with fakeProc.
  mgr.start = async function startWithFakeSpawn(projectDir) {
    const bp = this._findBinary();
    if (!bp) {
      this._setStatus('stopped');
      return;
    }

    this._setStatus('starting');
    this._projectDir = projectDir;

    const detected = this._detectLanguageServers();
    this._servers = detected.map((name) => ({
      name,
      languages: LANGUAGE_SERVER_LANGUAGES[name] || [],
    }));

    const args = ['--stdio'];
    if (projectDir) args.push('--project', projectDir);
    for (const s of detected) args.push('--server', s);

    try {
      const proc = this._fakeProc;
      this._spawnCalls.push({ binaryPath: bp, args, projectDir });

      this._process = proc;
      this._startedAt = Date.now();

      let stdoutBuffer = '';
      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        let idx;
        while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
          const line = stdoutBuffer.slice(0, idx).trim();
          stdoutBuffer = stdoutBuffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id != null && this._pendingRequests.has(msg.id)) {
              const pending = this._pendingRequests.get(msg.id);
              this._pendingRequests.delete(msg.id);
              if (msg.error) {
                pending.reject(new Error(msg.error.message || 'JSON-RPC error'));
              } else {
                pending.resolve(msg.result);
              }
            }
          } catch { /* ignore parse errors */ }
        }
      });

      proc.stderr.on('data', () => {});

      proc.on('error', (err) => {
        this._process = null;
        this._startedAt = null;
        for (const [id, pending] of this._pendingRequests) {
          pending.reject(new Error('agent-lsp process error'));
          this._pendingRequests.delete(id);
        }
        this._setStatus('error');
        this.emit('error', { message: err.message });
      });

      proc.on('close', (code, signal) => {
        if (this._process !== proc) return;
        this._stopHealthCheck();
        this._process = null;
        this._startedAt = null;
        for (const [id, pending] of this._pendingRequests) {
          pending.reject(new Error(`agent-lsp exited (code=${code}, signal=${signal})`));
          this._pendingRequests.delete(id);
        }
        if (!this._stopping && (this._status === 'ready' || this._status === 'starting' || this._status === 'degraded')) {
          this._handleUnexpectedExit();
        }
      });

      if (detected.length === 0) {
        this._setStatus('degraded');
      } else {
        this._setStatus('ready');
      }

      if (!this._restarting) {
        this._restartCount = 0;
      }
      this._restarting = false;
      this._startHealthCheck();
    } catch (err) {
      this._process = null;
      this._startedAt = null;
      this._setStatus('error');
      this.emit('error', { message: err.message });
    }
  };

  return mgr;
}

// --- Task 1.1: Constructor, status enum, EventEmitter base ---

describe('LspManager - constructor and status', () => {
  let mgr;

  beforeEach(() => {
    mgr = new LspManager();
  });

  it('exports LSP_STATUSES array with all valid statuses', () => {
    assert.deepStrictEqual(LSP_STATUSES, ['stopped', 'starting', 'ready', 'error', 'degraded']);
  });

  it('is an EventEmitter', () => {
    assert.ok(mgr instanceof EventEmitter);
  });

  it('defaults to stopped status', () => {
    assert.equal(mgr.getStatus().status, 'stopped');
  });

  it('defaults servers to empty array', () => {
    assert.deepStrictEqual(mgr.getStatus().servers, []);
  });

  it('defaults projectDir to null', () => {
    assert.equal(mgr.getStatus().projectDir, null);
  });

  it('defaults uptime to null when not started', () => {
    assert.equal(mgr.getStatus().uptime, null);
  });

  it('accepts custom options', () => {
    const custom = new LspManager({
      binaryPath: '/usr/local/bin/agent-lsp',
      healthCheckInterval: 10000,
      maxRestarts: 5,
    });
    assert.equal(custom._binaryPath, '/usr/local/bin/agent-lsp');
    assert.equal(custom._healthCheckInterval, 10000);
    assert.equal(custom._maxRestarts, 5);
  });

  it('uses sensible defaults when no options provided', () => {
    assert.equal(mgr._binaryPath, null);
    assert.equal(mgr._healthCheckInterval, 30000);
    assert.equal(mgr._maxRestarts, 3);
  });

  it('getStatus returns a copy of servers array', () => {
    const s1 = mgr.getStatus();
    const s2 = mgr.getStatus();
    assert.notStrictEqual(s1.servers, s2.servers);
  });
});

describe('LspManager - _setStatus', () => {
  let mgr;

  beforeEach(() => {
    mgr = new LspManager();
  });

  it('transitions status and emits status-change event', () => {
    const events = [];
    mgr.on('status-change', (e) => events.push(e));
    mgr._setStatus('starting');
    assert.equal(mgr.getStatus().status, 'starting');
    assert.equal(events.length, 1);
    assert.deepStrictEqual(events[0], { oldStatus: 'stopped', newStatus: 'starting' });
  });

  it('does not emit when status is unchanged', () => {
    const events = [];
    mgr.on('status-change', (e) => events.push(e));
    mgr._setStatus('stopped');
    assert.equal(events.length, 0);
  });

  it('throws on invalid status value', () => {
    assert.throws(() => mgr._setStatus('invalid'), /Invalid LSP status/);
  });

  it('tracks multiple transitions', () => {
    const events = [];
    mgr.on('status-change', (e) => events.push(e));
    mgr._setStatus('starting');
    mgr._setStatus('ready');
    mgr._setStatus('error');
    assert.equal(events.length, 3);
    assert.equal(events[0].newStatus, 'starting');
    assert.equal(events[1].newStatus, 'ready');
    assert.equal(events[2].newStatus, 'error');
  });
});


// --- Task 1.6: Binary discovery ---

describe('LspManager - _findBinary (via start behavior)', () => {
  it('stays stopped when binary not found', async () => {
    const mgr = createTestManager({ findBinaryReturn: null });
    await mgr.start('/project');
    assert.equal(mgr.getStatus().status, 'stopped');
  });

  it('proceeds to starting when binary is found', async () => {
    const events = [];
    const mgr = createTestManager({ findBinaryReturn: '/found/agent-lsp' });
    mgr.on('status-change', (e) => events.push(e));
    await mgr.start('/project');
    assert.ok(events.some((e) => e.newStatus === 'starting'));
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('uses bundled path constant', () => {
    // Verify BUNDLED_BINARY_PATH is exported and points to resources/bin/agent-lsp
    assert.ok(BUNDLED_BINARY_PATH.endsWith('resources/bin/agent-lsp'));
  });
});

// --- Task 1.6: Language server detection ---

describe('LspManager - _detectLanguageServers (via start behavior)', () => {
  it('populates servers when language servers detected', async () => {
    const mgr = createTestManager({ detectedServers: ['gopls', 'pyright'] });
    await mgr.start('/project');
    const servers = mgr.getStatus().servers;
    assert.equal(servers.length, 2);
    assert.deepStrictEqual(servers[0], { name: 'gopls', languages: ['go'] });
    assert.deepStrictEqual(servers[1], { name: 'pyright', languages: ['python'] });
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('sets status to degraded when no language servers found', async () => {
    const mgr = createTestManager({ detectedServers: [] });
    await mgr.start('/project');
    assert.equal(mgr.getStatus().status, 'degraded');
    assert.deepStrictEqual(mgr.getStatus().servers, []);
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('maps language server names to correct languages', () => {
    assert.deepStrictEqual(LANGUAGE_SERVER_LANGUAGES['gopls'], ['go']);
    assert.deepStrictEqual(LANGUAGE_SERVER_LANGUAGES['typescript-language-server'], ['javascript', 'typescript']);
    assert.deepStrictEqual(LANGUAGE_SERVER_LANGUAGES['pyright'], ['python']);
    assert.deepStrictEqual(LANGUAGE_SERVER_LANGUAGES['rust-analyzer'], ['rust']);
    assert.deepStrictEqual(LANGUAGE_SERVER_LANGUAGES['clangd'], ['c', 'cpp']);
    assert.deepStrictEqual(LANGUAGE_SERVER_LANGUAGES['jdtls'], ['java']);
  });

  it('exports KNOWN_LANGUAGE_SERVERS list', () => {
    assert.ok(Array.isArray(KNOWN_LANGUAGE_SERVERS));
    assert.ok(KNOWN_LANGUAGE_SERVERS.includes('gopls'));
    assert.ok(KNOWN_LANGUAGE_SERVERS.includes('typescript-language-server'));
    assert.ok(KNOWN_LANGUAGE_SERVERS.includes('pyright'));
  });
});


// --- Task 1.6: Status transitions ---

describe('LspManager - start() status transitions', () => {
  afterEach(function () {
    // Cleanup is handled per-test via mgr reference
  });

  it('transitions stopped → starting → ready with language servers', async () => {
    const mgr = createTestManager({ detectedServers: ['gopls'] });
    const events = [];
    mgr.on('status-change', (e) => events.push(e));

    await mgr.start('/project');

    assert.equal(mgr.getStatus().status, 'ready');
    assert.equal(events.length, 2);
    assert.deepStrictEqual(events[0], { oldStatus: 'stopped', newStatus: 'starting' });
    assert.deepStrictEqual(events[1], { oldStatus: 'starting', newStatus: 'ready' });
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('transitions stopped → starting → degraded when no language servers', async () => {
    const mgr = createTestManager({ detectedServers: [] });
    const events = [];
    mgr.on('status-change', (e) => events.push(e));

    await mgr.start('/project');

    assert.equal(mgr.getStatus().status, 'degraded');
    assert.deepStrictEqual(events[0], { oldStatus: 'stopped', newStatus: 'starting' });
    assert.deepStrictEqual(events[1], { oldStatus: 'starting', newStatus: 'degraded' });
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('stays stopped when binary not found', async () => {
    const mgr = createTestManager({ findBinaryReturn: null });
    await mgr.start('/project');
    assert.equal(mgr.getStatus().status, 'stopped');
  });

  it('sets projectDir on start', async () => {
    const mgr = createTestManager();
    await mgr.start('/my/project');
    assert.equal(mgr.getStatus().projectDir, '/my/project');
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('sets uptime after start', async () => {
    const mgr = createTestManager();
    await mgr.start('/project');
    const uptime = mgr.getStatus().uptime;
    assert.ok(typeof uptime === 'number');
    assert.ok(uptime >= 0);
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('transitions to error on spawn error event', async () => {
    const fakeProc = createFakeProcess();
    const mgr = createTestManager({ fakeProc });
    const errors = [];
    mgr.on('error', (e) => errors.push(e));

    await mgr.start('/project');
    assert.equal(mgr.getStatus().status, 'ready');

    fakeProc.simulateError('spawn ENOENT');

    assert.equal(mgr.getStatus().status, 'error');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'spawn ENOENT');
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('resets restart count on fresh start', async () => {
    const mgr = createTestManager();
    mgr._restartCount = 2;
    await mgr.start('/project');
    assert.equal(mgr._restartCount, 0);
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });
});


// --- Task 1.6: call() with mock stdio ---

describe('LspManager - call() with mock stdio', () => {
  let mgr;
  let fakeProc;

  beforeEach(async () => {
    fakeProc = createFakeProcess();
    mgr = createTestManager({ fakeProc });
    await mgr.start('/project');
  });

  afterEach(() => {
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
    if (mgr._restartTimer) { clearTimeout(mgr._restartTimer); mgr._restartTimer = null; }
  });

  it('sends JSON-RPC request and resolves on success response', async () => {
    const callPromise = mgr.call('lsp_get_document_symbols', { path: 'src/main.js' });

    const written = fakeProc.stdin._written[0];
    const request = JSON.parse(written.replace('\n', ''));
    assert.equal(request.jsonrpc, '2.0');
    assert.equal(request.method, 'tools/call');
    assert.deepStrictEqual(request.params, { name: 'get_document_symbols', arguments: { path: 'src/main.js' } });

    const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { symbols: ['fn1'] } }) + '\n';
    fakeProc.pushStdout(response);

    const result = await callPromise;
    assert.deepStrictEqual(result, { symbols: ['fn1'] });
  });

  it('rejects on JSON-RPC error response', async () => {
    const callPromise = mgr.call('lsp_bad_tool');

    const written = fakeProc.stdin._written[0];
    const request = JSON.parse(written.replace('\n', ''));

    const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n';
    fakeProc.pushStdout(response);

    await assert.rejects(callPromise, /Method not found/);
  });

  it('throws when status is not ready or degraded', async () => {
    mgr._setStatus('error');
    await assert.rejects(() => mgr.call('ping'), /LSP not available/);
  });

  it('allows call when status is degraded', async () => {
    mgr._setStatus('degraded');

    const callPromise = mgr.call('ping');
    const written = fakeProc.stdin._written[fakeProc.stdin._written.length - 1];
    const request = JSON.parse(written.replace('\n', ''));

    fakeProc.pushStdout(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'pong' }) + '\n');

    const result = await callPromise;
    assert.equal(result, 'pong');
  });

  it('increments request IDs for each call', async () => {
    const p1 = mgr.call('tool1');
    const p2 = mgr.call('tool2');

    const req1 = JSON.parse(fakeProc.stdin._written[0].replace('\n', ''));
    const req2 = JSON.parse(fakeProc.stdin._written[1].replace('\n', ''));

    assert.notEqual(req1.id, req2.id);
    assert.equal(req2.id, req1.id + 1);

    fakeProc.pushStdout(JSON.stringify({ jsonrpc: '2.0', id: req1.id, result: 'r1' }) + '\n');
    fakeProc.pushStdout(JSON.stringify({ jsonrpc: '2.0', id: req2.id, result: 'r2' }) + '\n');

    assert.equal(await p1, 'r1');
    assert.equal(await p2, 'r2');
  });

  it('handles multi-line buffered stdout responses', async () => {
    const p1 = mgr.call('tool1');
    const p2 = mgr.call('tool2');

    const req1 = JSON.parse(fakeProc.stdin._written[0].replace('\n', ''));
    const req2 = JSON.parse(fakeProc.stdin._written[1].replace('\n', ''));

    // Send both responses in a single chunk
    const combined = JSON.stringify({ jsonrpc: '2.0', id: req1.id, result: 'a' }) + '\n' +
                     JSON.stringify({ jsonrpc: '2.0', id: req2.id, result: 'b' }) + '\n';
    fakeProc.pushStdout(combined);

    assert.equal(await p1, 'a');
    assert.equal(await p2, 'b');
  });

  it('rejects all pending requests when process exits unexpectedly', async () => {
    mgr._maxRestarts = 0; // prevent restart attempts
    const p1 = mgr.call('tool1');
    const p2 = mgr.call('tool2');

    fakeProc.simulateClose(1, null);

    await assert.rejects(p1, /agent-lsp exited/);
    await assert.rejects(p2, /agent-lsp exited/);
  });

  it('rejects all pending requests on spawn error', async () => {
    // Must listen for 'error' event to prevent unhandled error
    mgr.on('error', () => {});
    const p1 = mgr.call('tool1');

    fakeProc.simulateError('spawn failed');

    await assert.rejects(p1, /agent-lsp process error/);
  });
});


// --- Task 1.6: Restart policy ---

describe('LspManager - restart policy', () => {
  it('schedules restart on unexpected exit', async () => {
    const fakeProc = createFakeProcess();
    const mgr = createTestManager({ fakeProc, maxRestarts: 3 });
    await mgr.start('/project');
    assert.equal(mgr.getStatus().status, 'ready');

    fakeProc.simulateClose(1, null);

    assert.equal(mgr.getStatus().status, 'starting');
    assert.equal(mgr._restartCount, 1);
    assert.ok(mgr._restartTimer !== null);

    // Cleanup
    clearTimeout(mgr._restartTimer);
    mgr._restartTimer = null;
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('uses exponential backoff: restart count increments correctly', async () => {
    // We test that _handleUnexpectedExit increments _restartCount each time
    const fakeProc1 = createFakeProcess();
    const mgr = createTestManager({ fakeProc: fakeProc1, maxRestarts: 3 });
    await mgr.start('/project');

    // First exit
    fakeProc1.simulateClose(1, null);
    assert.equal(mgr._restartCount, 1);
    clearTimeout(mgr._restartTimer);
    mgr._restartTimer = null;

    // Manually restart (simulating what the timer would do)
    const fakeProc2 = createFakeProcess();
    mgr._fakeProc = fakeProc2;
    mgr._restarting = true;
    await mgr.start('/project');

    // Second exit
    fakeProc2.simulateClose(1, null);
    assert.equal(mgr._restartCount, 2);
    clearTimeout(mgr._restartTimer);
    mgr._restartTimer = null;

    // Third restart
    const fakeProc3 = createFakeProcess();
    mgr._fakeProc = fakeProc3;
    mgr._restarting = true;
    await mgr.start('/project');

    // Third exit
    fakeProc3.simulateClose(1, null);
    assert.equal(mgr._restartCount, 3);
    clearTimeout(mgr._restartTimer);
    mgr._restartTimer = null;
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('sets status to error after max restarts exceeded', async () => {
    const fakeProc1 = createFakeProcess();
    const mgr = createTestManager({ fakeProc: fakeProc1, maxRestarts: 1 });
    await mgr.start('/project');

    // First exit — schedules restart
    fakeProc1.simulateClose(1, null);
    assert.equal(mgr._restartCount, 1);
    assert.equal(mgr.getStatus().status, 'starting');
    clearTimeout(mgr._restartTimer);
    mgr._restartTimer = null;

    // Manual restart
    const fakeProc2 = createFakeProcess();
    mgr._fakeProc = fakeProc2;
    mgr._restarting = true;
    await mgr.start('/project');

    // Second exit — max reached
    fakeProc2.simulateClose(1, null);
    assert.equal(mgr.getStatus().status, 'error');
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('does not restart when _stopping is true', async () => {
    const fakeProc = createFakeProcess();
    const mgr = createTestManager({ fakeProc, maxRestarts: 3 });
    await mgr.start('/project');

    mgr._stopping = true;
    fakeProc.simulateClose(0, 'SIGTERM');

    // Should NOT schedule a restart
    assert.equal(mgr._restartTimer, null);
    assert.equal(mgr._restartCount, 0);
    mgr._stopping = false;
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('resets restart count on fresh (non-restarting) start', async () => {
    const fakeProc = createFakeProcess();
    const mgr = createTestManager({ fakeProc, maxRestarts: 3 });
    mgr._restartCount = 2;
    mgr._restarting = false;

    await mgr.start('/project');
    assert.equal(mgr._restartCount, 0);
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });
});


// --- Task 1.6: stop() ---

describe('LspManager - stop()', () => {
  it('sends SIGTERM on graceful stop', async () => {
    const fakeProc = createFakeProcess();
    const mgr = createTestManager({ fakeProc });
    await mgr.start('/project');

    const stopPromise = mgr.stop();
    assert.ok(fakeProc._killed.includes('SIGTERM'));

    fakeProc.simulateClose(0, 'SIGTERM');
    await stopPromise;

    assert.equal(mgr.getStatus().status, 'stopped');
    if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
  });

  it('transitions to stopped after stop completes', async () => {
    const fakeProc = createFakeProcess();
    const mgr = createTestManager({ fakeProc });
    await mgr.start('/project');
    assert.equal(mgr.getStatus().status, 'ready');

    const stopPromise = mgr.stop();
    fakeProc.simulateClose(0, 'SIGTERM');
    await stopPromise;

    assert.equal(mgr.getStatus().status, 'stopped');
    assert.equal(mgr._process, null);
    assert.equal(mgr._startedAt, null);
  });

  it('rejects pending requests on stop', async () => {
    const fakeProc = createFakeProcess();
    const mgr = createTestManager({ fakeProc });
    await mgr.start('/project');

    const callPromise = mgr.call('lsp_get_symbols', { path: 'test.js' });

    const stopPromise = mgr.stop();
    fakeProc.simulateClose(0, 'SIGTERM');
    await stopPromise;

    await assert.rejects(callPromise, /shutting down/);
  });

  it('clears health timer on stop', async () => {
    const fakeProc = createFakeProcess();
    const mgr = createTestManager({ fakeProc, healthCheckInterval: 100 });
    await mgr.start('/project');
    // Manually set a health timer to verify it gets cleared
    mgr._stopHealthCheck();
    mgr._healthTimer = setInterval(() => {}, 100);
    assert.ok(mgr._healthTimer !== null);

    const stopPromise = mgr.stop();
    fakeProc.simulateClose(0, 'SIGTERM');
    await stopPromise;

    assert.equal(mgr._healthTimer, null);
  });

  it('clears pending restart timer on stop', async () => {
    const fakeProc = createFakeProcess();
    const mgr = createTestManager({ fakeProc, maxRestarts: 3 });
    await mgr.start('/project');

    // Trigger unexpected exit to schedule a restart
    fakeProc.simulateClose(1, null);
    assert.ok(mgr._restartTimer !== null);

    // Now stop — should clear the restart timer
    await mgr.stop();

    assert.equal(mgr._restartTimer, null);
    assert.equal(mgr.getStatus().status, 'stopped');
  });

  it('handles stop when no process is running', async () => {
    const mgr = createTestManager();
    // Don't start — process is null
    await mgr.stop();
    assert.equal(mgr.getStatus().status, 'stopped');
  });

  it('sets _stopping flag during shutdown', async () => {
    const fakeProc = createFakeProcess();
    const mgr = createTestManager({ fakeProc });
    await mgr.start('/project');

    let stoppingDuringShutdown = false;
    const origKill = fakeProc.kill;
    fakeProc.kill = (sig) => {
      stoppingDuringShutdown = mgr._stopping;
      origKill(sig);
    };

    const stopPromise = mgr.stop();
    fakeProc.simulateClose(0, 'SIGTERM');
    await stopPromise;

    assert.ok(stoppingDuringShutdown);
    assert.equal(mgr._stopping, false); // reset after stop
  });
});
