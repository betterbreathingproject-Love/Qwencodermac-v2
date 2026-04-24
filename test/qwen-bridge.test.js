/**
 * Unit tests for multi-instance QwenBridge refactor.
 * Tests EventSink implementations and concurrent QwenBridge instances.
 */
const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { QwenBridge, WindowSink, CallbackSink, WorkerSink } = require('../qwen-bridge')

// ── 8.4.1 WindowSink ─────────────────────────────────────────────────────────

describe('WindowSink', () => {
  it('routes events to BrowserWindow.webContents.send', () => {
    const sent = []
    const mockWin = {
      isDestroyed: () => false,
      webContents: {
        send: (channel, data) => sent.push({ channel, data })
      }
    }
    const sink = new WindowSink(mockWin)
    sink.send('qwen-event', { type: 'text-delta', text: 'hello' })
    sink.send('qwen-event', { type: 'session-end' })

    assert.equal(sent.length, 2)
    assert.equal(sent[0].channel, 'qwen-event')
    assert.deepEqual(sent[0].data, { type: 'text-delta', text: 'hello' })
    assert.deepEqual(sent[1].data, { type: 'session-end' })
  })

  it('does not send when window is destroyed', () => {
    const sent = []
    const mockWin = {
      isDestroyed: () => true,
      webContents: {
        send: (channel, data) => sent.push({ channel, data })
      }
    }
    const sink = new WindowSink(mockWin)
    sink.send('qwen-event', { type: 'text-delta', text: 'hello' })

    assert.equal(sent.length, 0)
  })

  it('does not throw when window is null', () => {
    const sink = new WindowSink(null)
    assert.doesNotThrow(() => sink.send('qwen-event', { type: 'test' }))
  })
})

// ── 8.4.2 CallbackSink ───────────────────────────────────────────────────────

describe('CallbackSink', () => {
  it('routes events through EventEmitter with correct taskId', () => {
    const emitter = new EventEmitter()
    const received = []
    emitter.on('agent-event', (evt) => received.push(evt))

    const sink = new CallbackSink(emitter, 'task-42')
    sink.send('qwen-event', { type: 'text-delta', text: 'working...' })
    sink.send('qwen-event', { type: 'session-end' })

    assert.equal(received.length, 2)
    assert.equal(received[0].taskId, 'task-42')
    assert.equal(received[0].channel, 'qwen-event')
    assert.deepEqual(received[0].data, { type: 'text-delta', text: 'working...' })
    assert.equal(received[1].taskId, 'task-42')
    assert.deepEqual(received[1].data, { type: 'session-end' })
  })

  it('different taskIds are distinguishable on the same emitter', () => {
    const emitter = new EventEmitter()
    const received = []
    emitter.on('agent-event', (evt) => received.push(evt))

    const sink1 = new CallbackSink(emitter, 'task-A')
    const sink2 = new CallbackSink(emitter, 'task-B')

    sink1.send('qwen-event', { type: 'text-delta', text: 'from A' })
    sink2.send('qwen-event', { type: 'text-delta', text: 'from B' })

    assert.equal(received.length, 2)
    assert.equal(received[0].taskId, 'task-A')
    assert.equal(received[1].taskId, 'task-B')
  })
})

// ── 8.4.3 WorkerSink ─────────────────────────────────────────────────────────

describe('WorkerSink', () => {
  it('routes events through MessagePort mock', () => {
    const messages = []
    const mockPort = {
      postMessage: (msg) => messages.push(msg)
    }
    const sink = new WorkerSink(mockPort)
    sink.send('qwen-event', { type: 'tool-use', name: 'browser_navigate' })
    sink.send('qwen-event', { type: 'session-end' })

    assert.equal(messages.length, 2)
    assert.deepEqual(messages[0], { channel: 'qwen-event', data: { type: 'tool-use', name: 'browser_navigate' } })
    assert.deepEqual(messages[1], { channel: 'qwen-event', data: { type: 'session-end' } })
  })
})

// ── 8.4.4 Concurrent QwenBridge instances ─────────────────────────────────────

