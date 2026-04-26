'use strict'

const http = require('http')

// ── validation ────────────────────────────────────────────────────────────────
function validateChatPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'payload must be an object'
  if (!Array.isArray(payload.messages)) return 'messages must be an array'
  for (const msg of payload.messages) {
    if (!msg.role || typeof msg.role !== 'string') return 'each message must have a role string'
  }
  return null
}

// ── IPC registration ──────────────────────────────────────────────────────────
function register(ipcMain, { getServerPort, getMainWindow }) {
  let activeStreamReq = null

  ipcMain.handle('chat', async (_, payload) => {
    const err = validateChatPayload(payload)
    if (err) return { error: `Invalid payload: ${err}` }

    return new Promise((resolve) => {
      const body = JSON.stringify(payload)
      const req = http.request({
        hostname: '127.0.0.1', port: getServerPort(), path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let d = ''; res.on('data', c => d += c)
        res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({ error: d || 'Empty response' }) } })
        res.on('error', () => resolve({ error: 'Response error' }))
      })
      req.on('error', err => resolve({ error: `Server not reachable: ${err.code || err.message}. Is a model loaded?` }))
      req.setTimeout(300000, () => { req.destroy(); resolve({ error: 'Request timed out' }) })
      req.write(body); req.end()
    })
  })

  ipcMain.on('chat-stream', (event, payload) => {
    const err = validateChatPayload(payload)
    if (err) { event.sender.send('chat-stream-error', `Invalid payload: ${err}`); return }

    const body = JSON.stringify({ ...payload, stream: true })
    const req = http.request({
      hostname: '127.0.0.1', port: getServerPort(), path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let buf = ''
      res.on('data', chunk => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (line.startsWith('data: [DONE]')) { event.sender.send('chat-stream-done'); return }
          if (line.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(line.slice(6))
              if (parsed.usage && parsed.usage.prompt_tokens) {
                const stats = { ...parsed.usage }
                if (parsed.x_stats) {
                  stats.prompt_tps = parsed.x_stats.prompt_tps
                  stats.generation_tps = parsed.x_stats.generation_tps
                  stats.peak_memory_gb = parsed.x_stats.peak_memory_gb
                }
                event.sender.send('chat-stream-stats', stats)
              }
              const delta = parsed.choices?.[0]?.delta?.content
              if (delta) event.sender.send('chat-stream-chunk', parsed)
              // Forward finish_reason so the renderer can detect truncation
              const finishReason = parsed.choices?.[0]?.finish_reason
              if (finishReason) event.sender.send('chat-stream-finish-reason', finishReason)
            } catch {}
          }
        }
      })
      res.on('end', () => { activeStreamReq = null; event.sender.send('chat-stream-done') })
    })
    req.on('error', err => { activeStreamReq = null; event.sender.send('chat-stream-error', err.message) })
    req.write(body); req.end()
    activeStreamReq = req
  })

  ipcMain.handle('chat-stream-abort', () => {
    if (activeStreamReq) { activeStreamReq.destroy(); activeStreamReq = null }
    return { ok: true }
  })
}

module.exports = { register }
