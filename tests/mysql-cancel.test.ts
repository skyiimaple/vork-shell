import { EventEmitter } from 'node:events'
import { it, expect, vi } from 'vitest'
const mock = vi.hoisted(() => ({ createConnection: vi.fn() }))
vi.mock('mysql2', () => ({ default: { createConnection: mock.createConnection } }))
import { openDatabase } from '../src/main/adapters'
it('rejects an in-flight MySQL query when cancelling its connection', async () => {
  // mysql2.close() may emit no query error; simulate that documented transport behavior.
  const query = new EventEmitter()
  const connection = Object.assign(new EventEmitter(), {
    connect: (callback: (e?: Error) => void) => callback(),
    query: () => query,
    destroy: vi.fn(),
    stream: { destroy: vi.fn() },
  })
  mock.createConnection.mockReturnValueOnce(connection)
  const adapter = await openDatabase(
    { type: 'mysql', name: 'test', host: 'localhost', port: 3306, username: 'test' },
    () => {},
  )
  const running = adapter.execute('SELECT 1')
  const outcome = running.catch((e) => e.message)
  await adapter.close()
  expect(
    await Promise.race([
      outcome,
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 100)),
    ]),
  ).toMatch(/取消|关闭/)
})

it('uses binary prepared statements for table parameters and accepts writes without fields', async () => {
  const query = new EventEmitter()
  const connection = Object.assign(new EventEmitter(), {
    connect: (callback: (e?: Error) => void) => callback(),
    query: vi.fn(),
    execute: vi.fn(() => query),
    destroy: vi.fn(),
    stream: { destroy: vi.fn() },
  })
  mock.createConnection.mockReturnValueOnce(connection)
  const adapter = await openDatabase(
    { type: 'mysql', name: 'test', host: 'localhost', port: 3306, username: 'test' },
    () => {},
  )
  const value = "quoted ' \\ --"
  const result = adapter.execute('UPDATE items SET title=? WHERE id=?', [value, '9007199254740993'])
  expect(connection.execute).toHaveBeenCalledWith({
    sql: 'UPDATE items SET title=? WHERE id=?',
    values: [value, '9007199254740993'],
    timeout: 30000,
  })
  expect(connection.query).not.toHaveBeenCalled()
  query.emit('fields', undefined)
  query.emit('result', { affectedRows: 1 })
  query.emit('end')
  expect((await result).affectedRows).toBe(1)
  await adapter.close()
})
