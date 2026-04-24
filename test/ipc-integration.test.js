'use strict';

const { describe, it } = require('node:test');
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
