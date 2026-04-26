const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron')
const path = require('path')
const { DirectBridge, WindowSink } = require('./direct-bridge')
const { AgentPool } = require('./agent-pool')
const { loadSteeringDocs, formatSteeringForPrompt } = require('./steering-loader')

// IPC handler modules
const ipcServer = require('./main/ipc-server')
const ipcChat = require('./main/ipc-chat')
const ipcFiles = require('./main/ipc-files')
const ipcProjects = require('./main/ipc-projects')
const ipcTasks = require('./main/ipc-tasks')
const ipcWatcher = require('./main/ipc-watcher')
const ipcLsp = require('./main/ipc-lsp')
const { LspManager } = require('./lsp-manager')
const { TelegramBot } = require('./telegram-bot')
const { RecordingManager } = require('./recording-manager')
const { RemoteJobController } = require('./remote-job-controller')
const { MiniAppServer } = require('./telegram-miniapp-server')

nativeTheme.themeSource = 'dark'

let mainWindow
let qwenBridge = null
let currentProject = null
let lspManager = null
let telegramBot = null
let recordingManager = null
let remoteJobController = null
let miniAppServer = null
let miniAppTunnel = null
let miniAppPublicUrl = null
const SERVER_PORT = 8090
const MINIAPP_PORT = 3847
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`

// ── Subagent system prompts (like oh-my-kiro's multi-agent architecture) ──────
// Each subagent type gets a specialized prompt. Same model, different instructions.

const SUBAGENT_PROMPTS = {
  'explore': (cwd) => `You are a codebase exploration agent. Your job is to deeply understand the structure, patterns, and architecture of the codebase.

Working directory: ${cwd}

Your approach:
1. Start with list_dir to understand the project structure
2. Read key files: package.json, config files, entry points
3. Use search_files to find patterns and connections
4. Build a mental map of how components relate

You have these tools: read_file, list_dir, search_files, bash

OUTPUT: Provide a clear summary of what you found — file structure, key components, patterns, dependencies, and anything relevant to the task at hand. Be thorough but concise.

Do NOT modify any files. You are read-only. Your job is to explore and report.`,

  'context-gather': (cwd) => `You are a focused context-gathering agent. Given a task description, find the specific files and code sections relevant to completing that task.

Working directory: ${cwd}

Your approach:
1. Analyze the task to identify what files/components are involved
2. Use search_files to find relevant code by pattern
3. Read the specific files and sections needed
4. Identify dependencies and related code

You have these tools: read_file, list_dir, search_files

OUTPUT: List the relevant files with key code sections. Explain what each file does and how it relates to the task. Include specific line references when useful.

Do NOT modify any files. You are read-only. Gather context only.`,

  'implementation': (cwd) => `You are a focused implementation agent. You receive ONE specific task and implement it completely.

Working directory: ${cwd}

Rules:
- Focus ONLY on the task you are given. Do not implement other tasks.
- Read relevant files first to understand the current state
- Make changes using write_file or edit_file (one focused change at a time)
- Verify your changes work using bash (run tests, check syntax, etc.)
- Each write_file call must be under 300 lines. For larger files, write the first chunk then use bash with cat >> to append.
- Do NOT create plans, todo lists, or describe what you will do. Just DO it.
- Do NOT output code in your text response — use the file tools.

You have these tools: read_file, write_file, edit_file, list_dir, bash, search_files

When done, briefly state what you changed and any verification results.`,

  'code-search': (cwd) => `You are a code search agent. Find specific code patterns, function definitions, usages, and structural elements in the codebase.

Working directory: ${cwd}

Use search_files with regex patterns and read_file to examine results. Be precise in your findings.

You have these tools: read_file, list_dir, search_files, bash

OUTPUT: Report exact file paths, line numbers, and code snippets that match the search criteria.`,

  'general': (cwd) => `You are a general-purpose coding agent. Implement the task you are given.

Working directory: ${cwd}

