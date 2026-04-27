'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

describe('IPC Integration Smoke Tests', () => {
  describe('6.7.1 Verify all new IPC channels are exposed in preload.js', () => {
    const fs = require('node:fs');
    const preloadSource = fs.readFileSync(require('node:path').join(__dirname, '..', 'preload.js'), 'utf-8');

    const expectedChannels = [
      // Task graph operations
      { method: 'taskGraphParse', channel: 'task-graph-parse' },
      { method: 'taskGraphExecute', channel: 'task-graph-execute' },
      { method: 'taskGraphPause', channel: 'task-graph-pause' },
      { method: 'taskGraphResume', channel: 'task-graph-resume' },
      { method: 'taskGraphStatus', channel: 'task-graph-status' },
      // Background task operations
      { method: 'bgTaskList', channel: 'bg-task-list' },
      { method: 'bgTaskCancel', channel: 'bg-task-cancel' },
      { method: 'bgTaskOutput', channel: 'bg-task-output' },
      // AST search operations
      { method: 'astSearch', channel: 'ast-search' },
      { method: 'astPatterns', channel: 'ast-patterns' },
      { method: 'astSearchStatus', channel: 'ast-search-status' },
      // Spec workflow operations
      { method: 'specInit', channel: 'spec-init' },
      { method: 'specPhase', channel: 'spec-phase' },
      { method: 'specAdvance', channel: 'spec-advance' },
      // Event listeners
      { method: 'onTaskStatusEvent', channel: 'task-status-event' },
      { method: 'onBgTaskEvent', channel: 'bg-task-event' },
    ];

    for (const { method, channel } of expectedChannels) {
      it(`exposes ${method} binding for '${channel}' channel`, () => {
        assert.ok(
          preloadSource.includes(method),
          `preload.js should expose '${method}' method`
        );
        assert.ok(
          preloadSource.includes(channel),
          `preload.js should reference '${channel}' IPC channel`
        );
      });
    }
  });

  describe('6.7.2 Verify AST search tool is registered in Agent Pool for code-search and implementation types', () => {
    const { AgentPool, CATEGORY_KEYWORDS } = require('../agent-pool.js');

    it('code-search category keywords include search-related terms', () => {
      assert.ok(CATEGORY_KEYWORDS['code-search'], 'code-search category should exist');
      assert.ok(CATEGORY_KEYWORDS['code-search'].some(kw => ['search', 'ast', 'find', 'grep'].includes(kw)),
        'code-search keywords should include search-related terms');
    });

    it('implementation category keywords include implementation-related terms', () => {
      assert.ok(CATEGORY_KEYWORDS['implementation'], 'implementation category should exist');
      assert.ok(CATEGORY_KEYWORDS['implementation'].some(kw => ['implement', 'code', 'build'].includes(kw)),
        'implementation keywords should include implementation-related terms');
    });

    it('AgentPool selects code-search type for search tasks', () => {
      const pool = new AgentPool();
      pool.registerType({ name: 'code-search', systemPrompt: 'search', allowedTools: ['ast-search'] });
      pool.registerType({ name: 'implementation', systemPrompt: 'impl', allowedTools: ['ast-search'] });
      pool.registerType({ name: 'general', systemPrompt: 'general', allowedTools: [] });

      const task = { id: '1', title: 'Search for all async functions', status: 'not_started', dependencies: [], children: [], parent: null, markers: { start: false, branch: null, terminal: false, loop: null }, parallel: false, metadata: {}, depth: 0 };
      const selected = pool.selectType(task);
      assert.equal(selected.name, 'code-search');
    });

    it('AgentPool selects implementation type for implementation tasks', () => {
      const pool = new AgentPool();
      pool.registerType({ name: 'code-search', systemPrompt: 'search', allowedTools: ['ast-search'] });
      pool.registerType({ name: 'implementation', systemPrompt: 'impl', allowedTools: ['ast-search'] });
      pool.registerType({ name: 'general', systemPrompt: 'general', allowedTools: [] });

      const task = { id: '2', title: 'Implement the login feature', status: 'not_started', dependencies: [], children: [], parent: null, markers: { start: false, branch: null, terminal: false, loop: null }, parallel: false, metadata: {}, depth: 0 };
      const selected = pool.selectType(task);
      assert.equal(selected.name, 'implementation');
    });

    it('AST search module exports are available', () => {
      const astSearch = require('../ast-search.js');
      assert.equal(typeof astSearch.astSearch, 'function');
      assert.equal(typeof astSearch.getSupportedPatterns, 'function');
      assert.equal(typeof astSearch.getSearchStatus, 'function');
      assert.equal(typeof astSearch.validatePattern, 'function');
    });
  });
});


