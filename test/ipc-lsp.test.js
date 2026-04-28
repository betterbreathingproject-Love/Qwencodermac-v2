'use strict'

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { register } = require('../main/ipc-lsp')

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal ipcMain stub that collects handlers registered via .handle() */
function createIpcMainStub() {
  const handlers = new Map()
  return {
    handle(channel, fn) { handlers.set(channel, fn) },
    /** Invoke a registered handler (simulates renderer calling ipcRenderer.invoke) */
    async invoke(channel, ...args) {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`No handler for channel: ${channel}`)
      // first arg to the real handler is the IPC event object
      return fn({}, ...args)
    },
    handlers,
  }
}

function createLspManagerStub(overrides = {}) {
  return {
    getStatus: overrides.getStatus || (() => ({ status: 'ready', servers: [{ name: 'gopls', languages: ['go'] }], projectDir: '/tmp', uptime: 1000 })),
    call: overrides.call || (async () => ({ symbols: [{ name: 'main', kind: 'function' }] })),
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ipc-lsp', () => {
  let ipc

  describe('lsp-status', () => {
    it('returns manager status when LSP manager is available', async () => {
      ipc = createIpcMainStub()
      const mgr = createLspManagerStub()
      register(ipc, { getLspManager: () => mgr })

      const result = await ipc.invoke('lsp-status')
      assert.equal(result.status, 'ready')
      assert.equal(result.servers.length, 1)
      assert.equal(result.servers[0].name, 'gopls')
    })

    it('returns stopped default when getLspManager returns null', async () => {
      ipc = createIpcMainStub()
      register(ipc, { getLspManager: () => null })

      const result = await ipc.invoke('lsp-status')
      assert.deepStrictEqual(result, { status: 'stopped', servers: [] })
    })

    it('returns stopped default when getLspManager returns undefined', async () => {
      ipc = createIpcMainStub()
      register(ipc, { getLspManager: () => undefined })

      const result = await ipc.invoke('lsp-status')
      assert.deepStrictEqual(result, { status: 'stopped', servers: [] })
    })
  })

  describe('lsp-symbols', () => {
    it('returns symbols when LSP is ready', async () => {
      ipc = createIpcMainStub()
      const mgr = createLspManagerStub()
      register(ipc, { getLspManager: () => mgr })

      const result = await ipc.invoke('lsp-symbols', '/tmp/main.go')
      assert.equal(result.symbols.length, 1)
      assert.equal(result.symbols[0].name, 'main')
    })

    it('returns empty symbols when manager is null', async () => {
      ipc = createIpcMainStub()
      register(ipc, { getLspManager: () => null })

      const result = await ipc.invoke('lsp-symbols', '/tmp/main.go')
      assert.deepStrictEqual(result, { symbols: [] })
    })

    it('returns empty symbols when LSP status is not ready', async () => {
      ipc = createIpcMainStub()
      const mgr = createLspManagerStub({
        getStatus: () => ({ status: 'stopped', servers: [] }),
      })
      register(ipc, { getLspManager: () => mgr })

      const result = await ipc.invoke('lsp-symbols', '/tmp/main.go')
      assert.deepStrictEqual(result, { symbols: [] })
    })

    it('returns empty symbols when call() throws', async () => {
      ipc = createIpcMainStub()
      const mgr = createLspManagerStub({
        call: async () => { throw new Error('LSP timeout') },
      })
      register(ipc, { getLspManager: () => mgr })

      const result = await ipc.invoke('lsp-symbols', '/tmp/main.go')
      assert.deepStrictEqual(result, { symbols: [] })
    })

    it('passes correct tool name and args to call()', async () => {
      ipc = createIpcMainStub()
      let capturedTool, capturedArgs
      const mgr = createLspManagerStub({
        call: async (tool, args) => {
          capturedTool = tool
          capturedArgs = args
          return { symbols: [] }
        },
      })
      register(ipc, { getLspManager: () => mgr })

      await ipc.invoke('lsp-symbols', '/project/src/index.js')
      assert.equal(capturedTool, 'lsp_get_document_symbols')
      assert.deepStrictEqual(capturedArgs, { file_path: '/project/src/index.js' })
    })

    it('returns empty symbols for degraded status', async () => {
      ipc = createIpcMainStub()
      const mgr = createLspManagerStub({
        getStatus: () => ({ status: 'degraded', servers: [] }),
      })
      register(ipc, { getLspManager: () => mgr })

      const result = await ipc.invoke('lsp-symbols', '/tmp/main.go')
      assert.deepStrictEqual(result, { symbols: [] })
    })

    it('returns empty symbols for error status', async () => {
      ipc = createIpcMainStub()
      const mgr = createLspManagerStub({
        getStatus: () => ({ status: 'error', servers: [] }),
      })
      register(ipc, { getLspManager: () => mgr })

      const result = await ipc.invoke('lsp-symbols', '/tmp/main.go')
      assert.deepStrictEqual(result, { symbols: [] })
    })
  })
})
