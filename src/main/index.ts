import electronUpdater from 'electron-updater'
const { autoUpdater } = electronUpdater
import { UpdateService } from './updates'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  screen,
  shell,
} from 'electron'
import { basename as localBasename, posix, join } from 'node:path'
import { open, readFile, writeFile } from 'node:fs/promises'
import type { ConnectionConfig, Reply } from '../shared/contracts'
import { StructureCompareService } from './structure-compare'
import { AiSettingsStore, AiService } from './ai-service'
import { ActivityLog } from './activity-log'
import { exportConnections } from './connection-export'
import { SessionManager } from './sessions'
import { remotePath } from './ssh-tools'
import { registerSshBatch } from './ssh-batch'
import { resultInsert, resultXlsx } from './result-formats'
import { resultText } from './export'
import { executeSqliteCommand } from './sqlite-dialog'
import { HistoryStore } from './history'
import { ProjectStore } from './projects'
import { ProfileStore } from './profiles'
import { ConnectionImportService } from './connection-import'
import { readWindowState, saveWindowState } from './window-state'

let window: BrowserWindow | null = null
let sessions: SessionManager
let ai: AiService
let structures: StructureCompareService
const devUrl = process.env.ELECTRON_RENDERER_URL
// Packaged smoke tests use an isolated profile and a hidden window.
if (process.env.VORK_TEST_WINDOW === '1' && process.env.VORK_TEST_USER_DATA)
  app.setPath('userData', process.env.VORK_TEST_USER_DATA)