describe('Multi-instance QwenBridge', () => {
  it('two instances with independent sinks receive their own events', () => {
    const sent1 = []
    const sent2 = []

    const sink1 = {
      send: (channel, data) => sent1.push({ channel, data })
    }
    const sink2 = {
      send: (channel, data) => sent2.push({ channel, data })
    }

    const bridge1 = new QwenBridge(sink1)
    const bridge2 = new QwenBridge(sink2)

    bridge1.send('qwen-event', { type: 'text-delta', text: 'bridge1' })
    bridge2.send('qwen-event', { type: 'text-delta', text: 'bridge2' })
    bridge1.send('qwen-event', { type: 'session-end' })

    assert.equal(sent1.length, 2)
    assert.equal(sent2.length, 1)
    assert.deepEqual(sent1[0].data, { type: 'text-delta', text: 'bridge1' })
    assert.deepEqual(sent2[0].data, { type: 'text-delta', text: 'bridge2' })
    assert.deepEqual(sent1[1].data, { type: 'session-end' })
  })

  it('each instance has independent session state', () => {
    const sink1 = { send: () => {} }
    const sink2 = { send: () => {} }

    const bridge1 = new QwenBridge(sink1)
    const bridge2 = new QwenBridge(sink2)

    bridge1.sessionId = 'session-1'
    bridge2.sessionId = 'session-2'

    assert.equal(bridge1.sessionId, 'session-1')
    assert.equal(bridge2.sessionId, 'session-2')
    assert.notEqual(bridge1.sessionId, bridge2.sessionId)
  })

  it('each instance tracks its own Playwright browser', async () => {
    const sink1 = { send: () => {} }
    const sink2 = { send: () => {} }

    const bridge1 = new QwenBridge(sink1)
    const bridge2 = new QwenBridge(sink2)

    let browser1Closed = false
    let browser2Closed = false

    const mockBrowser1 = { close: async () => { browser1Closed = true } }
    const mockBrowser2 = { close: async () => { browser2Closed = true } }

    bridge1.setPlaywrightBrowser(mockBrowser1)
    bridge2.setPlaywrightBrowser(mockBrowser2)

    // Close only bridge1 — bridge2's browser should remain open
    await bridge1.close()

    assert.equal(browser1Closed, true)
    assert.equal(browser2Closed, false)
    assert.equal(bridge1._playwrightBrowser, null)
    assert.equal(bridge2._playwrightBrowser, mockBrowser2)

    // Now close bridge2
    await bridge2.close()
    assert.equal(browser2Closed, true)
    assert.equal(bridge2._playwrightBrowser, null)
  })

  it('close() handles no Playwright browser gracefully', async () => {
    const sink = { send: () => {} }
    const bridge = new QwenBridge(sink)

    // Should not throw when no browser is set
    await assert.doesNotReject(() => bridge.close())
  })

  it('WindowSink + CallbackSink + WorkerSink can coexist', () => {
    const winSent = []
    const mockWin = {
      isDestroyed: () => false,
      webContents: { send: (ch, d) => winSent.push({ ch, d }) }
    }

    const emitter = new EventEmitter()
    const cbReceived = []
    emitter.on('agent-event', (evt) => cbReceived.push(evt))

    const portMessages = []
    const mockPort = { postMessage: (msg) => portMessages.push(msg) }

    const bridge1 = new QwenBridge(new WindowSink(mockWin))
    const bridge2 = new QwenBridge(new CallbackSink(emitter, 'task-1'))
    const bridge3 = new QwenBridge(new WorkerSink(mockPort))

    bridge1.send('qwen-event', { type: 'text-delta', text: 'win' })
    bridge2.send('qwen-event', { type: 'text-delta', text: 'cb' })
    bridge3.send('qwen-event', { type: 'text-delta', text: 'worker' })

    assert.equal(winSent.length, 1)
    assert.equal(cbReceived.length, 1)
    assert.equal(portMessages.length, 1)

    assert.deepEqual(winSent[0].d, { type: 'text-delta', text: 'win' })
    assert.equal(cbReceived[0].taskId, 'task-1')
    assert.deepEqual(cbReceived[0].data, { type: 'text-delta', text: 'cb' })
    assert.deepEqual(portMessages[0].data, { type: 'text-delta', text: 'worker' })
  })
})
