import { profileIdentity } from '../shared/connection-identity'
export { profileIdentity } from '../shared/connection-identity'
import { randomUUID } from 'node:crypto'
import type { ConnectionConfig, ConnectionImportPreview } from '../shared/contracts'
import { validateConnection } from './validation'
export interface ParsedConnection {
  name: string
  config?: ConnectionConfig
  error?: string
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
export function parseConnectionImport(text: string): ParsedConnection[] {
  if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('配置文件不能超过 2 MiB')
  let payload: unknown
  try {
    let source = text.replace(/^\uFEFF/, '').trim()
    if (!source.startsWith('[') && !source.startsWith('{')) {
      if (!/^[A-Za-z0-9+/=\s]+$/.test(source)) throw new Error()
      source = Buffer.from(source.replace(/\s/g, ''), 'base64').toString('utf8')
    }
    payload = JSON.parse(source)
  } catch {
    throw new Error('无法识别配置文件，请选择 .ano 或 Redis 连接 JSON 导出文件')
  }
  const wrapper = object(payload)
  const entries = Array.isArray(payload) ? payload : wrapper?.connections
  if (!Array.isArray(entries) || !entries.length) throw new Error('配置文件没有连接列表')
  if (entries.length > 500) throw new Error('一次最多导入 500 条连接')
  return entries.map((value, index) => {
    const row = object(value)
    const name =
      typeof row?.name === 'string' && row.name.trim()
        ? row.name.trim().slice(0, 100)
        : `Redis 连接 ${index + 1}`
    try {
      if (!row) throw new Error('连接条目格式无效')
      if (wrapper?.format === 'vork-shell' && wrapper.version === 1) {
        return { name, config: validateConnection({ ...row, name }) }
      }
      if (row.type !== undefined && row.type !== 'redis') throw new Error('只支持 Redis 连接导出')
      if (row.cluster || row.isCluster) throw new Error('暂不支持导入 Redis Cluster 连接')
      if (row.connectionReadOnly || row.readOnly)
        throw new Error('暂不支持只读连接策略，请手动核对配置')
      if (object(row.sentinelOptions) || row.sentinel || row.sentinel_mode)
        throw new Error('暂不支持导入 Sentinel 连接')
      if (object(row.sshOptions)?.host || row.ssh_host || row.ssh || row.sshProfileId)
        throw new Error('SSH 连接请先手动创建 SSH 配置，再关联 Redis 隧道')
      if (
        (row.tls !== undefined && typeof row.tls !== 'boolean') ||
        (row.ssl !== undefined && typeof row.ssl !== 'boolean')
      )
        throw new Error('TLS 配置无效，请手动核对')
      const ssl = object(row.sslOptions)
      if (
        ssl?.key ||
        ssl?.cert ||
        ssl?.ca ||
        ssl?.servername ||
        row.ssl_ca ||
        row.ssl_cert ||
        row.ssl_key
      )
        throw new Error('暂不支持导入自定义 TLS 证书或 SNI 配置')
      const port =
        typeof row.port === 'number'
          ? row.port
          : typeof row.port === 'string' && /^\d+$/.test(row.port)
            ? Number(row.port)
            : NaN
      const password = row.auth ?? row.password
      const database = row.database ?? row.db
      if (database !== undefined && typeof database !== 'string' && typeof database !== 'number')
        throw new Error('数据库编号无效')
      const config = validateConnection({
        type: 'redis',
        name,
        host: row.host,
        port,
        username: row.username,
        password,
        database: database === undefined ? undefined : String(database),
        tls: Boolean(ssl || row.ssl || row.tls),
      })
      return { name, config }
    } catch (error) {
      return { name, error: error instanceof Error ? error.message : '连接条目无效' }
    }
  })
}

export class ConnectionImportService {
  private pending = new Map<
    number,
    { token: string; created: number; rows: ParsedConnection[]; ready: Set<number> }
  >()
  clear(owner: number) {
    this.pending.delete(owner)
  }
  preview(
    owner: number,
    text: string,
    fileName: string,
    existing: ConnectionConfig[],
  ): ConnectionImportPreview {
    const rows = parseConnectionImport(text),
      identities = new Set(existing.map(profileIdentity)),
      ready = new Set<number>()
    const existingIds = new Map<string, string>()
    for (const row of rows) {
      if (row.config?.type === 'ssh' && row.config.id) {
        const match = existing.find(
          (profile) => profileIdentity(profile) === profileIdentity(row.config!),
        )
        if (match?.id) existingIds.set(row.config.id, match.id)
      }
    }
    for (const row of rows)
      if (row.config?.sshProfileId && existingIds.has(row.config.sshProfileId))
        row.config.sshProfileId = existingIds.get(row.config.sshProfileId)
    const token = randomUUID()
    const preview = rows.map((row, index) => {
      const key = row.config ? profileIdentity(row.config) : ''
      const duplicate = Boolean(row.config && identities.has(key))
      if (row.config) identities.add(key)
      if (row.config && !duplicate) ready.add(index)
      return {
        index,
        name: row.name,
        host: row.config?.host,
        port: row.config?.port,
        hasPassword: Boolean(row.config?.password),
        status: !row.config
          ? ('invalid' as const)
          : duplicate
            ? ('duplicate' as const)
            : ('ready' as const),
        error: row.error,
      }
    })
    this.pending.set(owner, { token, created: Date.now(), rows, ready })
    return { token, fileName, rows: preview }
  }
  async confirm(
    owner: number,
    token: unknown,
    indices: unknown,
    save: (configs: ConnectionConfig[]) => Promise<{ imported: number; skipped: number }>,
  ) {
    const item = this.pending.get(owner)
    if (!item || item.token !== token || Date.now() - item.created > 10 * 60 * 1000) {
      this.clear(owner)
      throw new Error('导入预览已失效，请重新选择文件')
    }
    if (
      !Array.isArray(indices) ||
      !indices.length ||
      indices.length > 500 ||
      new Set(indices).size !== indices.length ||
      indices.some((index) => !Number.isInteger(index) || !item.ready.has(index))
    )
      throw new Error('导入选择无效')
    const result = await save(indices.map((index) => item.rows[index].config!))
    if (this.pending.get(owner) === item) this.clear(owner)
    return result
  }
}
