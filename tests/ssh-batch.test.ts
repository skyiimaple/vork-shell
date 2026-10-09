import { expect, test } from 'vitest'
import { join } from 'node:path'
import { safeRemoteBasename, runTransferBatch, registerSshBatch } from '../src/main/ssh-batch'
test('rejects unsafe selected filenames and keeps safe basenames inside the destination', () => {
  for (const name of ['..', '.', '../escape', 'a/b', 'a\\b', 'bad\0name', 'bad�name', ''])
    expect(() => safeRemoteBasename(name)).toThrow()
  expect(safeRemoteBasename('hello.txt')).toBe('hello.txt')
})
test('batch outcomes retain a failure between successful transfers without overwriting local names', async () => {
  const calls: string[] = []
  const result = await runTransferBatch(
    'download',
    ['/hello.txt', '/missing.txt', '/last.txt'],
    '/chosen',
    async (kind, remote, local, options) => {
      calls.push(remote)
      expect(kind).toBe('download')
      expect(local).toBe(join('/chosen', remote.slice(1)))
      expect(options).toEqual({ noOverwrite: true })
      if (remote.includes('missing')) throw new Error('missing remote file')
      return { kind: 'transfer', file: local, bytes: 4, canceled: false }
    },
  )
  expect(calls).toHaveLength(3)
  expect(result).toMatchObject({
    canceled: false,
    results: [
      { name: 'hello.txt', ok: true, bytes: 4 },
      { name: 'missing.txt', ok: false, error: 'missing remote file' },
      { name: 'last.txt', ok: true },
    ],
  })
  await expect(
    runTransferBatch('upload', Array(101).fill('/local/a'), '/remote', async () => {
      throw new Error('must not transfer')
    }),
  ).rejects.toThrow('100')
})
test('duplicate basenames have individual failure and only one publication', async () => {
  const calls: string[] = []
  const result = await runTransferBatch(
    'upload',
    ['/a/same.txt', '/b/same.txt'],
    '/remote',
    async (_kind, remote) => {
      calls.push(remote)
      return { kind: 'transfer', file: remote, bytes: 1, canceled: false }
    },
  )
  expect(calls).toEqual(['/remote/same.txt'])
  expect(result.results.map((result) => result.ok)).toEqual([true, false])
})
test('batch IPC verifies ownership before and after native selection and never reads renderer local paths', async () => {
  let action: any,
    owned = 0
  registerSshBatch(
    (_channel, handler) => {
      action = handler
    },
    {
      getSsh(owner: number, id: string) {
        expect(owner).toBe(1)
        expect(id).toBe('session')
        owned++
        return {
          tools: {
            transfer: async () => ({
              kind: 'transfer',
              file: '/remote/a',
              bytes: 2,
              canceled: false,
            }),
          },
        }
      },
    } as any,
    async () => ['/trusted/a'],
    async () => null,
  )
  const uploaded = await action(1, 'session', 'upload', '/remote')
  expect(uploaded.results[0]).toMatchObject({ name: 'a', ok: true })
  expect(owned).toBeGreaterThanOrEqual(2)
  const canceled = await action(1, 'session', 'download', ['/remote/a'])
  expect(canceled).toEqual({ kind: 'batch-transfer', canceled: true, results: [] })
})
test('a canceled file stops the rest of the batch and retains completed outcomes', async () => {
  const started: string[] = []
  const result = await runTransferBatch(
    'download',
    ['/first', '/cancel', '/never-started'],
    '/chosen',
    async (_kind, remote, local) => {
      started.push(remote)
      return { kind: 'transfer', file: local, bytes: 7, canceled: remote === '/cancel' }
    },
  )
  expect(started).toEqual(['/first', '/cancel'])
  expect(result).toMatchObject({
    canceled: true,
    results: [
      { name: 'first', ok: true, bytes: 7 },
      { name: 'cancel', ok: false, error: '已取消' },
    ],
  })
})
