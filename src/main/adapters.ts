import { createConnection as connectSocket, isIP } from 'node:net'
import { Worker } from 'node:worker_threads'
import type { Duplex } from 'node:stream'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import mysql, {
  type Connection as MysqlConnection,
  type FieldPacket,
  type RowDataPacket,
} from 'mysql2'
import pg from 'pg'
import type { ConnectionConfig, QueryResult, Cell, SqliteToolRequest } from '../shared/contracts'
import { toCell } from './sqlite'
import { openMongo } from './mongodb'
import type { MongoRequest, MongoResponse } from '../shared/contracts'
import { openRedis } from './redis'
import type { RedisRequest, RedisResponse } from '../shared/contracts'

export interface Adapter {
  execute(command: string, parameters?: Cell[]): Promise<QueryResult>
  close(): Promise<void>
  sqliteTool?(request: SqliteToolRequest): Promise<QueryResult | string>
  mongoRequest?(request: MongoRequest): Promise<MongoResponse>
  redisRequest?(request: RedisRequest): Promise<RedisResponse>
}

const empty = (): QueryResult => ({
  columns: [],
  rows: [],
  affectedRows: 0,
  elapsedMs: 0,
  truncated: false,
})
function collector(result: QueryResult) {
  let bytes = 0
  return (raw: unknown[]) => {
    const row = raw.map(toCell)
    bytes += Buffer.byteLength(JSON.stringify(row))
    if (result.rows.length >= 1000 || bytes > 4 * 1024 * 1024) result.truncated = true
    else result.rows.push(row)
  }
}

export async function openSqlite(path: string): Promise<Adapter> {
  const worker = new Worker(join(__dirname, 'sqlite-worker.js'), { workerData: { path } })
  const pending = new Map<
    string,
    { resolve: (v: QueryResult | string) => void; reject: (e: Error) => void }
  >()
  let closed = false
  const ready = new Promise<void>((resolve, reject) => {
    worker.once('message', (m) =>
      m.ready ? resolve() : reject(new Error(m.error || 'SQLite 启动失败')),
    )
    worker.once('error', reject)
    worker.once('exit', () => reject(new Error('SQLite 工作线程已退出')))
  })
  worker.on('message', (m) => {
    if (!m.requestId) return
    const task = pending.get(m.requestId)
    if (!task) return
    pending.delete(m.requestId)
    if (m.error) task.reject(new Error(m.error))
    else task.resolve(m.result)
  })
  const failAll = () => {
    closed = true
    for (const task of pending.values()) task.reject(new Error('SQLite 会话已关闭或查询已取消'))
    pending.clear()
  }
  worker.on('error', failAll)
  worker.on('exit', failAll)
  try {
    await ready
  } catch (error) {
    await worker.terminate()
    throw error
  }
  const request = (payload: {
    sql?: string
    parameters?: Cell[]
    tool?: SqliteToolRequest
  }): Promise<QueryResult | string> => {
    if (closed) return Promise.reject(new Error('连接已关闭'))
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      pending.set(requestId, { resolve, reject })
      worker.postMessage({ requestId, ...payload })
    })
  }
  return {
    execute: (sql, parameters) => request({ sql, parameters }) as Promise<QueryResult>,
    sqliteTool: (tool) => request({ tool }),
    async close() {
      failAll()
      await worker.terminate()
    },
  }
}

