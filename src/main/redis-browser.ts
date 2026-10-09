import type {
  Cell,
  RedisRequest,
  RedisResponse,
  RedisKeyDetail,
  RedisOverview,
  QueryResult,
} from '../shared/contracts'
import { memberCommand } from './redis-members'
import { redisBulk, validateRedisBulk } from './redis-bulk'
import { parseRedisCommand } from './validation'
import { toCell } from './sqlite'

type Send = (args: string[], binary?: boolean) => Promise<unknown>
const MAX_BYTES = 4 * 1024 * 1024
const STRING_BYTES = 64 * 1024
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Redis 返回格式无效')
  return value
}
function pairs(values: unknown[]): Cell[][] {
  const rows: Cell[][] = []
  for (let i = 0; i < values.length; i += 2) rows.push([toCell(values[i]), toCell(values[i + 1])])
  return rows
}
function budget<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES)
    throw new Error('本批结果超过 4 MB，请缩小读取范围或使用 redis-cli；本次结果未保存')
  return value
}
function text(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
}
function validate(request: RedisRequest) {
  if (
    !request ||
    typeof request !== 'object' ||
    !Number.isInteger(request.database) ||
    request.database < 0 ||
    request.database > 2147483647
  )
    throw new Error('Redis 数据库编号无效')
  if (
    ![
      'create',
      'ttl-batch',
      'expire-batch',
      'delete-batch',
      'member',
      'scan',
      'read',
      'info',
      'select',
      'command',
      'expire',
      'persist',
      'delete',
      'rename',
      'set-string',
    ].includes(request.kind)
  )
    throw new Error('Redis 操作无效')
  if (
    request.kind === 'ttl-batch' ||
    request.kind === 'expire-batch' ||
    request.kind === 'delete-batch'
  )
    validateRedisBulk(request)
  if (
    'key' in request &&
    (typeof request.key !== 'string' || Buffer.byteLength(request.key) > 16384)
  )
    throw new Error('键名无效或超过 16 KB')
  if (
    'cursor' in request &&
    request.cursor !== undefined &&
    (typeof request.cursor !== 'string' ||
      !(request.kind === 'scan' ? /^\d{1,20}$/ : /^\d{1,20}(-\d{1,20})?$/).test(request.cursor))
  )
    throw new Error('Redis 游标无效')
  if (
    'count' in request &&
    request.count !== undefined &&
    (!Number.isInteger(request.count) || request.count < 1 || request.count > 1000)
  )
    throw new Error('每批数量必须为 1–1000')
  if (request.kind === 'create') {
    if (!['string', 'hash', 'list', 'set', 'zset', 'stream'].includes(request.type))
      throw new Error('新键类型无效')
    if (typeof request.value !== 'string' || Buffer.byteLength(request.value) > STRING_BYTES)
      throw new Error('初始值超过 64 KiB')
    if (
      ['hash', 'stream'].includes(request.type) &&
      (typeof request.member !== 'string' || Buffer.byteLength(request.member) > STRING_BYTES)
    )
      throw new Error('初始字段无效')
    if (
      request.type === 'zset' &&
      (typeof request.score !== 'string' ||
        !request.score.trim() ||
        !Number.isFinite(Number(request.score)) ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(request.score))
    )
      throw new Error('分数必须是有限数字')
    if (
      request.seconds !== undefined &&
      (!Number.isSafeInteger(request.seconds) ||
        request.seconds < 1 ||
        request.seconds > 2147483647)
    )
      throw new Error('TTL 必须为 1–2147483647 秒')
  }
  if (request.kind === 'member') memberCommand(request)
  if (request.kind === 'scan') {
    if (
      request.match !== undefined &&
      (typeof request.match !== 'string' || request.match.length > 1024)
    )
      throw new Error('搜索模式无效')
    if (request.type && !['string', 'hash', 'list', 'set', 'zset', 'stream'].includes(request.type))
      throw new Error('键类型无效')
  }
  if (request.kind === 'expire' && (!Number.isSafeInteger(request.seconds) || request.seconds <= 0))
    throw new Error('TTL 必须为正整数；永久保留请使用清除过期时间')
  if (
    request.kind === 'rename' &&
    (typeof request.newKey !== 'string' ||
      Buffer.byteLength(request.newKey) > 16384 ||
      request.newKey === request.key)
  )
    throw new Error('请输入不同的新键名（最多 16 KB）')
  if (
    request.kind === 'set-string' &&
    [request.value, request.expected].some(
      (v) => typeof v !== 'string' || Buffer.byteLength(v) > STRING_BYTES,
    )
  )
    throw new Error('编辑值超过 64 KiB，请使用命令控制台')
  if (
    request.kind === 'command' &&
    (typeof request.command !== 'string' || Buffer.byteLength(request.command) > 1024 * 1024)
  )
    throw new Error('命令无效或超过 1 MB')
}

