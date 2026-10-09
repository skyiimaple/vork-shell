import type { RedisRequest } from '../shared/contracts'
type Member = Extract<RedisRequest, { kind: 'member' }>
export function memberCommand(request: Member): string[] {
  const { collection, operation } = request
  const text = (value: unknown, max = 65536): string => {
    if (typeof value !== 'string' || Buffer.byteLength(value) > max)
      throw new Error('成员参数无效或过大')
    return value
  }
  let body: string, args: string[]
  if (collection === 'hash' && ['add', 'update', 'remove'].includes(operation)) {
    args = [text(request.member, 16384)]
    if (operation === 'add') {
      args.push(text(request.value))
      body =
        "if redis.call('HEXISTS',KEYS[1],ARGV[2])==1 then return -4 end; return redis.call('HSET',KEYS[1],ARGV[2],ARGV[3])"
    } else {
      args.push(text(request.expected))
      body =
        "if redis.call('HGET',KEYS[1],ARGV[2])~=ARGV[3] then return -2 end; " +
        (operation === 'remove'
          ? "return redis.call('HDEL',KEYS[1],ARGV[2])"
          : "return redis.call('HSET',KEYS[1],ARGV[2],ARGV[4])")
      if (operation === 'update') args.push(text(request.value))
    }
  } else if (
    collection === 'list' &&
    ['update', 'push-head', 'push-tail', 'pop-head', 'pop-tail'].includes(operation)
  ) {
    if (operation.startsWith('push')) {
      args = [text(request.value)]
      body = `return redis.call('${operation === 'push-head' ? 'LPUSH' : 'RPUSH'}',KEYS[1],ARGV[2])`
    } else {
      const index = operation === 'pop-head' ? 0 : operation === 'pop-tail' ? -1 : request.index
      if (
        !Number.isSafeInteger(index) ||
        index === undefined ||
        (operation === 'update' && index < 0)
      )
        throw new Error('列表索引无效')
      args = [String(index), text(request.expected)]
      body = "if redis.call('LINDEX',KEYS[1],ARGV[2])~=ARGV[3] then return -2 end; "
      if (operation === 'update') {
        args.push(text(request.value))
        body += "redis.call('LSET',KEYS[1],ARGV[2],ARGV[4]); return 1"
      } else body += `redis.call('${operation === 'pop-head' ? 'LPOP' : 'RPOP'}',KEYS[1]); return 1`
    }
  } else if (collection === 'set' && ['add', 'remove'].includes(operation)) {
    args = [text(request.member, 16384)]
    body = `return redis.call('${operation === 'add' ? 'SADD' : 'SREM'}',KEYS[1],ARGV[2])`
  } else if (collection === 'zset' && ['add', 'update', 'remove'].includes(operation)) {
    args = [text(request.member, 16384)]
    if (operation === 'add') body = "if redis.call('ZSCORE',KEYS[1],ARGV[2]) then return -4 end; "
    else {
      args.push(text(request.expected))
      body = "if redis.call('ZSCORE',KEYS[1],ARGV[2])~=ARGV[3] then return -2 end; "
    }
    if (operation === 'remove') body += "return redis.call('ZREM',KEYS[1],ARGV[2])"
    else {
      if (
        typeof request.score !== 'string' ||
        !request.score.trim() ||
        !Number.isFinite(Number(request.score))
      )
        throw new Error('分数必须为有限数字')
      args.push(String(Number(request.score)))
      body += `return redis.call('ZADD',KEYS[1],ARGV[${args.length + 1}],ARGV[2])`
    }
  } else throw new Error('此集合不支持该操作')
  return [
    'EVAL',
    "if redis.call('TYPE',KEYS[1]).ok~=ARGV[1] then return -3 end; " + body,
    '1',
    request.key,
    collection,
    ...args,
  ]
}