Rules:
- Read relevant files first to understand context
- Make changes using write_file or edit_file
- Each write_file call must be under 300 lines. For larger files, write the first chunk then use bash with cat >> to append.
- Do NOT just describe what you plan to do — actually do it using tools
- Do NOT output code in your text response — use the file tools

You have these tools: read_file, write_file, edit_file, list_dir, bash, search_files

Be direct and efficient. Take action, don't narrate.`,
}

// ── Routing instruction builder for branch point tasks ────────────────────────
/**
 * Build routing instruction text for a branch point task.
 * Returns an instruction block explaining the RoutingDecision JSON format,
 * listing valid downstream task IDs, and providing an example.
 *
 * @param {Array<{id: string, title: string}>} routableTasks - Valid downstream tasks
 * @returns {string} Routing instruction block to append to system prompt
 */
function buildRoutingInstructions(routableTasks) {
  if (!routableTasks || routableTasks.length === 0) return ''

  const taskList = routableTasks
    .map(t => `- ${t.id}: ${t.title}`)
    .join('\n')

  const exampleId = routableTasks[0].id

  return `\n\n## Routing Instructions

You are executing a branch point task. After completing your analysis, you MUST return a routing decision as a JSON object.

### RoutingDecision Format
{"route": "<taskId>" | ["<taskId>", ...], "reason": "<optional explanation>"}

### Valid Task IDs
${taskList}

### Example
{"route": "${exampleId}", "reason": "Condition X is met, proceeding with this option"}`
}

const agentPool = new AgentPool({
  maxConcurrency: 1,
  agentFactory: (task, agentType, context) => {
    const typeName = agentType?.name || 'general'
    const cwd = task.cwd || currentProject || process.cwd()
    console.log('[agent-factory] Creating', typeName, 'agent for task:', task.id, task.title)

    const bridge = new DirectBridge(new WindowSink(mainWindow), { agentRole: typeName, allowedTools: agentType?.allowedTools || null, lspManager })

    // Pick the specialized system prompt for this agent type
    const promptBuilder = SUBAGENT_PROMPTS[typeName] || SUBAGENT_PROMPTS['general']
    let systemOverride = promptBuilder(cwd)

    // Inject steering docs after base prompt, before routing instructions
    const steeringDocs = loadSteeringDocs(cwd)
    const steeringContent = formatSteeringForPrompt(steeringDocs)
    if (steeringContent) {
      systemOverride += '\n\n' + steeringContent
    }

    // Append routing instructions for branch point tasks
    if (task.markers && task.markers.branch && task._routableTasks) {
      systemOverride += buildRoutingInstructions(task._routableTasks)
    }

    return {
      run: async ({ prompt }) => {
        console.log('[agent-factory] Running', typeName, 'task:', task.id)
        // Build the task prompt — keep it focused on just this task
        // Spec context is trimmed to avoid overwhelming the model
        let taskPrompt = `Task: ${prompt}`
        if (task.specContext) {
          // Truncate spec context to first 2000 chars to avoid OOM and prompt echoing
          const trimmedContext = task.specContext.length > 2000
            ? task.specContext.slice(0, 2000) + '\n\n[... truncated for brevity ...]\n'
            : task.specContext
          taskPrompt = `# Spec Context (summary)\n\n${trimmedContext}\n---\n\n# Current Task\n\n${prompt}\n\nImplement ONLY this task. Use write_file/edit_file tools directly. Do not output code in chat.`
        }
        try {
          await bridge.run({
            prompt: taskPrompt,
            cwd,
            permissionMode: 'auto-edit',
            systemPromptOverride: systemOverride,
            samplingParams: { temperature: 0.6, top_p: 0.9, repetition_penalty: 1.05 },
          })
          console.log('[agent-factory] Task completed:', task.id)
          await bridge.close().catch(() => {})
          return { output: 'done' }
        } catch (err) {
          console.error('[agent-factory] Task error:', task.id, err.message)
          await bridge.close().catch(() => {})
          throw err
        }
      },
      interrupt: () => bridge.interrupt(),
    }
  },
})

