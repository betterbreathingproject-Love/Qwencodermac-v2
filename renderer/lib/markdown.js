// Markdown rendering utilities — extracted from app.js

var _codeBlockId = 0

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function stripThinking(t){
  // Remove complete <think>...</think> blocks (case-insensitive)
  t = t.replace(/<think>([\s\S]*?)<\/think>/gi, '')
  // Remove unclosed <think> block at end (streaming)
  t = t.replace(/<think>[\s\S]*$/gi, '')
  // Remove any orphaned </think> tags
  t = t.replace(/<\/think>/gi, '')
  return t.trim()
}
function extractThinking(t){
  const parts = []
  // extract completed think blocks (case-insensitive, handles <Think>...</Think>)
  t.replace(/<think>([\s\S]*?)<\/think>/gi, (_, content) => { parts.push(content.trim()); return '' })
  // extract unclosed (streaming) think block
  const unclosed = t.match(/<think>([\s\S]*)$/i)
  if (unclosed) parts.push(unclosed[1].trim())
  return parts.join('\n\n')
}
function stripToolCallMarkup(t){return t.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi,'').replace(/<tool_call>[\s\S]*$/gi,'').trim()}

function renderMd(text, isStreaming){
  if(!text) return ''
  text = stripThinking(text)
  text = stripToolCallMarkup(text)
  let html = esc(text)

  // code blocks (fenced)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = 'cb-' + (++_codeBlockId)
    const trimmed = code.trim()
    const lc = trimmed.split('\n').length
    const lines = trimmed.split('\n').map((l,i) => `<span class="ln">${i+1}</span>${l}`).join('\n')
    const canPreview = ['html','htm','svg'].includes((lang||'').toLowerCase())
    return `<div class="code-block"><div class="code-header"><span class="code-lang">${lang||'code'}</span><span class="code-lines">${lc} lines</span><button class="code-copy" onclick="copyCodeBlock('${id}',this)">Copy</button><button class="code-copy" onclick="saveCodeToFile('${id}','${lang||'txt'}',this)">💾 Save</button>${canPreview?`<button class="code-preview" onclick="previewCode('${id}')">▶ Preview</button>`:''}</div><pre id="${id}"><code>${lines}</code></pre></div>`
  })

  // streaming partial code block
  if(isStreaming){
    html = html.replace(/```(\w*)\n?([\s\S]*)$/, (_, lang, code) => {
      const trimmed = code.trim()
      if(!trimmed) return `<div class="code-block streaming"><div class="code-header"><span class="code-lang">${lang||'code'}</span><span class="code-lines">writing...</span></div><pre><code></code></pre></div>`
      const lines = trimmed.split('\n').map((l,i) => `<span class="ln">${i+1}</span>${l}`).join('\n')
      return `<div class="code-block streaming"><div class="code-header"><span class="code-lang">${lang||'code'}</span><span class="code-lines">${trimmed.split('\n').length} lines...</span></div><pre><code>${lines}</code></pre></div>`
    })
  }

  // markdown tables
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim())
    if (rows.length < 2) return tableBlock
    // check if row 2 is a separator (|---|---|)
    const isSep = r => /^\|[\s\-:]+(\|[\s\-:]+)+\|?$/.test(r.trim())
    let headerRow = rows[0], bodyRows
    if (isSep(rows[1])) {
      bodyRows = rows.slice(2)
    } else {
      headerRow = null
      bodyRows = rows
    }
    const parseRow = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
    let t = '<div class="md-table-wrap"><table class="md-table">'
    if (headerRow) {
      const cells = parseRow(headerRow)
      t += '<thead><tr>' + cells.map(c => `<th>${c}</th>`).join('') + '</tr></thead>'
    }
    t += '<tbody>'
    for (const r of bodyRows) {
      if (isSep(r)) continue
      const cells = parseRow(r)
      t += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>'
    }
    t += '</tbody></table></div>'
    return t
  })

  // checklists: - [x] done, - [ ] todo
  html = html.replace(/^- \[x\] (.+)$/gm, '<div class="md-check"><span class="md-check-box checked">✓</span><span class="md-check-text checked">$1</span></div>')
  html = html.replace(/^- \[ \] (.+)$/gm, '<div class="md-check"><span class="md-check-box">☐</span><span class="md-check-text">$1</span></div>')

  // horizontal rule
  html = html.replace(/^---+$/gm, '<hr class="md-hr">')

  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>')
  html = html.replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>')
  html = html.replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>')
  html = html.replace(/^- (.+)$/gm, '<div class="md-li">• $1</div>')
  html = html.replace(/^\* (.+)$/gm, '<div class="md-li">• $1</div>')
  html = html.replace(/^(\d+)\. (.+)$/gm, '<div class="md-li"><span class="md-num">$1.</span> $2</div>')
  html = html.replace(/\n/g, '<br>')
  // collapse excessive line breaks (3+ consecutive <br> → 2)
  html = html.replace(/(<br\s*\/?>){3,}/gi, '<br><br>')
  return html
}
