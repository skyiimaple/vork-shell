import { runSqlScript, type SqlDialect } from '../shared/sql-script'
import { TableDataService } from './table-data'
import { randomUUID } from 'node:crypto'
import type {
  ConnectionConfig,
  Session,
  SessionEvent,
  RedisRequest,
  MongoRequest,
  SshRequest,
  SqliteToolRequest,
  TableRequest,
  TransferProgress,
} from '../shared/contracts'
import { openDatabase, type Adapter } from './adapters'
import { openSsh, type SshSession } from './ssh'
import { validateConnection } from './validation'

interface Entry {
  config: ConnectionConfig
  owner: number
  session: Session
  adapter?: Adapter
  tableData?: TableDataService
  ssh?: SshSession
  tunnel?: SshSession
  busy: boolean
  queue: Promise<unknown>
  queued: number
}
export class SessionManager {
  private recent = new Map<string, { owner: number; config: ConnectionConfig }>()
  private entries = new Map<string, Entry>()
  constructor(
    private emit: (owner: number, event: SessionEvent) => void,
    private verifyHost: (config: ConnectionConfig, fingerprint: string) => Promise<boolean>,
    private resolveSsh?: (id: string) => Promise<ConnectionConfig | undefined>,
  ) {}
  async connect(owner: number, input: ConnectionConfig) {
    const config = validateConnection(input)
    const session: Session = {
      profileId: config.id,
      id: randomUUID(),
      name: config.name,
      type: config.type,
      database: config.type === 'redis' ? Number(config.database || 0) : undefined,
      target: config.type === 'sqlite' ? config.path! : `${config.host}:${config.port}`,
    }
    const entry: Entry = {
      config: { ...config },
      owner,
      session,
      busy: false,
      queue: Promise.resolve(),
      queued: 0,
    }
    const emit = (type: SessionEvent['type'], data: string) =>
      this.emit(owner, { sessionId: session.id, type, data })
    this.entries.set(session.id, entry)
    try {
      if (config.type === 'ssh') {
        entry.ssh = await openSsh(
          config,
          (hash) => this.verifyHost(config, hash),
          (type, data, channelId) => {
            this.emit(owner, { sessionId: session.id, type, data, channelId })
            if (!channelId && type !== 'data')
              void this.disconnect(owner, session.id).catch(() => {})
          },
        )
      } else {
        let endpoint: { host: string; port: number } | undefined
        if (config.sshProfileId) {
          const bastion = await this.resolveSsh?.(config.sshProfileId)
          if (!bastion || bastion.type !== 'ssh')
            throw new Error('关联的 SSH 配置不存在，请重新选择')
          const sshConfig = validateConnection(bastion)
          this.get(owner, session.id)
          entry.tunnel = await openSsh(
            sshConfig,
            (hash) => this.verifyHost(sshConfig, hash),
            (type, data) => {
              if (type !== 'data' && this.entries.has(session.id)) {
                emit('error', `SSH 隧道已断开：${data}`)
                void this.disconnect(owner, session.id).catch(() => {})
              }
            },
            false,
          )
          this.get(owner, session.id)
          const reply = await entry.tunnel.tools.request({
            kind: 'tunnel-start',
            host: config.host!,
            port: config.port!,
            localPort: 0,
          })
          if (reply.kind !== 'tunnels' || !reply.tunnels[0]) throw new Error('SSH 隧道建立失败')
          endpoint = { host: '127.0.0.1', port: reply.tunnels[0].localPort }
          session.target += `（经 SSH ${sshConfig.name}）`
          this.get(owner, session.id)
        }
        entry.adapter = await openDatabase(
          config,
          (message) => {
            emit('error', message)
            void this.disconnect(owner, session.id).catch(() => {})
          },
          endpoint,
        )
      }
      if (!this.entries.has(session.id)) {
        throw new Error('窗口或会话已关闭，连接已释放')
      }
    } catch (error) {
      this.entries.delete(session.id)
      await Promise.allSettled([entry.ssh?.close(), entry.adapter?.close(), entry.tunnel?.close()])
      throw error
    }
    return session
  }
  async reconnect(owner: number, id: string) {
    const previous = this.recent.get(id)
    if (!previous || previous.owner !== owner) throw new Error('重连快照不存在，请重新打开连接配置')
    return this.connect(owner, previous.config)
  }
  async duplicate(owner: number, id: string) {
    return this.connect(owner, {
      ...this.get(owner, id).config,
      name: this.get(owner, id).session.name.slice(0, 97) + ' 副本',
    })
  }
  private get(owner: number, id: string) {
    if (typeof id !== 'string') throw new Error('会话参数无效')
    const entry = this.entries.get(id)
    if (!entry || entry.owner !== owner) throw new Error('会话已关闭或无权访问')
    return entry
  }
  getSsh(owner: number, id: string) {
    const entry = this.get(owner, id)
    if (!entry.ssh) throw new Error('此会话不是 SSH 连接')
    return entry.ssh
  }
  async sshRequest(owner: number, id: string, request: SshRequest) {
    return this.getSsh(owner, id).tools.request(request)
  }
  transferProgress(owner: number, id: string, progress: TransferProgress) {
    if (this.entries.get(id)?.owner !== owner) return
    this.emit(owner, { sessionId: id, type: 'transfer', data: JSON.stringify(progress) })
  }
  createQuerySession(owner: number, id: string, database?: string) {
    const entry = this.get(owner, id)
    if (!['mysql', 'postgresql'].includes(entry.config.type))
      throw new Error('此类型共用原查询连接')
    if (
      database !== undefined &&
      (typeof database !== 'string' || !database.trim() || database.length > 256)
    )
      throw new Error('数据库名称无效')
    return this.connect(owner, { ...entry.config, database: database ?? entry.config.database })
  }
  connectionDetails(owner: number, id: string) {
    const { name, type, host, port, username, database, authSource, path, tls, sshProfileId } =
      this.get(owner, id).config
    return { name, type, host, port, username, database, authSource, path, tls, sshProfileId }
  }
  getSession(owner: number, id: string) {
    return { ...this.get(owner, id).session }
  }
  assertOwned(owner: number, id: string) {
    this.get(owner, id)
  }
  async tableRequest(owner: number, id: string, request: TableRequest) {
    const entry = this.get(owner, id)
    if (!['sqlite', 'mysql', 'postgresql'].includes(entry.session.type))
      throw new Error('此会话不支持数据表管理')
    return this.operation(owner, id, (adapter) => {
      entry.tableData ??= new TableDataService(
        entry.session.type as 'sqlite' | 'mysql' | 'postgresql',
        (sql, parameters) => adapter.execute(sql, parameters),
      )
      return entry.tableData.request(request)
    })
  }
  async executeScript(owner: number, id: string, sql: string) {
    const type = this.get(owner, id).session.type
    if (!['sqlite', 'mysql', 'postgresql'].includes(type)) throw new Error('此会话不支持SQL脚本')
    return this.operation(owner, id, (adapter) =>
      runSqlScript(sql, type as SqlDialect, (statement) => adapter.execute(statement)),
    )
  }
  async execute(owner: number, id: string, command: string) {
    if (typeof command !== 'string' || !command.trim() || Buffer.byteLength(command) > 1024 * 1024)
      throw new Error('命令为空或超过 1 MB')
    return this.operation(owner, id, (adapter) => adapter.execute(command))
  }
  async sqliteTool(owner: number, id: string, request: SqliteToolRequest) {
    return this.operation(owner, id, (adapter) => {
      if (!adapter.sqliteTool) throw new Error('此会话不是 SQLite 连接')
      return adapter.sqliteTool(request)
    })
  }
  async mongoRequest(owner: number, id: string, request: MongoRequest) {
    return this.operation(owner, id, (adapter) => {
      if (!adapter.mongoRequest) throw new Error('此会话不是 MongoDB 连接')
      return adapter.mongoRequest(request)
    })
  }
  async redisRequest(owner: number, id: string, request: RedisRequest) {
    return this.operation(owner, id, (adapter) => {
      if (!adapter.redisRequest) throw new Error('此会话不是 Redis 连接')
      return adapter.redisRequest(request)
    })
  }
  private async operation<T>(
    owner: number,
    id: string,
    action: (adapter: Adapter) => Promise<T>,
  ): Promise<T> {
    const entry = this.get(owner, id)
    const run = async () => {
      const current = this.get(owner, id)
      if (!current.adapter) throw new Error('此会话不支持数据库操作')
      if (current.busy) throw new Error('此会话已有命令正在执行')
      current.busy = true
      const timer = setTimeout(() => void this.disconnect(owner, id).catch(() => {}), 30000)
      try {
        return await action(current.adapter)
      } finally {
        clearTimeout(timer)
        current.busy = false
      }
    }
    if (entry.session.type !== 'redis') return run()
    if (entry.queued >= 32) throw new Error('Redis 待处理请求过多，请稍后重试')
    entry.queued++
    const task = entry.queue.catch(() => {}).then(run)
    entry.queue = task.catch(() => {})
    try {
      return await task
    } finally {
      entry.queued--
    }
  }
  async disconnect(owner: number, id: string) {
    const entry = this.get(owner, id)
    this.entries.delete(id)
    this.recent.set(id, { owner: entry.owner, config: { ...entry.config } })
    while (this.recent.size > 32) this.recent.delete(this.recent.keys().next().value!)
    this.emit(owner, { sessionId: id, type: 'closed', data: '连接已断开' })
    await Promise.allSettled([entry.ssh?.close(), entry.adapter?.close(), entry.tunnel?.close()])
  }
  write(owner: number, id: string, data: string, channelId?: string) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) throw new Error('终端输入无效')
    this.get(owner, id).ssh?.write(data, channelId)
  }
  resize(owner: number, id: string, cols: number, rows: number, channelId?: string) {
    if (![cols, rows].every((v) => Number.isInteger(v) && v >= 1 && v <= 1000))
      throw new Error('终端尺寸无效')
    this.get(owner, id).ssh?.resize(cols, rows, channelId)
  }
  ack(owner: number, id: string, bytes: number, channelId?: string) {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > 1024 * 1024)
      throw new Error('终端确认参数无效')
    this.get(owner, id).ssh?.ack(bytes, channelId)
  }
  async closeOwner(owner: number) {
    await Promise.allSettled(
      [...this.entries]
        .filter(([, e]) => e.owner === owner)
        .map(([id]) => this.disconnect(owner, id)),
    )
    for (const [id, entry] of this.recent) if (entry.owner === owner) this.recent.delete(id)
  }
}