export async function openDatabase(
  config: ConnectionConfig,
  onError: (message: string) => void,
  endpoint?: { host: string; port: number },
): Promise<Adapter> {
  if (config.type === 'mongodb') return openMongo(config)
  if (config.type === 'sqlite') return openSqlite(config.path!)
  if (config.type === 'mysql') {
    if (endpoint && config.tls && isIP(config.host!))
      throw new Error('MySQL 隧道 TLS 请使用证书中的 DNS 主机名')
    const connection: MysqlConnection = mysql.createConnection({
      ...(endpoint ? { stream: () => connectSocket(endpoint.port, endpoint.host) } : {}),
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database || undefined,
      connectTimeout: 10000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      rowsAsArray: true,
      maxPreparedStatements: 128,
      ssl: config.tls ? { rejectUnauthorized: true, verifyIdentity: true } : undefined,
      multipleStatements: false,
    })
    let connected = false
    let rejectActive: ((error: Error) => void) | undefined
    connection.on('error', (e) => {
      rejectActive?.(e)
      rejectActive = undefined
      if (connected) onError(e.message)
    })
    try {
      await new Promise<void>((resolve, reject) =>
        connection.connect((e) => (e ? reject(e) : resolve())),
      )
      connected = true
    } catch (error) {
      connection.destroy()
      throw error
    }
    return {
      execute(sql, parameters) {
        const start = performance.now(),
          result = empty(),
          collect = collector(result)
        return new Promise((resolve, reject) => {
          rejectActive = reject
          // Parameterized table requests use the server binary protocol; query() formats values into SQL text.
          const query =
            parameters === undefined
              ? connection.query({ sql, timeout: 30000 })
              : connection.execute({ sql, values: parameters, timeout: 30000 })
          query.on('fields', (fields: FieldPacket[] | undefined) => {
            result.columns = (fields || []).map((f) => f.name)
          })
          query.on('result', (row: RowDataPacket) => {
            if (Array.isArray(row)) collect(row)
            else result.affectedRows = Number(row.affectedRows || 0)
          })
          query.on('error', (e) => {
            rejectActive = undefined
            reject(e)
          })
          query.on('end', () => {
            rejectActive = undefined
            result.elapsedMs = Math.round(performance.now() - start)
            resolve(result)
          })
        })
      },
      async close() {
        connected = false
        rejectActive?.(new Error('MySQL 查询已取消，连接已关闭'))
        rejectActive = undefined
        connection.destroy()
        // mysql2.destroy() half-closes the socket; destroy its transport to abort promptly.
        ;(connection as MysqlConnection & { stream: Duplex }).stream.destroy()
      },
    }
  }
  if (config.type === 'postgresql') {
    const client = new pg.Client({
      host: endpoint?.host || config.host,
      port: endpoint?.port || config.port,
      user: config.username,
      password: config.password,
      database: config.database || undefined,
      connectionTimeoutMillis: 10000,
      statement_timeout: 30000,
      ssl: config.tls
        ? {
            rejectUnauthorized: true,
            ...(endpoint
              ? { host: config.host, servername: isIP(config.host!) ? undefined : config.host }
              : {}),
          }
        : undefined,
    })
    let connected = false
    client.on('error', (e) => {
      if (connected) onError(e.message)
    })
    try {
      await client.connect()
      connected = true
    } catch (error) {
      await client.end().catch(() => {})
      throw error
    }
    return {
      execute(sql, parameters) {
        const result = empty(),
          start = performance.now()
        let collect = collector(result)
        let activeResult: pg.QueryResult | undefined
        const selectResult = (r: pg.QueryResult) => {
          if (activeResult === r) return
          activeResult = r
          result.rows = []
          result.truncated = false
          collect = collector(result)
        }
        return new Promise((resolve, reject) => {
          // Simple protocol accepts scripts, including function bodies and quoted semicolons.
          const options: pg.QueryArrayConfig = { text: sql, values: parameters, rowMode: 'array' }
          const query = new pg.Query(options)
          query.on('row', (row: unknown[], r) => {
            if (r) selectResult(r)
            collect(row)
          })
          query.on('error', reject)
          query.on('end', (results) => {
            const r: pg.QueryResult = Array.isArray(results) ? results[results.length - 1] : results
            selectResult(r)
            result.columns = r.fields.map((f) => f.name)
            result.affectedRows = r.rowCount || 0
            result.elapsedMs = Math.round(performance.now() - start)
            resolve(result)
          })
          client.query(query)
        })
      },
      async close() {
        connected = false
        await client.end()
      },
    }
  }
  return openRedis(config, onError, endpoint)
}
