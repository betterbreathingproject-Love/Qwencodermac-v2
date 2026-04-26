'use strict'

// ── IPC registration ──────────────────────────────────────────────────────────
function register(ipcMain, { getLspManager }) {
  ipcMain.handle('lsp-status', async () => {
    return getLspManager()?.getStatus() || { status: 'stopped', servers: [] }
  })

  ipcMain.handle('lsp-symbols', async (_, filePath) => {
    const mgr = getLspManager()
    if (!mgr || mgr.getStatus().status !== 'ready') return { symbols: [] }
    try {
      return await mgr.call('lsp_get_document_symbols', { path: filePath })
    } catch {
      return { symbols: [] }
    }
  })
}

module.exports = { register }