// Register subagent types with keyword matching
agentPool.registerType({ name: 'explore', systemPrompt: '', allowedTools: ['read_file', 'list_dir', 'search_files', 'bash', 'web_search', 'web_fetch'] })
agentPool.registerType({ name: 'context-gather', systemPrompt: '', allowedTools: ['read_file', 'list_dir', 'search_files', 'web_search', 'web_fetch'] })
agentPool.registerType({ name: 'code-search', systemPrompt: '', allowedTools: ['read_file', 'list_dir', 'search_files', 'bash'] })
agentPool.registerType({ name: 'requirements', systemPrompt: '', allowedTools: [] })
agentPool.registerType({ name: 'design', systemPrompt: '', allowedTools: [] })
agentPool.registerType({ name: 'implementation', systemPrompt: '', allowedTools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'bash', 'search_files', 'web_search', 'web_fetch'] })
agentPool.registerType({ name: 'general', systemPrompt: '', allowedTools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'bash', 'search_files', 'web_search', 'web_fetch'] })

// ── shared accessors for IPC modules ──────────────────────────────────────────
const ctx = {
  getMainWindow: () => mainWindow,
  getServerUrl: () => SERVER_URL,
  getServerPort: () => SERVER_PORT,
  getCurrentProject: () => currentProject,
  setCurrentProject: (p) => {
    currentProject = p
    // Start or restart LSP for the new project directory
    if (lspManager) {
      const status = lspManager.getStatus().status
      if (status === 'stopped') {
        lspManager.start(p).catch(() => {})
      } else {
        lspManager.restart(p).catch(() => {})
      }
    }
  },
  getAgentPool: () => agentPool,
  getLspManager: () => lspManager,
  findPython: ipcServer.findPython,
  appDir: __dirname,
}

// ── register all IPC handlers ─────────────────────────────────────────────────
ipcServer.register(ipcMain, ctx)
ipcChat.register(ipcMain, ctx)
ipcFiles.register(ipcMain, ctx)
ipcProjects.register(ipcMain, ctx)
ipcTasks.register(ipcMain, ctx)
ipcWatcher.register(ipcMain, ctx)
ipcLsp.register(ipcMain, ctx)

// ── IPC: Qwen Code agent ─────────────────────────────────────────────────────
ipcMain.handle('qwen-run', async (_, { prompt, cwd, permissionMode, agentRole, model, images, conversationHistory, samplingParams, taskGraphPath }) => {
  if (!qwenBridge) return { error: 'not ready' }
  if (typeof prompt !== 'string' || !prompt.trim()) return { error: 'prompt is required' }
  // Apply user-selected agent role (controls LSP tool set and system prompt)
  if (agentRole && agentRole !== qwenBridge._agentRole) {
    qwenBridge._agentRole = agentRole
  }
  qwenBridge.run({ prompt, cwd: cwd || currentProject, permissionMode, model, images, conversationHistory, samplingParams, taskGraphPath }).catch(() => {})
  return { ok: true }
})
ipcMain.handle('qwen-interrupt', async () => { await qwenBridge?.interrupt(); return { ok: true } })

// ── IPC: Steering docs ───────────────────────────────────────────────────────
ipcMain.handle('steering-list', async () => {
  if (!currentProject) return { docs: [] }
  const docs = loadSteeringDocs(currentProject)
  return { docs }
})

ipcMain.handle('steering-create', async (_, { name, description, body }) => {
  if (!currentProject) return { error: 'No project open' }
  const fs = require('node:fs')
  const { printSteeringDoc } = require('./steering-loader')
  const steeringDir = path.join(currentProject, '.maccoder', 'steering')
  fs.mkdirSync(steeringDir, { recursive: true })
  const safeName = (name || 'untitled').replace(/\s+/g, '-').toLowerCase()
  const filePath = path.join(steeringDir, `${safeName}.md`)
  const content = printSteeringDoc({ name: name || safeName, description: description || '', auto_generated: false }, body || '')
  fs.writeFileSync(filePath, content, 'utf8')
  return { ok: true, path: filePath }
})

