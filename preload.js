const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('app', {
  // server
  serverStart:    ()        => ipcRenderer.invoke('server-start'),
  serverStop:     ()        => ipcRenderer.invoke('server-stop'),
  serverStatus:   ()        => ipcRenderer.invoke('server-status'),
  loadModel:      (p)       => ipcRenderer.invoke('load-model', p),
  chat:           (p)       => ipcRenderer.invoke('chat', p),
  getServerUrl:   ()        => ipcRenderer.invoke('get-server-url'),

  // streaming chat
  chatStream:     (p)       => ipcRenderer.send('chat-stream', p),
  chatStreamAbort:()        => ipcRenderer.invoke('chat-stream-abort'),
  onStreamChunk:  (cb)      => ipcRenderer.on('chat-stream-chunk', (_, d) => cb(d)),
  onStreamStats:  (cb)      => ipcRenderer.on('chat-stream-stats', (_, d) => cb(d)),
  onStreamDone:   (cb)      => ipcRenderer.on('chat-stream-done',  ()    => cb()),
  onStreamError:  (cb)      => ipcRenderer.on('chat-stream-error', (_, e) => cb(e)),
  offStream:      ()        => { for (const c of ['chat-stream-chunk','chat-stream-stats','chat-stream-done','chat-stream-error','chat-stream-finish-reason']) ipcRenderer.removeAllListeners(c) },
  onStreamFinishReason: (cb) => ipcRenderer.on('chat-stream-finish-reason', (_, d) => cb(d)),

  // qwen code agent
  qwenRun:        (p)       => ipcRenderer.invoke('qwen-run', { prompt: p.prompt, cwd: p.cwd, permissionMode: p.permissionMode, model: p.model, images: p.images, conversationHistory: p.conversationHistory, samplingParams: p.samplingParams, taskGraphPath: p.taskGraphPath }),
  qwenInterrupt:  ()        => ipcRenderer.invoke('qwen-interrupt'),
  onQwenEvent:    (cb)      => ipcRenderer.on('qwen-event', (_, d) => cb(d)),
  offQwenEvents:  ()        => ipcRenderer.removeAllListeners('qwen-event'),

  // filesystem
  openFolder:     ()        => ipcRenderer.invoke('open-folder'),
  readDir:        (p)       => ipcRenderer.invoke('read-dir', p),
  readFile:       (p)       => ipcRenderer.invoke('read-file', p),
  writeFile:      (p, c)    => ipcRenderer.invoke('write-file', p, c),
  getProject:     ()        => ipcRenderer.invoke('get-project'),

  // git
  gitStatus:      (c)       => ipcRenderer.invoke('git-status', c),
  gitLog:         (c)       => ipcRenderer.invoke('git-log', c),

  // misc
  openExternal:   (u)       => ipcRenderer.invoke('open-external', u),
  onServerLog:    (cb)      => ipcRenderer.on('server-log', (_, m) => cb(m)),
  onServerStatus: (cb)      => ipcRenderer.on('server-status', (_, s) => cb(s)),

  // projects
  listProjects:   ()        => ipcRenderer.invoke('list-projects'),
  createProject:  (n, d)    => ipcRenderer.invoke('create-project', n, d),
  openProjectById:(id)      => ipcRenderer.invoke('open-project', id),
  deleteProject:  (id)      => ipcRenderer.invoke('delete-project', id),
  getHistory:     (id)      => ipcRenderer.invoke('get-history', id),
  appendHistory:  (id, m)   => ipcRenderer.invoke('append-history', id, m),
  clearHistory:   (id)      => ipcRenderer.invoke('clear-history', id),
  buildContext:   (d)       => ipcRenderer.invoke('build-context', d),

  // sessions
  listSessions:   (pid)     => ipcRenderer.invoke('list-sessions', pid),
  createSession:  (pid, n, t) => ipcRenderer.invoke('create-session', pid, n, t),
  renameSession:  (pid,sid,n) => ipcRenderer.invoke('rename-session', pid, sid, n),
  deleteSession:  (pid,sid) => ipcRenderer.invoke('delete-session', pid, sid),
  getSessionMsgs: (pid,sid) => ipcRenderer.invoke('get-session-messages', pid, sid),
  appendSessionMsg:(pid,sid,m) => ipcRenderer.invoke('append-session-message', pid, sid, m),
  clearSessionMsgs:(pid,sid) => ipcRenderer.invoke('clear-session-messages', pid, sid),
  setSessionMsgs: (pid,sid,m) => ipcRenderer.invoke('set-session-messages', pid, sid, m),

  // session todos & chat snapshot
  getSessionTodos:  (pid,sid) => ipcRenderer.invoke('get-session-todos', pid, sid),
  saveSessionTodos: (pid,sid,t) => ipcRenderer.invoke('save-session-todos', pid, sid, t),
  getSessionSnapshot: (pid,sid) => ipcRenderer.invoke('get-session-chat-snapshot', pid, sid),
  saveSessionSnapshot:(pid,sid,s) => ipcRenderer.invoke('save-session-chat-snapshot', pid, sid, s),

  // session workflow state (spec + task graph)
  getSessionWorkflowState:  (pid,sid) => ipcRenderer.invoke('get-session-workflow-state', pid, sid),
  saveSessionWorkflowState: (pid,sid,s) => ipcRenderer.invoke('save-session-workflow-state', pid, sid, s),

  // context settings
  getSettings:    (id)      => ipcRenderer.invoke('get-settings', id),
  saveSettings:   (id, s)   => ipcRenderer.invoke('save-settings', id, s),
  getDefaultSettings: ()    => ipcRenderer.invoke('get-default-settings'),

  // API keys
  getApiKeys:     ()        => ipcRenderer.invoke('get-api-keys'),
  saveApiKeys:    (k)       => ipcRenderer.invoke('save-api-keys', k),

  // app settings (global)
  getAppSettings: ()        => ipcRenderer.invoke('get-app-settings'),
  saveAppSettings:(s)       => ipcRenderer.invoke('save-app-settings', s),

  // compactor
  compactorStatus:()        => ipcRenderer.invoke('compactor-status'),
  compactMessages:(m, o)    => ipcRenderer.invoke('compactor-compress-messages', m, o),
  compactText:    (t, ct)   => ipcRenderer.invoke('compactor-compress-text', t, ct),

  // task graph
  taskGraphParse:   (f)     => ipcRenderer.invoke('task-graph-parse', f),
  taskGraphExecute: (f)     => ipcRenderer.invoke('task-graph-execute', f),
  taskGraphPause:   ()      => ipcRenderer.invoke('task-graph-pause'),
  taskGraphResume:  ()      => ipcRenderer.invoke('task-graph-resume'),
  taskGraphStatus:  ()      => ipcRenderer.invoke('task-graph-status'),

  // background tasks
  bgTaskList:       ()      => ipcRenderer.invoke('bg-task-list'),
  bgTaskCancel:     (id)    => ipcRenderer.invoke('bg-task-cancel', id),
  bgTaskOutput:     (id)    => ipcRenderer.invoke('bg-task-output', id),

  // AST search
  astSearch:        (p, c)  => ipcRenderer.invoke('ast-search', p, c),
  astPatterns:      ()      => ipcRenderer.invoke('ast-patterns'),
  astSearchStatus:  ()      => ipcRenderer.invoke('ast-search-status'),

  // spec workflow
  specInit:         (n)     => ipcRenderer.invoke('spec-init', n),
  specPhase:        (d)     => ipcRenderer.invoke('spec-phase', d),
  specAdvance:      (d)     => ipcRenderer.invoke('spec-advance', d),
  specArtifacts:    (d)     => ipcRenderer.invoke('spec-artifacts', d),
  specSaveArtifact: (d,p,c) => ipcRenderer.invoke('spec-save-artifact', d, p, c),
  specConfig:       (d)     => ipcRenderer.invoke('spec-config', d),
  specList:         ()      => ipcRenderer.invoke('spec-list'),
  specDelete:       (n)     => ipcRenderer.invoke('spec-delete', n),

  // LSP
  lspStatus:         ()     => ipcRenderer.invoke('lsp-status'),
  lspSymbols:        (p)    => ipcRenderer.invoke('lsp-symbols', p),
  onLspStatusChange: (cb)   => ipcRenderer.on('lsp-status-change', (_, d) => cb(d)),
  offLspStatusChange:()     => ipcRenderer.removeAllListeners('lsp-status-change'),

  // events
  onTaskStatusEvent:(cb)    => ipcRenderer.on('task-status-event', (_, d) => cb(d)),
  onOrchestratorEvent:(cb)  => ipcRenderer.on('orchestrator-agent-event', (_, d) => cb(d)),
  onOrchestratorCompleted:(cb) => ipcRenderer.on('orchestrator-completed', () => cb()),
  offOrchestratorCompleted:() => ipcRenderer.removeAllListeners('orchestrator-completed'),
  onBgTaskEvent:    (cb)    => ipcRenderer.on('bg-task-event', (_, d) => cb(d)),
  onFilesChanged:   (cb)    => ipcRenderer.on('files-changed', (_, d) => cb(d)),
  offFilesChanged:  ()      => ipcRenderer.removeAllListeners('files-changed'),
  watchProject:     (d)     => ipcRenderer.invoke('watch-project', d),
  unwatchProject:   ()      => ipcRenderer.invoke('unwatch-project'),
})
