'use strict'

const { EventEmitter } = require('node:events')
const { WebSocketServer } = require('ws')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const projects = require('./projects')

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
      const url = new URL(req.url, `http://localhost:${this._port}`)
      const pathname = url.pathname

      // ── Static HTML ──
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        fs.createReadStream(htmlPath).pipe(res)
        return
      }

      // ── REST API ──
      if (pathname.startsWith('/api/')) {
        this._handleApi(req, res, pathname)
        return
      }

      res.writeHead(404)
      res.end('Not found')
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
   * Parse JSON body from a request.
   * @param {http.IncomingMessage} req
   * @returns {Promise<object>}
   */
  _parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')) }
        catch { reject(new Error('Invalid JSON')) }
      })
      req.on('error', reject)
    })
  }

  /**
   * Handle REST API requests for projects and sessions.
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} pathname
   */
  _handleApi(req, res, pathname) {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // GET /api/projects — list all projects
    if (req.method === 'GET' && pathname === '/api/projects') {
      const list = projects.listProjects()
      res.writeHead(200)
      res.end(JSON.stringify(list))
      return
    }

    // GET /api/projects/:id/sessions — list sessions for a project
    const sessionsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/)
    if (req.method === 'GET' && sessionsMatch) {
      const projectId = sessionsMatch[1]
      const sessions = projects.listSessions(projectId)
      res.writeHead(200)
      res.end(JSON.stringify(sessions))
      return
    }

    // GET /api/projects/:id/sessions/:sid/messages — get session messages
    const messagesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/messages$/)
    if (req.method === 'GET' && messagesMatch) {
      const [, projectId, sessionId] = messagesMatch
      const messages = projects.getSessionMessages(projectId, sessionId)
      res.writeHead(200)
      res.end(JSON.stringify(messages))
      return
    }

    // POST /api/projects/:id/sessions — create a new session
    if (req.method === 'POST' && sessionsMatch) {
      this._parseBody(req).then((body) => {
        const projectId = sessionsMatch[1]
        const session = projects.createSession(projectId, body.name || 'New Session', body.type)
        res.writeHead(201)
        res.end(JSON.stringify(session))
      }).catch(() => { res.writeHead(400); res.end('{"error":"Invalid body"}') })
      return
    }

    // POST /api/projects/:id/sessions/:sid/run — run agent on a session
    const runMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions\/([^/]+)\/run$/)
    if (req.method === 'POST' && runMatch) {
      this._parseBody(req).then((body) => {
        if (!body.prompt) { res.writeHead(400); res.end('{"error":"prompt required"}'); return }
        const [, projectId, sessionId] = runMatch
        // Append user message to session
        projects.appendSessionMessage(projectId, sessionId, { role: 'user', content: body.prompt, ts: Date.now() })
        // Trigger the job via controller
        this._controller.handleCommand('run', body.prompt)
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, jobId: this._controller.getJobId() }))
      }).catch(() => { res.writeHead(400); res.end('{"error":"Invalid body"}') })
      return
    }

    // GET /api/projects/:id — get project details
    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/)
    if (req.method === 'GET' && projectMatch) {
      const project = projects.openProject(projectMatch[1])
      if (project) {
        res.writeHead(200)
        res.end(JSON.stringify(project))
      } else {
        res.writeHead(404)
        res.end('{"error":"Not found"}')
      }
      return
    }

    // GET /api/status — agent status
    if (req.method === 'GET' && pathname === '/api/status') {
      res.writeHead(200)
      res.end(JSON.stringify({
        type: 'status',
        state: this._controller.getJobState(),
        jobId: this._controller.getJobId(),
        logs: this._logs.slice(-30),
      }))
      return
    }

    // POST /api/cmd — command endpoint (REST-based control)
    if (req.method === 'POST' && pathname === '/api/cmd') {
      this._parseBody(req).then((msg) => {
        this._handleClientMessage(msg)
        // Return current status as response
        const response = {
          type: 'status',
          state: this._controller.getJobState(),
          jobId: this._controller.getJobId(),
          logs: this._logs.slice(-30),
        }
        res.writeHead(200)
        res.end(JSON.stringify(response))
      }).catch(() => { res.writeHead(400); res.end('{"error":"Invalid body"}') })
      return
    }

    res.writeHead(404)
    res.end('{"error":"Not found"}')
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