// ── background task events ────────────────────────────────────────────────────
agentPool.on('bg-task-event', (evt) => {
  mainWindow?.webContents.send('bg-task-event', evt)
})

// ── window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 650,
    titleBarStyle: 'hiddenInset', backgroundColor: '#0f0f0f',
    vibrancy: 'under-window', visualEffectState: 'active',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.on('closed', () => { ipcServer.stopServer(); mainWindow = null })
  qwenBridge = new DirectBridge(new WindowSink(mainWindow))

  // Start LSP manager asynchronously — does not block window creation
  lspManager = new LspManager()
  lspManager.on('status-change', ({ oldStatus, newStatus }) => {
    mainWindow?.webContents.send('lsp-status-change', { oldStatus, newStatus })
  })
  lspManager.on('diagnostics', ({ path: filePath, diagnostics }) => {
    mainWindow?.webContents.send('lsp-diagnostics', { path: filePath, diagnostics })
  })
  qwenBridge.setLspManager(lspManager)
  agentPool.setLspStatusGetter(() => lspManager?.getStatus()?.status)
  if (currentProject) {
    lspManager.start(currentProject).catch(() => {})
  }

  // ── Telegram Bot initialization ──
  const appDataDir = app.getPath('userData')
  telegramBot = new TelegramBot({ appDataDir })
  recordingManager = new RecordingManager({ baseDir: path.join(appDataDir, 'telegram-recordings') })

  // Load saved config and auto-start if valid
  const savedConfig = telegramBot.loadConfig()
  if (savedConfig && savedConfig.token && savedConfig.pairedChatId) {
    telegramBot._pairedChatId = savedConfig.pairedChatId
    telegramBot._botUsername = savedConfig.botUsername
    telegramBot.start(savedConfig.token).catch(err => {
      console.warn('[telegram-bot] Auto-start failed:', err.message)
    })
  }

  // Wire command events to RemoteJobController
  telegramBot.on('command', ({ chatId, command, args }) => {
    if (!remoteJobController && telegramBot.getPairedChatId()) {
      remoteJobController = new RemoteJobController({
        telegramBot,
        chatId: telegramBot.getPairedChatId(),
        recordingManager,
        miniAppUrl: miniAppPublicUrl,
      })
    }
    if (remoteJobController) {
      remoteJobController.handleCommand(command, args)
    }
  })

  // Re-create RemoteJobController on pairing
  telegramBot.on('paired', ({ chatId }) => {
    remoteJobController = new RemoteJobController({
      telegramBot,
      chatId,
      recordingManager,
      miniAppUrl: miniAppPublicUrl,
    })
  })

  // ── Telegram IPC handlers ──
  ipcMain.handle('telegram-pair', async () => {
    if (!telegramBot) return { error: 'Bot not initialized' }
    return telegramBot.generatePairingToken()
  })

  ipcMain.handle('telegram-status', async () => {
    if (!telegramBot) return { connected: false, bot_username: null, polling: false, last_error: null, has_token: false, token_masked: null }
    return telegramBot.getStatus()
  })

  ipcMain.handle('telegram-get-token', async () => {
    if (!telegramBot) return { token: null }
    return { token: telegramBot._token || null }
  })

  ipcMain.handle('telegram-start', async (event, token) => {
    if (!telegramBot) return { error: 'Bot not initialized' }
    try {
      await telegramBot.start(token)
      return { ok: true }
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('telegram-stop', async () => {
    if (!telegramBot) return { error: 'Bot not initialized' }
    await telegramBot.stop()
    return { ok: true }
  })

  // ── Mini App IPC handlers ──
  ipcMain.handle('miniapp-start', async () => {
    try {
      // Create a stub controller if none exists yet
      if (!remoteJobController) {
        const chatId = telegramBot?.getPairedChatId() || null
        if (chatId) {
          remoteJobController = new RemoteJobController({
            telegramBot,
            chatId,
            recordingManager,
            miniAppUrl: miniAppPublicUrl,
          })
        } else {
          // Create a minimal controller for the mini app to work standalone
          const { EventEmitter } = require('node:events')
          remoteJobController = Object.assign(new EventEmitter(), {
            getJobState: () => 'idle',
            getJobId: () => null,
            handleCommand: () => {},
          })
        }
      }

      // Start the HTTP/WS server
      if (!miniAppServer) {
        miniAppServer = new MiniAppServer({ jobController: remoteJobController, port: MINIAPP_PORT })
        miniAppServer.start()
      }

      // Start the tunnel for public HTTPS access
      // Use a stable subdomain derived from the bot username for consistency
      const localtunnel = require('localtunnel')
      if (!miniAppTunnel) {
        const subdomain = telegramBot?._botUsername
          ? 'qc-' + telegramBot._botUsername.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20)
          : 'qwencoder-' + require('node:crypto').randomBytes(4).toString('hex')

        miniAppTunnel = await localtunnel({ port: MINIAPP_PORT, subdomain })
        miniAppPublicUrl = miniAppTunnel.url
        // Update the controller's mini app URL
        if (remoteJobController._miniAppUrl !== undefined) {
          remoteJobController._miniAppUrl = miniAppPublicUrl
        }
        miniAppTunnel.on('close', () => { miniAppTunnel = null; miniAppPublicUrl = null })

        // Auto-set the bot's menu button to the mini app URL via Telegram API
        if (telegramBot?._token && telegramBot.getPairedChatId()) {
          const { telegramRequest } = require('./telegram-bot')
          telegramRequest('setChatMenuButton', telegramBot._token, {
            chat_id: telegramBot.getPairedChatId(),
            menu_button: JSON.stringify({
              type: 'web_app',
              text: '⚡ Agent',
              web_app: { url: miniAppPublicUrl },
            }),
          }).catch(() => {}) // best-effort
        }
      }

      return { ok: true, localUrl: `http://localhost:${MINIAPP_PORT}`, publicUrl: miniAppPublicUrl }
    } catch (err) {
      return { error: err.message }
    }
  })

  ipcMain.handle('miniapp-stop', async () => {
    // Reset the bot's menu button back to default
    if (telegramBot?._token && telegramBot.getPairedChatId()) {
      const { telegramRequest } = require('./telegram-bot')
      telegramRequest('setChatMenuButton', telegramBot._token, {
        chat_id: telegramBot.getPairedChatId(),
        menu_button: JSON.stringify({ type: 'default' }),
      }).catch(() => {})
    }
    if (miniAppTunnel) { miniAppTunnel.close(); miniAppTunnel = null; miniAppPublicUrl = null }
    if (miniAppServer) { miniAppServer.stop(); miniAppServer = null }
    return { ok: true }
  })

  ipcMain.handle('miniapp-status', async () => {
    return {
      running: !!miniAppServer,
      localUrl: miniAppServer ? `http://localhost:${MINIAPP_PORT}` : null,
      publicUrl: miniAppPublicUrl || null,
    }
  })
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow()
  ipcServer.startServer(SERVER_PORT, __dirname, mainWindow)
  ipcServer.waitForServer(SERVER_URL).then(ok => {
    mainWindow?.webContents.send('server-status', { running: ok })
  })
})
app.on('window-all-closed', () => {
  ipcServer.stopServer()
  ipcWatcher.unwatchProject()
  if (lspManager) lspManager.stop().catch(() => {})
  if (telegramBot) telegramBot.stop()
  if (miniAppTunnel) { miniAppTunnel.close(); miniAppTunnel = null }
  if (miniAppServer) { miniAppServer.stop(); miniAppServer = null }
  app.quit()
})
app.on('activate', () => { if (!mainWindow) createWindow() })

// ── exports for testing ───────────────────────────────────────────────────────
module.exports = { buildRoutingInstructions }
