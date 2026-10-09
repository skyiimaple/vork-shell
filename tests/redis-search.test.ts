import { expect, it } from 'vitest'
import { redisSearchPattern, canContinueRedisScan } from '../src/renderer/src/lib/redis-search'
it('uses contains matching for ordinary text and preserves explicit Redis glob patterns', () => {
  expect(redisSearchPattern('fpsb')).toBe('*fpsb*')
  expect(redisSearchPattern(' user:* ')).toBe('user:*')
  expect(redisSearchPattern('')).toBe('*')
})

it('continues scanning empty Redis batches until matches or cursor completion', async () => {
  const { RedisBrowser } = await import('../src/main/redis-browser')
  const cursors: string[] = []
  const browser = new RedisBrowser(async (args) => {
    if (args[0] === 'SELECT') return 'OK'
    cursors.push(args[1])
    return args[1] === '0' ? ['25', []] : ['0', ['fpsb:one']]
  })
  expect(await browser.request({ kind: 'scan', database: 0, match: '*fpsb*' })).toMatchObject({
    cursor: '0',
    keys: ['fpsb:one'],
  })
  expect(cursors).toEqual(['0', '25'])
})
it('bounds empty scanning to keep the session responsive', async () => {
  const { RedisBrowser } = await import('../src/main/redis-browser')
  let scans = 0
  const browser = new RedisBrowser(async (args) =>
    args[0] === 'SELECT' ? 'OK' : [String(++scans), []],
  )
  expect(await browser.request({ kind: 'scan', database: 0, match: '*missing*' })).toMatchObject({
    cursor: '20',
    keys: [],
  })
  expect(scans).toBe(20)
})

it('stops automatic continuation when the next page fails and permits explicit error-free retry', () => {
  const empty = {
    closed: false,
    keys: 0,
    hasNext: true,
    fetching: false,
    error: false,
    attempts: 1,
  }
  expect(canContinueRedisScan(empty)).toBe(true)
  expect(canContinueRedisScan({ ...empty, error: true })).toBe(false)
  expect(canContinueRedisScan({ ...empty, attempts: 100 })).toBe(false)
})