export function commandArguments(command: string): string[] {
  const args = parseRedisCommand(command),
    verb = args[0].toUpperCase()
  if (
    /^(P?SUBSCRIBE|S?SUBSCRIBE|MONITOR|BLPOP|BRPOP|BLMOVE|BRPOPLPUSH|BZPOPMIN|BZPOPMAX|BLMPOP|BZMPOP|WAIT|WAITAOF|SYNC|PSYNC)$/.test(
      verb,
    ) ||
    (['XREAD', 'XREADGROUP'].includes(verb) && args.some((a) => a.toUpperCase() === 'BLOCK'))
  )
    throw new Error('此面板暂不支持订阅或阻塞命令，请使用 SSH redis-cli')
  if (
    [
      'SELECT',
      'MULTI',
      'EXEC',
      'DISCARD',
      'WATCH',
      'UNWATCH',
      'RESET',
      'HELLO',
      'QUIT',
      'AUTH',
    ].includes(verb)
  )
    throw new Error(
      '请通过连接表单或数据库选择切换连接状态；控制台不支持改变会话协议、认证或事务状态',
    )
  if (verb === 'CLIENT' && ['REPLY', 'TRACKING', 'CACHING'].includes(args[1]?.toUpperCase()))
    throw new Error('此控制台不支持改变客户端响应模式')
  return args
}

export function commandResult(value: unknown, elapsedMs: number): QueryResult {
  const all = Array.isArray(value) ? value : [value]
  const rows: Cell[][] = []
  let bytes = 0,
    truncated = false
  for (const item of all) {
    const row = [toCell(item)]
    bytes += Buffer.byteLength(JSON.stringify(row))
    if (rows.length >= 1000 || bytes > MAX_BYTES) {
      truncated = true
      break
    }
    rows.push(row)
  }
  return { columns: ['result'], rows, affectedRows: 0, elapsedMs, truncated }
}

