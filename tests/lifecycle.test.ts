import { describe, it, expect, vi } from 'vitest'
const factories = vi.hoisted(() => ({ openDatabase: vi.fn(), openSsh: vi.fn() }))
vi.mock('../src/main/adapters', () => ({ openDatabase: factories.openDatabase }))
vi.mock('../src/main/ssh', () => ({ openSsh: factories.openSsh }))
import { SessionManager } from '../src/main/sessions'

const config = { type: 'sqlite' as const, name: 'test', path: ':memory:' }
describe('session ownership and lifecycle', () => {
  it('serializes Redis requests across database scopes and cancels queued work on close', async () => {
    let release!: () => void
    const calls: number[] = []
    factories.openDatabase.mockResolvedValueOnce({
      close: async () => {},
      execute: vi.fn(),
      redisRequest: async (request: { database: number }) => {
        calls.push(request.database)
        if (request.database === 0) await new Promise<void>((resolve) => (release = resolve))
        return { kind: 'scan', cursor: '0', keys: [] }
      },
    })
    const manager = new SessionManager(
      () => {},
      async () => true,
    )
    const session = await manager.connect(1, {
      type: 'redis',
      name: 'test',
      host: 'localhost',
      port: 6379,
    })
    const first = manager.redisRequest(1, session.id, { kind: 'scan', database: 0 })
    const second = manager.redisRequest(1, session.id, { kind: 'scan', database: 1 })
    const cancelled = expect(second).rejects.toThrow(/关闭/)
    await vi.waitFor(() => expect(calls).toEqual([0]))
    await manager.disconnect(1, session.id)
    release()
    await first
    await cancelled
    expect(calls).toEqual([0])
  })
  it('closes a connection that finishes opening after its window was destroyed', async () => {
    let finish!: (value: unknown) => void
    factories.openDatabase.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    const close = vi.fn(async () => {}),
      execute = vi.fn()
    const manager = new SessionManager(
      () => {},
      async () => true,
    )
    const opening = manager.connect(10, config)
    await manager.closeOwner(10)
    finish({ close, execute })
    await expect(opening).rejects.toThrow(/关闭/)
    expect(close).toHaveBeenCalledOnce()
  })
  it('denies another window access and prevents concurrent writes', async () => {
    let finish!: () => void
    factories.openDatabase.mockResolvedValueOnce({
      close: async () => {},
      execute: () => new Promise<void>((r) => (finish = r)),
    })
    const manager = new SessionManager(
      () => {},
      async () => true,
    )
    const session = await manager.connect(1, config)
    await expect(manager.execute(2, session.id, 'SELECT 1')).rejects.toThrow(/无权/)
    await expect(
      manager.tableRequest(2, session.id, {
        kind: 'browse',
        table: { schema: 'main', name: 'items' },
        page: 0,
        pageSize: 20,
      }),
    ).rejects.toThrow(/无权/)
    const running = manager.execute(1, session.id, 'SELECT 1')
    await expect(manager.execute(1, session.id, 'INSERT INTO x VALUES (1)')).rejects.toThrow(
      /正在执行/,
    )
    await expect(
      manager.tableRequest(1, session.id, {
        kind: 'browse',
        table: { schema: 'main', name: 'items' },
        page: 0,
        pageSize: 20,
      }),
    ).rejects.toThrow(/正在执行/)
    finish()
    await running
    await manager.disconnect(1, session.id)
    await expect(manager.execute(1, session.id, 'SELECT 1')).rejects.toThrow(/关闭/)
  })
})

it('duplicates owned sessions into an independent resource and retains the profile identity', async () => {
  factories.openDatabase.mockImplementation(async () => {
    let value = 'fresh'
    return {
      close: async () => {},
      execute: async (sql: string) => {
        if (sql !== 'read') value = sql
        return {
          columns: ['value'],
          rows: [[value]],
          affectedRows: 0,
          elapsedMs: 0,
          truncated: false,
        }
      },
    }
  })
  const manager = new SessionManager(
    () => {},
    async () => true,
  )
  const first = await manager.connect(1, { ...config, id: 'saved' })
  await manager.execute(1, first.id, 'changed')
  await expect(manager.duplicate(2, first.id)).rejects.toThrow(/无权/)
  const second = await manager.duplicate(1, first.id)
  expect(second.id).not.toBe(first.id)
  expect(second.profileId).toBe('saved')
  expect((await manager.execute(1, second.id, 'read')).rows).toEqual([['fresh']])
  await manager.disconnect(1, second.id)
  expect((await manager.execute(1, first.id, 'read')).rows).toEqual([['changed']])
  await manager.closeOwner(1)
})
