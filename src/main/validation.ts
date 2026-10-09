import { isIP } from 'node:net'
import { splitSqlScript } from '../shared/sql-script'
import type { ConnectionConfig } from '../shared/contracts'

export function validateConnection(input: unknown): ConnectionConfig {
  if (!input || typeof input !== 'object') throw new Error('连接参数无效')
  const c = input as ConnectionConfig
  if (!['ssh', 'sqlite', 'mysql', 'postgresql', 'redis', 'mongodb'].includes(c.type))
    throw new Error('不支持的连接类型')
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 100)
    throw new Error('请输入连接名称（最多 100 字）')
  for (const field of [
    'host',
    'username',
    'password',
    'database',
    'authSource',
    'path',
    'privateKey',
    'passphrase',
  ] as const) {
    if (c[field] !== undefined && (typeof c[field] !== 'string' || c[field]!.length > 16384))
      throw new Error('连接字段无效')
  }
  if (
    c.connectedColor !== undefined &&
    (typeof c.connectedColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(c.connectedColor))
  )
    throw new Error('连接背景色无效')
  if (c.favorite !== undefined && typeof c.favorite !== 'boolean') throw new Error('收藏参数无效')
  if (
    c.group !== undefined &&
    (typeof c.group !== 'string' || c.group.length > 100 || /[\0\r\n]/.test(c.group))
  )
    throw new Error('文件夹名称无效（最多 100 字）')
  if (c.id !== undefined && (typeof c.id !== 'string' || !c.id || c.id.length > 200))
    throw new Error('连接 ID 无效')
  if (c.type === 'sqlite') {
    if (!c.path?.trim()) throw new Error('请选择 SQLite 文件或输入 :memory:')
  } else {
    if (!c.host?.trim() || /[\s/]/.test(c.host)) throw new Error('请输入主机名或 IP 地址')
    if (!Number.isInteger(c.port) || c.port! < 1 || c.port! > 65535)
      throw new Error('端口必须为 1–65535')
    if (!['redis', 'mongodb'].includes(c.type) && !c.username?.trim())
      throw new Error('请输入用户名')
  }
  if (c.type === 'mongodb') {
    if (!isIP(c.host!) && !/^[a-z0-9_][a-z0-9_.-]*$/i.test(c.host!))
      throw new Error('MongoDB 主机请填写 DNS 名称或 IP，不包含连接地址参数')
    for (const value of [c.database, c.authSource])
      if (value && (Buffer.byteLength(value) > 63 || /[/\\. "$\0]/.test(value)))
        throw new Error('MongoDB 数据库名称无效')
    if (c.password && !c.username?.trim()) throw new Error('使用密码认证时请输入用户名')
  }
  if (
    c.type === 'redis' &&
    c.database &&
    (!/^\d+$/.test(c.database) || Number(c.database) > 2147483647)
  )
    throw new Error('Redis 数据库编号必须为非负整数')
  if (
    c.sshProfileId !== undefined &&
    (typeof c.sshProfileId !== 'string' ||
      !c.sshProfileId ||
      c.sshProfileId.length > 200 ||
      !['mysql', 'postgresql', 'redis'].includes(c.type))
  )
    throw new Error('SSH 隧道关联配置无效')
  if (c.type === 'mysql' && c.sshProfileId && c.tls && isIP(c.host!))
    throw new Error(
      'MySQL 隧道使用 TLS 时请填写证书中的 DNS 主机名，当前驱动不支持可靠校验 IP 证书身份',
    )
  if (c.tls !== undefined && typeof c.tls !== 'boolean') throw new Error('TLS 参数无效')
  return { ...c, name: c.name.trim(), group: c.group?.trim() || undefined }
}

export function parseRedisCommand(command: string): string[] {
  const parts: string[] = []
  let token = '',
    quote = '',
    started = false,
    escape = false
  for (const char of command.trim()) {
    if (escape) {
      token += char
      escape = false
      started = true
      continue
    }
    if (char === '\\') {
      escape = true
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ''
      else token += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        parts.push(token)
        token = ''
        started = false
      }
      continue
    }
    token += char
    started = true
  }
  if (escape || quote) throw new Error('命令存在未闭合的引号或转义符')
  if (started) parts.push(token)
  if (!parts.length) throw new Error('请输入命令')
  return parts
}

// Lexical statement splitting respects SQLite strings, identifiers and comments.
export function assertSingleStatement(sql: string): void {
  if (splitSqlScript(sql, 'sqlite').length !== 1) throw new Error('每次请执行单条 SQL 语句')
}
