'use strict'

const { EventEmitter } = require('node:events')
const { WebSocketServer } = require('ws')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

/**
 * Serves the Telegram Mini App HTML and provides a WebSocket bridge
 * to the RemoteJobController for real-time communication.
 */
class MiniAppServer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.jobController - RemoteJobController instance
   * @param {number} [opts.port=3847] - HTTP/WS port
   */
  constructor({ jobController, port = 3847 }) {
    super()
    this._controller = jobController
    this._port = port
    this._server = null
    this._wss = null
    this._clients = new Set()
    this._logs = []
  }

  /**
   * Start the HTTP + WebSocket server.
   * @returns {{ port: number, url: string }}
   */
  start() {
    const htmlPath = path.join(__dirname, 'telegram-miniapp.html')

    this._server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        fs.createReadStream(htmlPath).pipe(res)
      } else {
        res.writeHead(404)
        res.end('Not found')
      }
    })

    this._wss = new WebSocketServer({ server: this._server, path: '/miniapp' })

    this._wss.on('connection', (ws) => {
      this._clients.add(ws)
      // Send current state on connect
      this._sendTo(ws, {
        type: 'status',
        state: this._controller.getJobState(),
        jobId: this._controller.getJobId(),
      })
      // Send recent logs
      for (const log of this._logs.slice(-30)) {
        this._sendTo(ws, log)
      }

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          this._handleClientMessage(msg)
        } catch { /* ignore malformed */ }
      })

      ws.on('close', () => this._clients.delete(ws))
    })

    // Wire up controller events
    this._wireController()

    this._server.listen(this._port, () => {
      this.emit('listening', { port: this._port })
    })

    return { port: this._port, url: `http://localhost:${this._port}` }
  }

  /**
   * Stop the server.
   */
  stop() {
    for (const ws of this._clients) {
      ws.close()
    }
    this._clients.clear()
    if (this._wss) { this._wss.close(); this._wss = null }
    if (this._server) { this._server.close(); this._server = null }
  }

  /**
   * Get the mini app URL for Telegram Web App buttons.
   * @returns {string}
   */
  getUrl() {
    return `http://localhost:${this._port}`
  }

  /**
   * Broadcast a message to all connected clients.
   * @param {object} msg
   */
  _broadcast(msg) {
    const data = JSON.stringify(msg)
    for (const ws of this._clients) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(data)
      }
    }
  }

  /**
   * Send a message to a single client.
   * @param {WebSocket} ws
   * @param {object} msg
   */
  _sendTo(ws, msg) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg))
    }
  }

  /**
   * Handle incoming messages from the mini app client.
   * @param {object} msg
   */
  _handleClientMessage(msg) {
    switch (msg.type) {
      case 'run':
        if (msg.prompt) {
          this._controller.handleCommand('run', msg.prompt)
        }
        break
      case 'stop':
        this._controller.handleCommand('stop', '')
        break
      case 'status':
        this._broadcast({
          type: 'status',
          state: this._controller.getJobState(),
          jobId: this._controller.getJobId(),
        })
        break
      case 'screenshot':
        this._controller.handleCommand('screenshot', '')
        break
    }
  }

  /**
   * Wire RemoteJobController events to WebSocket broadcasts.
   */
  _wireController() {
    const ctrl = this._controller

    // The controller emits on its EventEmitter — listen for sink messages
    ctrl.on('agent:message', (data) => {
      const log = { type: 'log', text: data.text || data.content || '', logType: 'info', time: Date.now() }
      this._logs.push(log)
      if (this._logs.length > 200) this._logs.shift()
      this._broadcast(log)
    })

    ctrl.on('agent:tool_use', (data) => {
      const msg = { type: 'tool_use', tool: data.name || data.tool || 'unknown', summary: data.summary || '', time: Date.now() }
      this._logs.push(msg)
      if (this._logs.length > 200) this._logs.shift()
      this._broadcast(msg)
    })

    ctrl.on('agent:done', () => {
      this._broadcast({ type: 'job_completed', jobId: ctrl.getJobId() })
    })

    ctrl.on('agent:error', (data) => {
      this._broadcast({ type: 'job_failed', jobId: ctrl.getJobId(), error: data.message || 'Unknown error' })
    })

    ctrl.on('agent:screenshot', (data) => {
      this._broadcast({ type: 'screenshot', data: data.url || data.base64 || null })
    })

    ctrl.on('agent:input_request', (data) => {
      this._broadcast({ type: 'input_request', question: data.question || '' })
    })

    // Also listen for state changes via polling (fallback)
    const prevState = { value: ctrl.getJobState() }
    setInterval(() => {
      const current = ctrl.getJobState()
      if (current !== prevState.value) {
        prevState.value = current
        if (current === 'running') {
          this._broadcast({ type: 'job_started', jobId: ctrl.getJobId(), prompt: '' })
        }
      }
    }, 2000)
  }
}

module.exports = { MiniAppServer }
