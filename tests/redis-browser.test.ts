import { describe, it, expect } from 'vitest'
import { RedisBrowser } from '../src/main/redis-browser'
import { buildKeyTree, flattenKeyTree } from '../src/renderer/src/lib/redis-tree'

describe('Redis browser read semantics', () => {
  it('rejects invalid UTF-8 key names before they can alias a textual key', async () => {
    const browser = new RedisBrowser(async (args) =>
      args[0] === 'SELECT' ? 'OK' : ['0', [Buffer.from([0xff]), Buffer.from('�')]],
    )
    await expect(browser.request({ kind: 'scan', database: 0 })).rejects.toThrow(/非 UTF-8/)
  })
  it('keeps a nonzero cursor even if SCAN returns an empty batch, and deduplicates without slicing COUNT', async () => {
    const replies: unknown[] = ['OK', ['17', []], 'OK', ['0', ['x', 'x', 'y', 'z']]]
    const browser = new RedisBrowser(async () => replies.shift())
    const empty = await browser.request({
      kind: 'scan',
      database: 0,
      cursor: '0',
      match: '*',
      count: 2,
    })
    expect(empty).toMatchObject({ keys: [], cursor: '17' })
    const page = await browser.request({
      kind: 'scan',
      database: 0,
      cursor: '17',
      match: '*',
      count: 2,
    })
    expect(page).toMatchObject({ keys: ['x', 'y', 'z'], cursor: '0' })
  })
  it('preserves empty strings and distinguishes a missing key from a persistent key', async () => {
    const replies: unknown[] = ['OK', 'string', -1, 0, '']
    const browser = new RedisBrowser(async () => replies.shift())
    const value = await browser.request({ kind: 'read', database: 1, key: '', cursor: '0' })
    expect(value).toMatchObject({ type: 'string', ttl: -1, size: 0, text: '', truncated: false })
    const missing = new RedisBrowser(async (args) =>
      args[0] === 'SELECT' ? 'OK' : args[0] === 'TYPE' ? 'none' : -2,
    )
    expect(
      await missing.request({ kind: 'read', database: 0, key: 'gone', cursor: '0' }),
    ).toMatchObject({ type: 'none', ttl: -2 })
  })
  it('paginates hash pairs and list indexes with explicit next cursors', async () => {
    const replies: unknown[] = ['OK', 'hash', 42, 3, ['12', ['field', 'value']]]
    const browser = new RedisBrowser(async () => replies.shift())
    expect(
      await browser.request({ kind: 'read', database: 0, key: 'h', cursor: '0' }),
    ).toMatchObject({ rows: [['field', 'value']], nextCursor: '12', ttl: 42 })
    const list = new RedisBrowser(
      async (args) =>
        ({ SELECT: 'OK', TYPE: 'list', TTL: -1, LLEN: 300, LRANGE: ['a', 'b'] })[
          args[0] as 'SELECT'
        ],
    )
    expect(
      await list.request({ kind: 'read', database: 0, key: 'l', cursor: '100', count: 2 }),
    ).toMatchObject({
      rows: [
        [100, 'a'],
        [101, 'b'],
      ],
      nextCursor: '102',
    })
  })
})

describe('Redis browser mutations and database scope', () => {
  it('rejects zero TTL without sending EXPIRE and uses PERSIST explicitly', async () => {
    const calls: string[][] = []
    const browser = new RedisBrowser(async (args) => {
      calls.push(args)
      return args[0] === 'SELECT' ? 'OK' : 1
    })
    await expect(
      browser.request({ kind: 'expire', database: 0, key: 'x', seconds: 0 }),
    ).rejects.toThrow(/正整数/)
    expect(calls.some((c) => c[0] === 'EXPIRE')).toBe(false)
    await browser.request({ kind: 'persist', database: 0, key: 'x' })
    expect(calls.at(-1)).toEqual(['PERSIST', 'x'])
  })
  it('uses RENAMENX and reports collisions instead of overwriting another key', async () => {
    const calls: string[][] = []
    const browser = new RedisBrowser(async (args) => {
      calls.push(args)
      return args[0] === 'SELECT' ? 'OK' : 0
    })
    await expect(
      browser.request({ kind: 'rename', database: 2, key: 'old', newKey: 'new' }),
    ).rejects.toThrow(/存在/)
    expect(calls).toContainEqual(['RENAMENX', 'old', 'new'])
  })
  it('selects the requested database for every operation and forbids implicit SELECT in console', async () => {
    const calls: string[][] = []
    const browser = new RedisBrowser(async (args) => {
      calls.push(args)
      return args[0] === 'SELECT' ? 'OK' : 7
    })
    await browser.request({ kind: 'command', database: 3, command: 'DBSIZE' })
    expect(calls).toEqual([['SELECT', '3'], ['DBSIZE']])
    await expect(
      browser.request({ kind: 'command', database: 3, command: 'SELECT 4' }),
    ).rejects.toThrow(/数据库/)
  })
})

it('keeps leaf and namespace identities distinct, including empty keys and prefix collisions', () => {
  const tree = buildKeyTree(['a:b', 'ab:c', 'a', '', 'a:b'])
  const flattened = flattenKeyTree(tree, new Set(tree.map((n) => n.id)))
  expect(
    flattened
      .filter((n) => n.key !== undefined)
      .map((n) => n.key)
      .sort(),
  ).toEqual(['', 'a', 'a:b', 'ab:c'])
  expect(new Set(flattened.map((n) => n.id)).size).toBe(flattened.length)
})
