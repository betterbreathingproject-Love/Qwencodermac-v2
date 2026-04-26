/**
 * Web tools — Brave Search API + URL fetch/scrape for the agent.
 *
 * Brave Search: requires BRAVE_API_KEY env var (free tier: 2000 queries/month).
 * Web Fetch: no API key needed — fetches any URL and extracts readable text.
 */
'use strict'

const https = require('https')
const http = require('http')

// ── Brave Search ──────────────────────────────────────────────────────────────

const BRAVE_API_KEY = process.env.BRAVE_API_KEY || ''

function braveSearch(query, count = 10, apiKey) {
  return new Promise((resolve, reject) => {
    const key = apiKey || BRAVE_API_KEY
    if (!key) {
      return reject(new Error('Brave API key not configured. Add it in Settings → API Keys, or set BRAVE_API_KEY env var. Get a free key at https://brave.com/search/api/'))
    }
    const params = new URLSearchParams({ q: query, count: String(Math.min(count, 20)) })
    const options = {
      hostname: 'api.search.brave.com',
      path: `/res/v1/web/search?${params}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'identity',
        'X-Subscription-Token': key,
      },
      timeout: 15000,
    }
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.web && json.web.results) {
            const results = json.web.results.map(r => ({
              title: r.title || '',
              url: r.url || '',
              description: r.description || '',
            }))
            resolve(results)
          } else if (json.query) {
            resolve([]) // valid response, no results
          } else {
            reject(new Error(json.message || json.error || 'Brave API error'))
          }
        } catch (e) {
          reject(new Error(`Failed to parse Brave response: ${e.message}`))
        }
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('Brave Search request timed out')) })
    req.on('error', reject)
    req.end()
  })
}

// ── Web Fetch / Scrape ────────────────────────────────────────────────────────

function webFetch(url, maxBytes = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let parsedUrl
    try { parsedUrl = new URL(url) } catch { return reject(new Error(`Invalid URL: ${url}`)) }

    const proto = parsedUrl.protocol === 'https:' ? https : http
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 20000,
    }

    const req = proto.request(options, (res) => {
      // Follow redirects (up to 5)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href
        return webFetch(redirectUrl, maxBytes).then(resolve, reject)
      }
      if (res.statusCode < 200 || res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
      }

      let data = ''
      let bytes = 0
      res.setEncoding('utf-8')
      res.on('data', chunk => {
        bytes += Buffer.byteLength(chunk)
        if (bytes <= maxBytes) data += chunk
        else { data += chunk.slice(0, maxBytes - (bytes - Buffer.byteLength(chunk))); res.destroy() }
      })
      res.on('end', () => resolve(data))
      res.on('close', () => resolve(data))
    })
    req.on('timeout', () => { req.destroy(); reject(new Error(`Fetch timed out: ${url}`)) })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Strip HTML tags and extract readable text content.
 * Removes scripts, styles, nav, header, footer, and collapses whitespace.
 */
function extractText(html) {
  let text = html
  // Remove script/style/nav/header/footer blocks
  text = text.replace(/<(script|style|nav|header|footer|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, ' ')
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim()
  return text
}

// ── Tool definitions (OpenAI function-calling format) ─────────────────────────

const WEB_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web using Brave Search. Returns a list of results with title, URL, and description. Use this to find information, documentation, tutorials, or solutions online.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'number', description: 'Number of results to return (1-20, default 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a web page and extract its readable text content. Use this after web_search to read the full content of a page, or to scrape any URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          max_length: { type: 'number', description: 'Max characters of extracted text to return (default 20000)' },
        },
        required: ['url'],
      },
    },
  },
]

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeWebTool(name, args, apiKeys = {}) {
  switch (name) {
    case 'web_search': {
      if (typeof args.query !== 'string' || !args.query.trim()) {
        return { error: 'query must be a non-empty string' }
      }
      try {
        const results = await braveSearch(args.query, args.count || 10, apiKeys.brave)
        if (results.length === 0) return { result: 'No results found.' }
        const formatted = results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`
        ).join('\n\n')
        return { result: formatted }
      } catch (err) {
        return { error: err.message }
      }
    }
    case 'web_fetch': {
      if (typeof args.url !== 'string' || !args.url.trim()) {
        return { error: 'url must be a non-empty string' }
      }
      // Basic URL validation
      try { new URL(args.url) } catch { return { error: `Invalid URL: ${args.url}` } }
      try {
        const html = await webFetch(args.url)
        let text = extractText(html)
        const maxLen = args.max_length || 20000
        if (text.length > maxLen) text = text.slice(0, maxLen) + '\n\n... [truncated]'
        if (!text.trim()) return { result: '(page returned no readable text content)' }
        return { result: text }
      } catch (err) {
        return { error: err.message }
      }
    }
    default:
      return { error: `Unknown web tool: ${name}` }
  }
}

module.exports = { WEB_TOOL_DEFS, executeWebTool, braveSearch, webFetch, extractText }
