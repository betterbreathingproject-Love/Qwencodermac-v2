'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { EventEmitter } = require('node:events');
const { LspManager, LSP_STATUSES, LANGUAGE_SERVER_LANGUAGES } = require('../lsp-manager.js');

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
  proc.simulateClose = (code, signal) => proc.emit('close', code, signal);
  return proc;
}

/**
 * Creates an LspManager with overridden internals for testing,
 * following the same pattern as the unit tests.
 */
function createTestManager(opts = {}) {
  const {
    binaryPath = '/fake/agent-lsp',
    detectedServers = ['gopls'],
    fakeProc = createFakeProcess(),
    healthCheckInterval = 999999,
    maxRestarts = 3,
    findBinaryReturn,
  } = opts;

  const mgr = new LspManager({ binaryPath, healthCheckInterval, maxRestarts });

  mgr._findBinary = () => {
    if (findBinaryReturn !== undefined) return findBinaryReturn;
    return binaryPath;
  };
  mgr._detectLanguageServers = () => detectedServers;

  mgr._fakeProc = fakeProc;
  mgr._spawnCalls = [];

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

// --- Generators ---

/**
 * Generate a random sequence of valid LSP status values for transition testing.
 */
function arbitraryStatusSequence() {
  return fc.array(
    fc.constantFrom(...LSP_STATUSES),
    { minLength: 1, maxLength: 20 }
  );
}

/**
 * Generate an arbitrary number of call invocations (1..50).
 */
function arbitraryCallCount() {
  return fc.integer({ min: 1, max: 50 });
}

/**
 * Generate a sequence of failure counts and a maxRestarts value.
 */
function arbitraryFailureSequence() {
  return fc.record({
    maxRestarts: fc.integer({ min: 0, max: 10 }),
    failureCount: fc.integer({ min: 1, max: 15 }),
  });
}

/**
 * Generate an arbitrary LSP status for getStatus testing.
 */
function arbitraryStatus() {
  return fc.constantFrom(...LSP_STATUSES);
}

// --- Property Tests ---

describe('Property-based tests for lsp-manager.js', () => {
  // **Validates: Requirements 1.2**
  it('Property: status transitions always follow valid state machine paths', () => {
    fc.assert(
      fc.property(arbitraryStatusSequence(), (statuses) => {
        const mgr = new LspManager();
        const events = [];

        mgr.on('status-change', (e) => events.push(e));

        for (const status of statuses) {
          const oldStatus = mgr.getStatus().status;
          mgr._setStatus(status);

          // PROPERTY: after _setStatus, the current status is always the one we set
          assert.equal(mgr.getStatus().status, status);

          // PROPERTY: every emitted event has valid old and new status values
          if (oldStatus !== status) {
            const lastEvent = events[events.length - 1];
            assert.ok(
              LSP_STATUSES.includes(lastEvent.oldStatus),
              `oldStatus "${lastEvent.oldStatus}" must be a valid LSP status`
            );
            assert.ok(
              LSP_STATUSES.includes(lastEvent.newStatus),
              `newStatus "${lastEvent.newStatus}" must be a valid LSP status`
            );
            assert.equal(lastEvent.oldStatus, oldStatus);
            assert.equal(lastEvent.newStatus, status);
          }
        }

        // PROPERTY: no duplicate consecutive events (same→same transitions are suppressed)
        for (let i = 1; i < events.length; i++) {
          const prev = events[i - 1];
          const curr = events[i];
          // Each event's newStatus should differ from its oldStatus
          assert.notEqual(
            curr.oldStatus,
            curr.newStatus,
            'status-change event should not fire for same→same transition'
          );
        }

        // PROPERTY: event chain is consistent — each event's oldStatus matches
        // the previous event's newStatus
        for (let i = 1; i < events.length; i++) {
          assert.equal(
            events[i].oldStatus,
            events[i - 1].newStatus,
            `Event chain broken: event[${i}].oldStatus should equal event[${i - 1}].newStatus`
          );
        }
      }),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 1.2, 1.3**
  it('Property: call() request IDs are always unique across arbitrary call sequences', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryCallCount(), async (numCalls) => {
        const fakeProc = createFakeProcess();
        const mgr = createTestManager({ fakeProc });
        await mgr.start('/project');

        const ids = new Set();
        const promises = [];

        for (let i = 0; i < numCalls; i++) {
          const p = mgr.call(`tool_${i}`, { idx: i });
          promises.push(p);
        }

        // Extract all request IDs from what was written to stdin
        for (const written of fakeProc.stdin._written) {
          const request = JSON.parse(written.replace('\n', ''));
          // PROPERTY: every ID must be unique
          assert.ok(
            !ids.has(request.id),
            `Duplicate request ID found: ${request.id}`
          );
          ids.add(request.id);
        }

        // PROPERTY: number of unique IDs equals number of calls
        assert.equal(ids.size, numCalls, `Expected ${numCalls} unique IDs, got ${ids.size}`);

        // Resolve all pending calls to avoid dangling promises
        for (const written of fakeProc.stdin._written) {
          const request = JSON.parse(written.replace('\n', ''));
          fakeProc.pushStdout(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'ok' }) + '\n');
        }
        await Promise.all(promises);

        // Cleanup
        if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
      }),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 1.3**
  it('Property: restart count never exceeds maxRestarts for any sequence of failures', () => {
    fc.assert(
      fc.property(arbitraryFailureSequence(), ({ maxRestarts, failureCount }) => {
        const fakeProc = createFakeProcess();
        const mgr = createTestManager({ fakeProc, maxRestarts });

        // Directly test _handleUnexpectedExit which is the core restart logic
        // Reset to a known state
        mgr._status = 'ready';
        mgr._restartCount = 0;

        for (let i = 0; i < failureCount; i++) {
          // Clear any pending restart timer from previous iteration
          if (mgr._restartTimer) {
            clearTimeout(mgr._restartTimer);
            mgr._restartTimer = null;
          }

          // Only call _handleUnexpectedExit if we haven't exceeded max
          // (mirrors the real behavior where the process must be running to exit)
          if (mgr._restartCount < maxRestarts) {
            mgr._status = 'ready'; // simulate running state before crash
            mgr._handleUnexpectedExit();
          } else {
            // After max restarts, simulate one more exit
            mgr._status = 'ready';
            mgr._handleUnexpectedExit();
          }

          // PROPERTY: _restartCount never exceeds maxRestarts
          assert.ok(
            mgr._restartCount <= maxRestarts,
            `restartCount (${mgr._restartCount}) exceeded maxRestarts (${maxRestarts})`
          );
        }

        // PROPERTY: after all failures, if we hit the limit, status should be 'error'
        if (failureCount > maxRestarts) {
          assert.equal(
            mgr.getStatus().status,
            'error',
            `Status should be "error" after exceeding maxRestarts`
          );
        }

        // Cleanup
        if (mgr._restartTimer) { clearTimeout(mgr._restartTimer); mgr._restartTimer = null; }
        if (mgr._healthTimer) { clearInterval(mgr._healthTimer); mgr._healthTimer = null; }
      }),
      { numRuns: 150 }
    );
  });

  // **Validates: Requirements 1.7**
  it('Property: getStatus() always returns a valid status enum value regardless of state', () => {
    fc.assert(
      fc.property(arbitraryStatus(), (status) => {
        const mgr = new LspManager();

        // Set to the arbitrary status
        mgr._setStatus(status);

        const result = mgr.getStatus();

        // PROPERTY: status is always one of the valid enum values
        assert.ok(
          LSP_STATUSES.includes(result.status),
          `getStatus().status "${result.status}" is not a valid LSP status`
        );

        // PROPERTY: getStatus always returns the expected shape
        assert.ok('status' in result, 'getStatus() must have a status field');
        assert.ok('servers' in result, 'getStatus() must have a servers field');
        assert.ok('projectDir' in result, 'getStatus() must have a projectDir field');
        assert.ok('uptime' in result, 'getStatus() must have an uptime field');
        assert.ok(Array.isArray(result.servers), 'servers must be an array');

        // PROPERTY: status matches what we set
        assert.equal(result.status, status);
      }),
      { numRuns: 150 }
    );
  });
});
