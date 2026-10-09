import { randomUUID } from 'node:crypto'
import { BSON, MongoClient, type Document, type MongoClientOptions } from 'mongodb'
import type { ConnectionConfig, MongoRequest, MongoResponse } from '../shared/contracts'
import type { Adapter } from './adapters'

const MAX_BYTES = 4 * 1024 * 1024
const stringify = (value: unknown) => BSON.EJSON.stringify(value, { relaxed: false })
export function parseMongoDocument(text: unknown): Document {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 1024 * 1024)
    throw new Error('JSON 文档为空或超过 1 MiB')
  let value: unknown
  try {
    value = BSON.EJSON.parse(text, { relaxed: false })
  } catch {
    throw new Error('请输入有效的 JSON 或 Extended JSON 文档')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('文档必须是 JSON 对象')
  return value as Document
}
export function mongoClientOptions(config: ConnectionConfig): MongoClientOptions {
  return {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    timeoutMS: 25000,
    maxPoolSize: 4,
    promoteLongs: false,
    promoteValues: false,
    tls: Boolean(config.tls),
    ...(config.username
      ? {
          auth: { username: config.username, password: config.password || '' },
          authSource: config.authSource || 'admin',
        }
      : {}),
  }
}
function name(value: unknown, database = false): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > (database ? 63 : 255) ||
    /\0/.test(value) ||
    (database && /[/\\. "$]/.test(value))
  )
    throw new Error(database ? '数据库名称无效' : '集合名称无效')
}
function prohibitScripts(value: unknown) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (['$where', '$function', '$accumulator'].includes(key))
      throw new Error('查询不支持服务器端 JavaScript')
    prohibitScripts(child)
  }
}
export function validateMongoRequest(input: unknown): MongoRequest {
  if (!input || typeof input !== 'object') throw new Error('MongoDB 请求无效')
  const r = input as MongoRequest
  if (['databases', 'info'].includes(r.kind)) return r
  if (r.kind === 'replace' || r.kind === 'delete') {
    if (
      typeof r.snapshotId !== 'string' ||
      !r.snapshotId ||
      r.snapshotId.length > 100 ||
      !Number.isInteger(r.rowIndex) ||
      r.rowIndex < 0 ||
      r.rowIndex >= 100
    )
      throw new Error('文档快照无效，请重新查询')
    if (r.kind === 'replace') parseMongoDocument(r.document)
    return r
  }
  if (!['collections', 'find', 'indexes', 'insert'].includes(r.kind))
    throw new Error('不支持的 MongoDB 操作')
  if (!('database' in r)) throw new Error('数据库名称无效')
  name(r.database, true)
  if (r.kind === 'collections') return r
  name(r.collection)
  if (r.kind === 'insert') parseMongoDocument(r.document)
  if (r.kind === 'find') {
    if (
      !Number.isInteger(r.page) ||
      r.page < 0 ||
      r.page > 10000 ||
      !Number.isInteger(r.pageSize) ||
      r.pageSize < 1 ||
      r.pageSize > 100
    )
      throw new Error('分页参数无效（每页最多 100 条）')
    prohibitScripts(parseMongoDocument(r.filter))
    const sort = parseMongoDocument(r.sort || '{}')
    if (Object.values(sort).some((v) => ![1, -1].includes(Number(v))))
      throw new Error('排序值只能为 1 或 -1')
  }
  return r
}
interface Snapshot {
  id: string
  database: string
  collection: string
  documents: Document[]
}
export class MongoBrowser {
  private snapshot?: Snapshot
  constructor(
    private client: MongoClient,
    private defaultDatabase?: string,
  ) {}
  clear() {
    this.snapshot = undefined
  }
  async request(input: MongoRequest): Promise<MongoResponse> {
    const r = validateMongoRequest(input)
    if (r.kind === 'info') {
      const result = await this.client.db(this.defaultDatabase || 'admin').command({ buildInfo: 1 })
      return { kind: 'info', version: String(result.version), database: this.defaultDatabase || '' }
    }
    if (r.kind === 'databases') {
      const result = await this.client
        .db('admin')
        .admin()
        .listDatabases({ nameOnly: true, authorizedDatabases: true })
      const databases = result.databases.map((db) => db.name)
      if (this.defaultDatabase && !databases.includes(this.defaultDatabase))
        databases.push(this.defaultDatabase)
      return {
        kind: 'databases',
        names: databases.sort().slice(0, 2000),
        truncated: databases.length > 2000,
        defaultDatabase: this.defaultDatabase,
      }
    }
    if (r.kind === 'collections') {
      const cursor = this.client.db(r.database).listCollections({}, { nameOnly: true })
      const names: string[] = []
      try {
        for await (const collection of cursor) {
          if (names.length >= 2000)
            return { kind: 'collections', names: names.sort(), truncated: true }
          names.push(collection.name)
        }
      } finally {
        await cursor.close()
      }
      return { kind: 'collections', names: names.sort(), truncated: false }
    }
    if (r.kind === 'replace' || r.kind === 'delete') {
      const snapshot = this.snapshot
      const original = snapshot?.documents[r.rowIndex]
      if (!snapshot || snapshot.id !== r.snapshotId || !original || original._id === undefined)
        throw new Error('文档快照已失效，请重新查询')
      const collection = this.client.db(snapshot.database).collection(snapshot.collection)
      const filter = { _id: original._id, $expr: { $eq: ['$$ROOT', { $literal: original }] } }
      if (r.kind === 'replace') {
        const replacement = parseMongoDocument(r.document)
        if (stringify(replacement._id) !== stringify(original._id))
          throw new Error('_id 不允许修改或删除')
        const result = await collection.replaceOne(filter, replacement, {
          collation: { locale: 'simple' },
        })
        if (!result.matchedCount) throw new Error('文档已被其他客户端修改或删除，请重新查询')
      } else {
        const result = await collection.deleteOne(filter, { collation: { locale: 'simple' } })
        if (!result.deletedCount) throw new Error('文档已被其他客户端修改或删除，请重新查询')
      }
      this.clear()
      return { kind: 'mutation', affected: 1 }
    }
    const collection = this.client.db(r.database).collection(r.collection)
    if (r.kind === 'insert') {
      await collection.insertOne(parseMongoDocument(r.document))
      this.clear()
      return { kind: 'mutation', affected: 1 }
    }
    if (r.kind === 'indexes') {
      const cursor = collection.listIndexes()
      const documents: string[] = []
      let bytes = 0
      try {
        for await (const index of cursor) {
          const text = stringify(index)
          bytes += Buffer.byteLength(text)
          if (documents.length >= 100 || bytes > MAX_BYTES)
            return { kind: 'indexes', documents, truncated: true }
          documents.push(text)
        }
      } finally {
        await cursor.close()
      }
      return { kind: 'indexes', documents, truncated: false }
    }
    this.clear()
    const start = performance.now()
    const sortDocument = parseMongoDocument(r.sort || '{}')
    const sort = Object.fromEntries(
      Object.entries(sortDocument).map(([key, value]) => [key, Number(value) as 1 | -1]),
    )
    if (!Object.keys(sort).length) sort._id = 1
    const cursor = collection
      .find(parseMongoDocument(r.filter), { maxTimeMS: 20000 })
      .sort(sort)
      .skip(r.page * r.pageSize)
      .limit(r.pageSize + 1)
      .batchSize(r.pageSize + 1)
    const documents: string[] = [],
      originals: Document[] = []
    let bytes = 0,
      hasNext = false,
      truncated = false
    try {
      for await (const doc of cursor) {
        if (documents.length >= r.pageSize) {
          hasNext = true
          break
        }
        const text = stringify(doc)
        bytes += Buffer.byteLength(text)
        if (bytes > MAX_BYTES) {
          truncated = true
          break
        }
        documents.push(text)
        originals.push(doc)
      }
    } finally {
      await cursor.close()
    }
    const id = randomUUID()
    this.snapshot = { id, database: r.database, collection: r.collection, documents: originals }
    return {
      kind: 'documents',
      documents,
      snapshotId: id,
      page: r.page,
      pageSize: r.pageSize,
      hasNext,
      truncated,
      elapsedMs: Math.round(performance.now() - start),
    }
  }
}
export async function openMongo(config: ConnectionConfig): Promise<Adapter> {
  const host = config.host!.includes(':') ? `[${config.host}]` : config.host
  const client = new MongoClient(`mongodb://${host}:${config.port}`, mongoClientOptions(config))
  try {
    await client.connect()
    await client.db(config.database || 'admin').command({ ping: 1 })
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
  const browser = new MongoBrowser(client, config.database)
  return {
    async execute() {
      throw new Error('MongoDB 请使用文档工作区的 JSON 查询')
    },
    mongoRequest: (request) => browser.request(request),
    async close() {
      browser.clear()
      await client.close()
    },
  }
}
