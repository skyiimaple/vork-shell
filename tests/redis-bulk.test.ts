import { expect, test } from 'vitest'
import { RedisBrowser } from '../src/main/redis-browser'
function fixture() {
  const databases = new Map<number, Map<string, number>>([
    [
      0,
      new Map([
        ['expiring', 30],
        ['permanent', -1],
        ['', -1],
      ]),
    ],
    [
      2,
      new Map([
        ['expiring', 70],
        ['permanent', -1],
      ]),
    ],
  ])
  let database = 0
  const browser = new RedisBrowser(async (args) => {
    if (args[0] === 'SELECT') {
      database = Number(args[1])
      return 'OK'
    }
    const keys = databases.get(database)!
    if (args[1] === 'denied') throw new Error('NOPERM this key is denied')
    if (args[0] === 'TTL') return keys.get(args[1]) ?? -2
    if (args[0] === 'EXPIRE') {
      if (!keys.has(args[1])) return 0
      keys.set(args[1], Number(args[2]))
      return 1
    }
    if (args[0] === 'PERSIST') {
      if (!keys.has(args[1]) || keys.get(args[1]) === -1) return 0
      keys.set(args[1], -1)
      return 1
    }
    throw new Error('unexpected command')
  })
  return {
    browser,
    databases,
    get database() {
      return database
    },
  }
}
test('batch TTL reports missing, permanent, empty and expiring keys in requested database, continuing after key errors', async () => {
  const { browser } = fixture()
  const reply = await browser.request({
    kind: 'ttl-batch',
    database: 2,
    keys: ['permanent', 'denied', 'expiring', 'missing'],
  })
  expect(reply).toEqual({
    kind: 'ttl-batch',
    results: [
      { key: 'permanent', ok: true, ttl: -1 },
      { key: 'denied', ok: false, error: 'NOPERM this key is denied' },
      { key: 'expiring', ok: true, ttl: 70 },
      { key: 'missing', ok: true, ttl: -2 },
    ],
  })
  expect(await browser.request({ kind: 'ttl-batch', database: 0, keys: [''] })).toMatchObject({
    results: [{ key: '', ttl: -1 }],
  })
})
test('batch TTL mutation preserves individual success, no-change and error while leaving other databases unchanged', async () => {
  const { browser, databases } = fixture()
  const reply = await browser.request({
    kind: 'expire-batch',
    operation: 'expire',
    database: 2,
    keys: ['expiring', 'denied', 'missing', 'permanent'],
    seconds: 120,
  })
  expect(reply).toEqual({
    kind: 'bulk-mutation',
    results: [
      { key: 'expiring', ok: true, affected: 1 },
      { key: 'denied', ok: false, error: 'NOPERM this key is denied' },
      { key: 'missing', ok: true, affected: 0 },
      { key: 'permanent', ok: true, affected: 1 },
    ],
  })
  expect(databases.get(0)!.get('expiring')).toBe(30)
  expect(databases.get(2)!.get('permanent')).toBe(120)
  await browser.request({
    kind: 'expire-batch',
    operation: 'persist',
    database: 2,
    keys: ['expiring', 'permanent'],
  })
  expect(
    await browser.request({ kind: 'ttl-batch', database: 2, keys: ['expiring', 'permanent'] }),
  ).toMatchObject({ results: [{ ttl: -1 }, { ttl: -1 }] })
})
test('invalid bulk inputs reject before database selection or modifying any key', async () => {
  const state = fixture()
  for (const request of [
    { kind: 'ttl-batch', keys: [] },
    { kind: 'ttl-batch', keys: Array(101).fill('expiring') },
    { kind: 'ttl-batch', keys: ['a', 'a'] },
    { kind: 'ttl-batch', keys: ['bad\ud800'] },
    { kind: 'ttl-batch', keys: ['x'.repeat(16385)] },
    {
      kind: 'ttl-batch',
      keys: Array.from({ length: 100 }, (_, i) => String(i) + '\u0000'.repeat(16000)),
    },
    { kind: 'expire-batch', operation: 'expire', keys: ['expiring'], seconds: 0 },
    { kind: 'expire-batch', operation: 'expire', keys: ['expiring'], seconds: -1 },
    { kind: 'expire-batch', operation: 'expire', keys: ['expiring'], seconds: 1.1 },
    {
      kind: 'expire-batch',
      operation: 'expire',
      keys: ['expiring'],
      seconds: Number.MAX_SAFE_INTEGER + 1,
    },
    { kind: 'expire-batch', operation: 'delete', keys: ['expiring'] },
  ])
    await expect(state.browser.request({ database: 2, ...request } as any)).rejects.toThrow()
  expect(state.database).toBe(0)
  expect(state.databases.get(2)!.get('expiring')).toBe(70)
})

test('batch deletion reports missing keys and continues after a failure', async () => {
  const { redisBulk, validateRedisBulk } = await import('../src/main/redis-bulk')
  const request = {
    kind: 'delete-batch' as const,
    database: 0,
    keys: ['exists', 'denied', 'missing'],
  }
  validateRedisBulk(request)
  const calls: string[][] = []
  const result = await redisBulk(request, async (args) => {
    calls.push(args)
    if (args[1] === 'denied') throw new Error('Permission denied')
    return args[1] === 'exists' ? 1 : 0
  })
  expect(calls).toEqual([
    ['DEL', 'exists'],
    ['DEL', 'denied'],
    ['DEL', 'missing'],
  ])
  expect(result).toEqual({
    kind: 'bulk-mutation',
    results: [
      { key: 'exists', ok: true, affected: 1 },
      { key: 'denied', ok: false, error: 'Permission denied' },
      { key: 'missing', ok: true, affected: 0 },
    ],
  })
})