describe('Calibration IPC Integration Tests', () => {
  // Mock ipcMain that collects registered handlers
  function createMockIpcMain() {
    const handlers = {};
    return {
      handle(channel, fn) { handlers[channel] = fn; },
      invoke(channel, ...args) {
        if (!handlers[channel]) throw new Error(`No handler for ${channel}`);
        return handlers[channel]({}, ...args);
      },
      _handlers: handlers,
    };
  }

  // Import modules under test
  const calibrator = require('../calibrator');
  const ipcCalibration = require('../main/ipc-calibration');
  const ipcServer = require('../main/ipc-server');

  const sampleMetrics = {
    generation_tps: 42.5,
    prompt_tps: 120.3,
    peak_memory_gb: 6.123,
    available_memory_gb: 10.456,
    context_window: 32768,
  };

  describe('get-calibration returns null before model load', () => {
    it('returns null when no calibration has been performed', async () => {
      ipcServer.clearCalibration();

      const mockIpc = createMockIpcMain();
      ipcCalibration.register(mockIpc, {
        getCalibrationProfile: ipcServer.getCalibrationProfile,
        isCalibrating: ipcServer.isCalibrating,
      });

      const result = await mockIpc.invoke('get-calibration');
      assert.equal(result, null);
    });
  });

  describe('get-calibration returns profile after calibration', () => {
    it('returns the computed profile after runCalibration succeeds', async (t) => {
      ipcServer.clearCalibration();

      // Create a minimal HTTP server that returns benchmark metrics
      const http = require('node:http');
      const server = http.createServer((req, res) => {
        if (req.url === '/admin/benchmark' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(sampleMetrics));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      try {
        await ipcServer.runCalibration(`http://127.0.0.1:${port}`, port, null, 'test-model');

        const mockIpc = createMockIpcMain();
        ipcCalibration.register(mockIpc, {
          getCalibrationProfile: ipcServer.getCalibrationProfile,
          isCalibrating: ipcServer.isCalibrating,
        });

        const result = await mockIpc.invoke('get-calibration');
        assert.notEqual(result, null);
        assert.equal(result.maxTurns, 500);
        assert.equal(typeof result.timeoutPerTurn, 'number');
        assert.equal(typeof result.maxInputTokens, 'number');
        assert.equal(typeof result.compactionThreshold, 'number');
        assert.equal(typeof result.poolTimeout, 'number');
        assert.ok(result.metrics);
      } finally {
        server.close();
      }
    });
  });

  describe('calibration-complete event includes modelId', () => {
    it('emits calibration-complete with modelId and profile', async () => {
      ipcServer.clearCalibration();

      const http = require('node:http');
      const server = http.createServer((req, res) => {
        if (req.url === '/admin/benchmark' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(sampleMetrics));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      const events = [];
      const mockWindow = {
        webContents: {
          send(channel, data) { events.push({ channel, data }); },
        },
      };

      try {
        await ipcServer.runCalibration(`http://127.0.0.1:${port}`, port, mockWindow, 'my-model-id');

        const completeEvent = events.find(e => e.channel === 'calibration-complete');
        assert.ok(completeEvent, 'calibration-complete event should be emitted');
        assert.equal(completeEvent.data.modelId, 'my-model-id');
        assert.ok(completeEvent.data.profile);
        assert.equal(completeEvent.data.profile.maxTurns, 500);
      } finally {
        server.close();
      }
    });
  });

  describe('fallback to default profile on benchmark failure', () => {
    it('uses defaultProfile when benchmark endpoint returns an error', async () => {
      ipcServer.clearCalibration();

      const http = require('node:http');
      const server = http.createServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Metal memory error' }));
      });

      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      const events = [];
      const mockWindow = {
        webContents: {
          send(channel, data) { events.push({ channel, data }); },
        },
      };

      try {
        await ipcServer.runCalibration(`http://127.0.0.1:${port}`, port, mockWindow, 'fail-model');

        const profile = ipcServer.getCalibrationProfile();
        const expected = calibrator.defaultProfile();
        assert.deepStrictEqual(profile, expected);

        const completeEvent = events.find(e => e.channel === 'calibration-complete');
        assert.ok(completeEvent, 'calibration-complete should still be emitted on fallback');
        assert.equal(completeEvent.data.fallback, true);
        assert.equal(completeEvent.data.modelId, 'fail-model');
      } finally {
        server.close();
      }
    });
  });

  describe('profile cleared on model unload', () => {
    it('clearCalibration sets profile to null', async () => {
      // First set up a profile
      const http = require('node:http');
      const server = http.createServer((req, res) => {
        if (req.url === '/admin/benchmark' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(sampleMetrics));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      try {
        await ipcServer.runCalibration(`http://127.0.0.1:${port}`, port, null, 'unload-test');
        assert.notEqual(ipcServer.getCalibrationProfile(), null);

        // Simulate model unload
        ipcServer.clearCalibration();
        assert.equal(ipcServer.getCalibrationProfile(), null);

        // Verify via IPC handler too
        const mockIpc = createMockIpcMain();
        ipcCalibration.register(mockIpc, {
          getCalibrationProfile: ipcServer.getCalibrationProfile,
          isCalibrating: ipcServer.isCalibrating,
        });

        const result = await mockIpc.invoke('get-calibration');
        assert.equal(result, null);

        const status = await mockIpc.invoke('calibration-status');
        assert.equal(status.status, 'unavailable');
        assert.equal(status.profile, null);
      } finally {
        server.close();
      }
    });
  });
});