export class RedisBrowser {
  constructor(private send: Send) {}
  async request(request: RedisRequest): Promise<RedisResponse> {
    validate(request)
    // SessionManager serializes these operations; SELECT never races another operation.
    await this.send(['SELECT', String(request.database)])
    if (request.kind === 'select') return { kind: 'mutation', affected: 0 }
    if (
      request.kind === 'ttl-batch' ||
      request.kind === 'expire-batch' ||
      request.kind === 'delete-batch'
    )
      return budget(await redisBulk(request, this.send))
    if (request.kind === 'scan') {
      const args = [
        'SCAN',
        request.cursor || '0',
        'MATCH',
        request.match || '*',
        'COUNT',
        String(request.count || 200),
      ]
      if (request.type) args.push('TYPE', request.type)
      let reply: unknown[] = []
      const started = Date.now()
      for (let i = 0; i < 20; i++) {
        reply = array(await this.send(args, true))
        if (
          array(reply[1]).length ||
          text(reply[0]) === '0' ||
          Date.now() - started >= 250 ||
          ((!request.match || request.match === '*') && !request.type)
        )
          break
        args[1] = text(reply[0])
      }
      const keys = array(reply[1]).map((value) => {
        const decoded = text(value)
        if (Buffer.isBuffer(value) && !Buffer.from(decoded).equals(value))
          throw new Error('本批包含非 UTF-8 键名，无法安全浏览；请缩小匹配范围或使用 redis-cli')
        return decoded
      })
      return budget({ kind: 'scan', cursor: text(reply[0]), keys: [...new Set(keys)] })
    }
    if (request.kind === 'member') {
      const affected = Number(await this.send(memberCommand(request)))
      if (affected === -3) throw new Error('键不存在或集合类型已改变，请刷新')
      if (affected === -2) throw new Error('成员已被其他客户端修改，请刷新后操作')
      if (affected === -4) throw new Error('成员已存在，新增操作不会覆盖')
      return { kind: 'mutation', affected }
    }
    if (request.kind === 'create') {
      const scripts = {
        string: "redis.call('SET',KEYS[1],ARGV[1])",
        hash: "redis.call('HSET',KEYS[1],ARGV[2],ARGV[1])",
        list: "redis.call('RPUSH',KEYS[1],ARGV[1])",
        set: "redis.call('SADD',KEYS[1],ARGV[1])",
        zset: "redis.call('ZADD',KEYS[1],ARGV[3],ARGV[1])",
        stream: "redis.call('XADD',KEYS[1],'*',ARGV[2],ARGV[1])",
      }
      // Preflight EXPIRE against the absent key before creating; Lua errors do not roll back writes.
      const script =
        "if redis.call('EXISTS',KEYS[1]) == 1 then return 0 end; if ARGV[4] ~= '' then redis.call('EXPIRE',KEYS[1],ARGV[4]) end; " +
        scripts[request.type] +
        "; if ARGV[4] ~= '' then redis.call('EXPIRE',KEYS[1],ARGV[4]) end; return 1"
      const affected = Number(
        await this.send([
          'EVAL',
          script,
          '1',
          request.key,
          request.value,
          request.member || '',
          request.score || '',
          request.seconds === undefined ? '' : String(request.seconds),
        ]),
      )
      if (!affected) throw new Error('同名键已存在，未覆盖')
      return { kind: 'mutation', affected, newKey: request.key }
    }
    if (request.kind === 'read') return this.read(request)
    if (request.kind === 'info') return this.info()
    if (request.kind === 'command') {
      const args = commandArguments(request.command),
        start = performance.now()
      return {
        kind: 'command',
        result: commandResult(await this.send(args), Math.round(performance.now() - start)),
      }
    }
    let affected = 0
    if (request.kind === 'expire')
      affected = Number(await this.send(['EXPIRE', request.key, String(request.seconds)]))
    if (request.kind === 'persist') affected = Number(await this.send(['PERSIST', request.key]))
    if (request.kind === 'delete') affected = Number(await this.send(['UNLINK', request.key]))
    if (request.kind === 'rename') {
      affected = Number(await this.send(['RENAMENX', request.key, request.newKey]))
      if (!affected) throw new Error('新键名已存在，未覆盖原有数据')
    }
    if (request.kind === 'set-string') {
      // Optimistic compare-and-set guards concurrent edits and preserves the current TTL.
      const script =
        "if redis.call('TYPE',KEYS[1]).ok ~= 'string' then return -1 end; if redis.call('GET',KEYS[1]) ~= ARGV[1] then return -2 end; redis.call('SET',KEYS[1],ARGV[2],'KEEPTTL'); return 1"
      affected = Number(
        await this.send(['EVAL', script, '1', request.key, request.expected, request.value]),
      )
      if (affected === -1) throw new Error('键不存在或类型已改变，请刷新')
      if (affected === -2) throw new Error('值已被其他客户端修改，请刷新后再保存')
    }
    return {
      kind: 'mutation',
      affected,
      ...(request.kind === 'rename' ? { newKey: request.newKey } : {}),
    }
  }
  private async read(request: Extract<RedisRequest, { kind: 'read' }>): Promise<RedisKeyDetail> {
    const { key } = request,
      cursor = request.cursor || '0',
      count = request.count || 200
    const type = text(await this.send(['TYPE', key])),
      ttl = Number(await this.send(['TTL', key]))
    const detail: RedisKeyDetail = {
      kind: 'read',
      key,
      type,
      ttl,
      size: 0,
      columns: [],
      rows: [],
      nextCursor: null,
      truncated: false,
    }
    if (type === 'none') {
      detail.ttl = -2
      return detail
    }
    if (type === 'string') {
      detail.size = Number(await this.send(['STRLEN', key]))
      const value = await this.send(['GETRANGE', key, '0', String(STRING_BYTES - 1)], true)
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(text(value))
      const decoded = buffer.toString('utf8'),
        validText = Buffer.from(decoded).equals(buffer)
      detail.encoding = validText ? 'text' : 'hex'
      detail.text = validText ? decoded : buffer.toString('hex')
      detail.truncated = detail.size > STRING_BYTES
      return budget(detail)
    }
    function decode(value: unknown): unknown {
      if (Buffer.isBuffer(value)) {
        const decoded = value.toString('utf8')
        if (Buffer.from(decoded).equals(value)) return decoded
        detail.binaryMembers = true
        return '0x' + value.toString('hex')
      }
      return Array.isArray(value) ? value.map(decode) : value
    }
    const read = async (args: string[]) => decode(await this.send(args, true))
    const lengths: Record<string, string> = {
      hash: 'HLEN',
      list: 'LLEN',
      set: 'SCARD',
      zset: 'ZCARD',
      stream: 'XLEN',
    }
    if (!lengths[type]) throw new Error(`暂不支持 ${type} 类型，请使用命令控制台`)
    detail.size = Number(await this.send([lengths[type], key]))
    if (type === 'hash' || type === 'set') {
      const reply = array(
        await read([type === 'hash' ? 'HSCAN' : 'SSCAN', key, cursor, 'COUNT', String(count)]),
      )
      const values = array(reply[1])
      detail.columns = type === 'hash' ? ['field', 'value'] : ['member']
      detail.rows = type === 'hash' ? pairs(values) : values.map((v) => [toCell(v)])
      detail.nextCursor = text(reply[0]) === '0' ? null : text(reply[0])
    } else if (type === 'list' || type === 'zset') {
      const offset = Number(cursor)
      if (!Number.isSafeInteger(offset)) throw new Error('分页偏移量无效')
      const values = array(
        await read(
          type === 'list'
            ? ['LRANGE', key, cursor, String(offset + count - 1)]
            : ['ZRANGE', key, cursor, String(offset + count - 1), 'WITHSCORES'],
        ),
      )
      detail.columns = type === 'list' ? ['index', 'value'] : ['member', 'score']
      detail.rows = type === 'list' ? values.map((v, i) => [offset + i, toCell(v)]) : pairs(values)
      const next = offset + detail.rows.length
      detail.nextCursor = next < detail.size && detail.rows.length ? String(next) : null
    } else {
      const values = array(
        await read([
          'XRANGE',
          key,
          cursor === '0' ? '-' : '(' + cursor,
          '+',
          'COUNT',
          String(count),
        ]),
      )
      detail.columns = ['id', 'fields']
      detail.rows = values.map((value) => {
        const pair = array(value)
        return [text(pair[0]), JSON.stringify(pairs(array(pair[1])))]
      })
      detail.nextCursor = values.length === count ? String(detail.rows.at(-1)![0]) : null
    }
    return budget(detail)
  }
  private async info(): Promise<RedisOverview> {
    const keyCount = Number(await this.send(['DBSIZE']))
    const info: Record<string, string> = {}
    for (const section of ['server', 'memory', 'keyspace']) {
      for (const line of text(await this.send(['INFO', section])).split(/\r?\n/)) {
        const colon = line.indexOf(':')
        if (colon > 0 && !line.startsWith('#')) info[line.slice(0, colon)] = line.slice(colon + 1)
      }
    }
    const databases = Object.entries(info)
      .filter(([key]) => /^db\d+$/.test(key))
      .map(([key, value]) => {
        const fields = Object.fromEntries(value.split(',').map((field) => field.split('=')))
        return {
          database: Number(key.slice(2)),
          keys: Number(fields.keys || 0),
          expires: Number(fields.expires || 0),
          avgTtl: Number(fields.avg_ttl || 0),
        }
      })
    let databaseCount: number | undefined
    try {
      const config = array(await this.send(['CONFIG', 'GET', 'databases']))
      const count = Number(config[1])
      if (Number.isInteger(count) && count > 0 && count <= 2147483647) databaseCount = count
    } catch {
      /* Managed services may deny CONFIG; empty DBs remain selectable manually. */
    }
    return { kind: 'info', keyCount, info, databases, databaseCount }
  }
}
