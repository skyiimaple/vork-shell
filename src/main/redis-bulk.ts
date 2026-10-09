import type { RedisRequest, RedisBulkTtlResult, RedisBulkMutationResult } from '../shared/contracts'
type BulkRequest = Extract<RedisRequest, { kind: 'ttl-batch' | 'expire-batch' | 'delete-batch' }>
export function validateRedisBulk(request: BulkRequest) {
  if (!Array.isArray(request.keys) || !request.keys.length || request.keys.length > 100)
    throw new Error('每批请选择 1 至 100 个键')
  if (
    request.keys.some(
      (key) =>
        typeof key !== 'string' ||
        Buffer.byteLength(key) > 16384 ||
        Buffer.from(key).toString('utf8') !== key,
    )
  )
    throw new Error('键名必须为有效 UTF-8 且不超过 16 KB')
  if (Buffer.byteLength(JSON.stringify(request.keys)) > 3 * 1024 * 1024)
    throw new Error('批量键名编码后超过 3 MB，请缩小选择范围')
  if (new Set(request.keys).size !== request.keys.length) throw new Error('批量键名不能重复')
  if (request.kind === 'expire-batch') {
    if (request.operation !== 'expire' && request.operation !== 'persist')
      throw new Error('TTL 批量操作无效')
    if (
      request.operation === 'expire' &&
      (!Number.isSafeInteger(request.seconds) || request.seconds <= 0)
    )
      throw new Error('TTL 必须为安全范围内的正整数秒数；永久保留请使用清除过期时间')
  }
}
export async function redisBulk(
  request: BulkRequest,
  send: (args: string[]) => Promise<unknown>,
): Promise<RedisBulkTtlResult | RedisBulkMutationResult> {
  if (request.kind === 'ttl-batch') {
    const results: RedisBulkTtlResult['results'] = []
    for (const key of request.keys) {
      try {
        const ttl = Number(await send(['TTL', key]))
        if (!Number.isSafeInteger(ttl) || ttl < -2) throw new Error('Redis TTL 返回格式无效')
        results.push({ key, ok: true, ttl })
      } catch (error) {
        results.push({
          key,
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 512) : '读取 TTL 失败',
        })
      }
    }
    return { kind: 'ttl-batch', results }
  }
  const results: RedisBulkMutationResult['results'] = []
  for (const key of request.keys) {
    try {
      const affected = Number(
        await send(
          request.kind === 'delete-batch'
            ? ['DEL', key]
            : request.operation === 'expire'
              ? ['EXPIRE', key, String(request.seconds)]
              : ['PERSIST', key],
        ),
      )
      if (affected !== 0 && affected !== 1) throw new Error('Redis TTL 修改返回格式无效')
      results.push({ key, ok: true, affected })
    } catch (error) {
      results.push({
        key,
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 512) : '修改 TTL 失败',
      })
    }
  }
  return { kind: 'bulk-mutation', results }
}