async function verifyHost(config: ConnectionConfig, fingerprint: string) {
  const path = join(app.getPath('userData'), 'known-hosts.json')
  let known: Record<string, string> = {}
  try {
    known = JSON.parse(await readFile(path, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const host = `${config.host}:${config.port}`
  if (known[host] === fingerprint) return true
  const changed = Boolean(known[host])
  const answer = await dialog.showMessageBox(window!, {
    type: changed ? 'warning' : 'question',
    title: changed ? 'SSH 主机密钥已变化' : '确认 SSH 主机',
    message: changed ? '服务器身份与上次记录不一致' : '首次连接此 SSH 服务器',
    detail: `${host}\n${fingerprint}\n${changed ? `原指纹：${known[host]}\n` : ''}请与服务器管理员提供的指纹核对。`,
    buttons: ['取消', changed ? '确认新密钥并连接' : '信任并连接'],
    defaultId: 0,
    cancelId: 0,
  })
  if (answer.response !== 1) return false
  known[host] = fingerprint
  await writeFile(path, JSON.stringify(known, null, 2), { mode: 0o600 })
  return true
}

function registerIpc() {
  const activity = new ActivityLog(app.getPath('userData'))
  const aiSettings = new AiSettingsStore(app.getPath('userData'), safeStorage)
  ai = new AiService(aiSettings)
  const secrets = new Set<string>()
  const connectionNames = new Map<string, string>()
  const rememberSecrets = (config: ConnectionConfig) => {
    for (const value of [config.password, config.passphrase, config.privateKey])
      if (value) secrets.add(value)
  }
  const sanitizedError = (error: unknown) => {
    let message = error instanceof Error ? error.message : '操作失败'
    for (const secret of secrets) message = message.split(secret).join('[隐藏]')
    return message
  }
  const log = (level: 'info' | 'error', action: string, connection = '', message = '') =>
    activity
      .record(level, action, connection, message)
      .catch((error) => console.error('日志写入失败', error))
  const history = new HistoryStore(app.getPath('userData'))
  const profiles = new ProfileStore(app.getPath('userData'), safeStorage)
  sessions = new SessionManager(
    (owner, event) => {
      if (event.type === 'error' || event.type === 'closed')
        void log(
          event.type === 'error' ? 'error' : 'info',
          event.type,
          connectionNames.get(event.sessionId) || event.sessionId,
          event.type === 'error'
            ? sanitizedError(new Error(String(event.data || '连接异常')))
                .split('\n')[0]
                .replace(/(['"])[\s\S]*?\1/g, '[内容已隐藏]')
            : '连接已断开',
        )
      if (window && !window.isDestroyed() && window.webContents.id === owner)
        window.webContents.send('vork:event', event)
    },
    verifyHost,
    async (id) => (await profiles.list()).find((profile) => profile.id === id),
  )
  void profiles
    .list()
    .then((configs) => configs.forEach(rememberSecrets))
    .catch(() => {})
  structures = new StructureCompareService(
    {
      open: async (owner, ref) => {
        if (ref.kind === 'session') {
          const session = sessions.getSession(owner, ref.id)
          if (!['sqlite', 'mysql', 'postgresql'].includes(session.type))
            throw new Error('此连接不支持结构对比')
          return {
            id: session.id,
            source: {
              ...ref,
              name: session.name,
              type: session.type as 'sqlite' | 'mysql' | 'postgresql',
            },
            temporary: false,
          }
        }
        const config = (await profiles.list()).find((profile) => profile.id === ref.id)
        if (!config || !['sqlite', 'mysql', 'postgresql'].includes(config.type))
          throw new Error('保存的 SQL 连接不存在')
        rememberSecrets(config)
        const session = await sessions.connect(owner, config, true)
        return {
          id: session.id,
          source: {
            ...ref,
            name: config.name,
            type: config.type as 'sqlite' | 'mysql' | 'postgresql',
          },
          temporary: true,
        }
      },
      close: (owner, id) => sessions.disconnect(owner, id).catch(() => {}),
      tables: (owner, id, schema, after, signal, names) =>
        sessions.structureTables(owner, id, schema, after, signal, names),
      table: (owner, id, table, signal) => sessions.structureTable(owner, id, table, signal),
    },
    (owner, progress) => {
      if (window && !window.isDestroyed() && window.webContents.id === owner)
        window.webContents.send('vork:structure-progress', progress)
    },
  )
  const updates = new UpdateService(
    autoUpdater,
    app.isPackaged && __UPDATE_ENABLED__,
    __APP_VERSION__,
    async () => {
      const answer = await dialog.showMessageBox(window!, {
        type: 'question',
        title: '安装更新',
        message: '保存工作后重启安装更新？',
        detail: '安装将关闭所有连接。请先保存脚本并提交需要保留的事务。',
        buttons: ['取消', '重启安装'],
        defaultId: 0,
        cancelId: 0,
      })
      if (answer.response !== 1) return false
      await window!.webContents.executeJavaScript("window.dispatchEvent(new Event('beforeunload'))")
      await sessions.closeOwner(window!.webContents.id)
      autoUpdater.quitAndInstall(false, true)
      return true
    },
  )
  const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('无效 IPC 来源')
    const url = event.senderFrame?.url || ''
    if (devUrl ? new URL(url).origin !== new URL(devUrl).origin : !url.startsWith('file://'))
      throw new Error('无效页面来源')
    return event.sender.id
  }
  const handle = (
    channel: string,
    // Electron IPC payloads are untyped. Callers narrow each argument.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    action: (owner: number, ...args: any[]) => unknown,
  ) => {
    ipcMain.handle(channel, async (event, ...args): Promise<Reply<unknown>> => {
      let owner: number
      try {
        owner = trusted(event)
      } catch {
        return { ok: false, error: '无效 IPC 来源' }
      }
      const operation = channel.replace('vork:', '')
      const quiet = [
        'profiles',
        'projects',
        'activity-logs',
        'update-state',
        'query-history',
        'connection-details',
        'redis-request',
        'mongo-request',
        'ssh-request',
        'table-request',
        'schema-request',
        'query-plan',
        'er-request',
        'ai-settings',
        'structure-sources',
      ]
      let connection = ''
      if (channel === 'vork:connect' || channel === 'vork:save-profile') {
        if (args[0] && typeof args[0] === 'object') {
          rememberSecrets(args[0])
          connection = String(args[0].name || '').slice(0, 100)
        }
      } else if (typeof args[0] === 'string') {
        try {
          connection = sessions.getSession(owner, args[0]).name
        } catch {
          /* not a session operation */
        }
      }
      try {
        const data = await action(owner, ...args)
        if (
          ['connect', 'reconnect', 'duplicate-session'].includes(operation) &&
          data &&
          typeof data === 'object' &&
          'id' in data &&
          'name' in data
        ) {
          connectionNames.set(String(data.id), String(data.name))
          while (connectionNames.size > 128)
            connectionNames.delete(connectionNames.keys().next().value!)
          connection = String(data.name)
        }
        if (!quiet.includes(operation)) await log('info', operation, connection, '操作完成')
        else if (
          [
            'redis-request',
            'mongo-request',
            'ssh-request',
            'table-request',
            'schema-request',
          ].includes(operation) &&
          args[1]?.kind &&
          ![
            'scan',
            'info',
            'get',
            'read',
            'ttl-batch',
            'list',
            'databases',
            'collections',
            'find',
            'indexes',
            'schema',
            'rows',
          ].includes(args[1].kind)
        )
          await log(
            'info',
            operation + ':' + String(args[1].kind).slice(0, 60),
            connection,
            '操作完成',
          )
        return { ok: true, data }
      } catch (e) {
        const message = [
          'connect',
          'reconnect',
          'duplicate-session',
          'save-profile',
          'import-confirm',
          'import-preview',
        ].includes(operation)
          ? sanitizedError(e)
          : sanitizedError(e)
              .split('\n')[0]
              .replace(/(['"])[\s\S]*?\1/g, '[内容已隐藏]')
        if (!['activity-logs', 'export-logs'].includes(operation))
          await log('error', operation, connection, message)
        return { ok: false, error: e instanceof Error ? e.message : '操作失败' }
      }
    })
  }
  handle('vork:structure-sources', async (owner) => [
    ...sessions.structureSources(owner),
    ...(await profiles.list())
      .filter((profile) => ['sqlite', 'mysql', 'postgresql'].includes(profile.type))
      .map((profile) => ({
        kind: 'profile',
        id: profile.id!,
        name: profile.name,
        type: profile.type,
      })),
  ])
  handle('vork:structure-compare', (owner, input) => structures.compare(owner, input))
  handle('vork:structure-cancel', (owner, id) => structures.cancel(owner, id))
  handle('vork:structure-export', async (owner, id) => {
    const report = structures.report(owner, id),
      destination = await dialog.showSaveDialog(window!, {
        title: '导出结构对比报告',
        defaultPath: 'structure-comparison.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
    if (destination.canceled || !destination.filePath) return null
    await writeFile(destination.filePath, JSON.stringify(report, null, 2), { mode: 0o600 })
    return destination.filePath
  })
  handle('vork:er-request', (owner, id, request) => sessions.erRequest(owner, id, request))
  handle('vork:er-export', async (owner, id, snapshotId, positions, full) => {
    const svg = sessions.erSvg(owner, id, snapshotId, positions, full)
    const destination = await dialog.showSaveDialog(window!, {
      title: '导出 ER 关系图',
      defaultPath: 'er-diagram.svg',
      filters: [{ name: 'SVG', extensions: ['svg'] }],
    })
    if (destination.canceled || !destination.filePath) return null
    sessions.assertOwned(owner, id)
    await writeFile(destination.filePath, svg, { mode: 0o600 })
    return destination.filePath
  })
  handle('vork:query-plan', (owner, id, sql) => sessions.queryPlan(owner, id, sql))
  handle('vork:ai-settings', () => aiSettings.settings())
  handle('vork:ai-save-settings', (_, config) => aiSettings.save(config))
  handle('vork:ai-complete', (owner, id, request) =>
    ai.complete(owner, sessions.getSession(owner, id).type, request, (progress) => {
      if (window && !window.isDestroyed() && window.webContents.id === owner)
        window.webContents.send('vork:ai-progress', progress)
    }),
  )
  handle('vork:ai-cancel', (owner, id) => ai.cancel(owner, id))
  handle('vork:activity-logs', async () => ({
    path: activity.path,
    entries: await activity.list(),
  }))
  handle('vork:export-logs', async () => {
    const result = await dialog.showSaveDialog(window!, {
      title: '导出操作日志',
      defaultPath: 'vork-activity.jsonl',
      filters: [{ name: '日志 JSON Lines', extensions: ['jsonl'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, await activity.exportText(), { mode: 0o600 })
    return result.filePath
  })
  handle('vork:export-connections', async () => {
    const result = await dialog.showSaveDialog(window!, {
      title: '导出连接配置（不含密码和密钥）',
      defaultPath: 'vork-connections.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return null
    const configs = await profiles.list()
    await writeFile(result.filePath, exportConnections(configs), { mode: 0o600 })
    return result.filePath
  })
  handle('vork:open-project', () => shell.openExternal('https://github.com/skyiimaple/vork-shell'))
  handle('vork:update-state', () => updates.state())
  handle('vork:update-action', (_owner, action) => updates.action(action))
  handle('vork:schema-request', (owner, id, request) => sessions.schemaRequest(owner, id, request))
  handle('vork:table-request', (owner, id, request) => sessions.tableRequest(owner, id, request))
  handle('vork:reconnect', (owner, id) => sessions.reconnect(owner, id))
  handle('vork:favorite-profile', (_, id, value) => profiles.favorite(id, value))
  handle('vork:connect', (owner, config) => sessions.connect(owner, config))
  handle('vork:duplicate-session', (owner, id) => sessions.duplicate(owner, id))
  handle('vork:disconnect', (owner, id) => sessions.disconnect(owner, id))
  handle('vork:execute-script', (owner, id, sql) => sessions.executeScript(owner, id, sql))
  handle('vork:execute', (owner, id, command) => {
    if (
      typeof command === 'string' &&
      command.trimStart().startsWith('.') &&
      sessions.getSession(owner, id).type === 'sqlite'
    ) {
      return executeSqliteCommand(
        sessions,
        owner,
        id,
        command,
        async () => {
          const file = await dialog.showOpenDialog(window!, {
            title: '导入 CSV（首行需为目标表字段名）',
            properties: ['openFile'],
            filters: [{ name: 'CSV', extensions: ['csv'] }],
          })
          return file.canceled ? null : file.filePaths[0] || null
        },
        async () => {
          const file = await dialog.showSaveDialog(window!, {
            title: '导出 SQLite SQL',
            defaultPath: 'sqlite-dump.sql',
            filters: [{ name: 'SQL', extensions: ['sql'] }],
          })
          return file.canceled ? null : file.filePath || null
        },
      )
    }
    return sessions.execute(owner, id, command)
  })
  handle('vork:mongo-request', (owner, id, request) => sessions.mongoRequest(owner, id, request))
  handle('vork:redis-request', (owner, id, request) => sessions.redisRequest(owner, id, request))
  registerSshBatch(
    handle,
    sessions,
    async () => {
      const selected = await dialog.showOpenDialog(window!, {
        title: '选择上传文件（最多 100 个，不覆盖远端文件）',
        properties: ['openFile', 'multiSelections'],
      })
      return selected.canceled ? null : selected.filePaths
    },
    async () => {
      const selected = await dialog.showOpenDialog(window!, {
        title: '选择下载目标目录（不覆盖本地文件）',
        properties: ['openDirectory'],
      })
      return selected.canceled ? null : selected.filePaths[0] || null
    },
  )
  handle('vork:ssh-terminal-open', (owner, id, preferred) =>
    sessions.getSsh(owner, id).openTerminal(preferred),
  )
  handle('vork:ssh-terminal-close', (owner, id, channelId) =>
    sessions.getSsh(owner, id).closeTerminal(channelId),
  )
  handle('vork:ssh-request', (owner, id, request) => sessions.sshRequest(owner, id, request))
  handle('vork:ssh-transfer-cancel', (owner, id) =>
    sessions.getSsh(owner, id).tools.cancelTransfer(),
  )
  handle('vork:ssh-transfer', async (owner, id, kind, path) => {
    sessions.getSsh(owner, id)
    remotePath(path)
    if (kind !== 'upload' && kind !== 'download') throw new Error('文件传输类型无效')
    let local: string | undefined
    if (kind === 'upload') {
      const selection = await dialog.showOpenDialog(window!, {
        title: '选择上传文件（不覆盖已有远端文件）',
        properties: ['openFile'],
      })
      if (!selection.canceled) local = selection.filePaths[0]
    } else {
      const selection = await dialog.showSaveDialog(window!, {
        title: '下载远端文件',
        defaultPath: posix.basename(path),
      })
      if (!selection.canceled) local = selection.filePath
    }
    if (!local) return { kind: 'transfer', canceled: true, bytes: 0, file: '' }
    const remote = kind === 'upload' ? posix.join(path, localBasename(local)) : path
    return sessions.getSsh(owner, id).tools.transfer(kind, remote, local, {
      onProgress: (progress) => sessions.transferProgress(owner, id, progress),
    })
  })
  handle('vork:copy-text', async (_, text) => {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 4 * 1024 * 1024)
      throw new Error('复制文本无效或超过4 MiB')
    await clipboard.writeText(text)
  })
  handle('vork:copy-result', async (owner, id, result, format, table) => {
    sessions.assertOwned(owner, id)
    const text =
      format === 'sql'
        ? resultInsert(result, table, sessions.getSession(owner, id).type)
        : resultText(result, format)
    await clipboard.writeText(text)
  })
  handle('vork:export-result', async (owner, id, result, format = 'csv', table) => {
    sessions.assertOwned(owner, id)
    const text =
      format === 'xlsx'
        ? await resultXlsx(result)
        : format === 'sql'
          ? resultInsert(result, table, sessions.getSession(owner, id).type)
          : resultText(result, format)
    const extension = format === 'markdown' ? 'md' : format
    const destination = await dialog.showSaveDialog(window!, {
      title: `导出当前结果（${format}）`,
      defaultPath: `query-result.${extension}`,
      filters: [{ name: format, extensions: [extension] }],
    })
    if (destination.canceled || !destination.filePath) return null
    sessions.assertOwned(owner, id)
    await writeFile(destination.filePath, text, { mode: 0o600 })
    return destination.filePath
  })
  handle('vork:cancel', (owner, id) => sessions.disconnect(owner, id))
  handle('vork:reorder-profiles', (_, ids, move) => profiles.reorder(ids, move))
  handle('vork:query-history', () => history.list())
  handle('vork:record-query', (owner, id, sql) =>
    history.record(sessions.getSession(owner, id), sql),
  )
  const imports = new ConnectionImportService()
  const importOwners = new Set<number>()
  handle('vork:import-cancel', (owner) => imports.clear(owner))
  handle('vork:import-preview', async (owner) => {
    imports.clear(owner)
    const selected = await dialog.showOpenDialog(window!, {
      title: '导入 Redis 连接配置',
      properties: ['openFile'],
      filters: [{ name: 'Redis 连接导出', extensions: ['ano', 'json'] }],
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    const file = await open(selected.filePaths[0], 'r')
    let text: string
    try {
      if ((await file.stat()).size > 2 * 1024 * 1024) throw new Error('配置文件不能超过 2 MiB')
      const buffer = Buffer.alloc(2 * 1024 * 1024 + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 2 * 1024 * 1024) throw new Error('配置文件不能超过 2 MiB')
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await file.close()
    }
    if (!window || window.isDestroyed() || window.webContents.id !== owner) return null
    if (!importOwners.has(owner)) {
      importOwners.add(owner)
      window.webContents.once('destroyed', () => {
        imports.clear(owner)
        importOwners.delete(owner)
      })
    }
    return imports.preview(owner, text, localBasename(selected.filePaths[0]), await profiles.list())
  })
  handle('vork:import-confirm', (owner, token, indices) =>
    imports.confirm(owner, token, indices, (configs) => profiles.importProfiles(configs)),
  )
  handle('vork:query-session', (owner, id, database) =>
    sessions.createQuerySession(owner, id, database),
  )
  handle('vork:connection-details', (owner, id) => sessions.connectionDetails(owner, id))
  const projects = new ProjectStore(app.getPath('userData'), () => profiles.projectSeeds())
  handle('vork:projects', () => projects.list())
  handle('vork:create-project', (_, name, ids) => projects.create(name, ids))
  handle('vork:update-project', (_, id, name, ids) => projects.update(id, name, ids))
  handle('vork:delete-project', (_, id) => projects.remove(id))
  handle('vork:assign-projects', (_, id, ids) => projects.assign(id, ids))
  handle('vork:connection-color', (_, id, color) => profiles.setColor(id, color))
  handle('vork:profiles', () => profiles.list())
  handle('vork:save-profile', (_, config) => profiles.save(config))
  handle('vork:delete-profile', (_, id) => {
    if (typeof id !== 'string') throw new Error('连接 ID 无效')
    return profiles.remove(id)
  })
  handle('vork:pick-file', async (_, kind) => {
    if (kind !== 'sqlite' && kind !== 'key') throw new Error('文件类型无效')
    const result = await dialog.showOpenDialog(window!, {
      title: kind === 'sqlite' ? '选择 SQLite 数据库' : '选择 SSH 私钥',
      properties: ['openFile'],
      filters:
        kind === 'sqlite'
          ? [
              { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] },
              { name: '全部文件', extensions: ['*'] },
            ]
          : undefined,
    })
    return result.canceled ? null : result.filePaths[0]
  })
  for (const channel of ['write', 'resize', 'ack'] as const) {
    ipcMain.on(`vork:${channel}`, (event, id, a, b, c) => {
      try {
        const owner = trusted(event)
        if (channel === 'write') sessions.write(owner, id, a, b)
        if (channel === 'resize') sessions.resize(owner, id, a, b, c)
        if (channel === 'ack') sessions.ack(owner, id, a, b)
      } catch {
        /* Late terminal events after closing are harmless. */
      }
    })
  }
}

function createWindow() {
  const statePath = join(app.getPath('userData'), 'window-state.json')
  const displays = [
    screen.getPrimaryDisplay(),
    ...screen.getAllDisplays().filter((d) => d.id !== screen.getPrimaryDisplay().id),
  ].map((d) => d.workArea)
  const state = readWindowState(statePath, displays)
  window = new BrowserWindow({
    show: process.env.VORK_TEST_WINDOW !== '1',
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 960,
    minHeight: 640,
    title: 'Vork Shell',
    backgroundColor: '#151719',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 13 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  const created = window
  const sendWindowState = () => {
    if (!created.isDestroyed())
      created.webContents.send('vork:window-state', {
        fullscreen: created.isFullScreen(),
        platform: process.platform,
      })
  }
  created.on('enter-full-screen', sendWindowState)
  created.on('leave-full-screen', sendWindowState)
  created.webContents.on('did-finish-load', sendWindowState)
  if (state.maximized) created.maximize()
  created.on('close', () => {
    try {
      saveWindowState(statePath, { ...created.getNormalBounds(), maximized: created.isMaximized() })
    } catch (error) {
      console.error('无法保存窗口状态', error)
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const owner = window.webContents.id
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) {
      structures.closeOwner(owner)
      ai.cancelOwner(owner)
      void sessions.closeOwner(owner)
    }
  })
  window.webContents.on('destroyed', () => {
    structures.closeOwner(owner)
    ai.cancelOwner(owner)
    void sessions.closeOwner(owner)
  })
  window.on('closed', () => {
    window = null
  })
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

void app.whenReady().then(() => {
  app.setName('Vork Shell')
  app.on('web-contents-created', (_, contents) =>
    contents.session.setPermissionRequestHandler((_, __, callback) => callback(false)),
  )
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow()
  })
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
