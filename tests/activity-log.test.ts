import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityLog } from '../src/main/activity-log'
import { exportConnections } from '../src/main/connection-export'
import { parseConnectionImport } from '../src/main/connection-import'
it('persists bounded logs without payloads or credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vork-logs-'))
  try {
    const store = new ActivityLog(dir)
    await store.record(
      'error',
      'connect',
      'Redis',
      'Authentication failed password=secret redis://user:secret@host',
    )
    const rows = await new ActivityLog(dir).list()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain('secret')
    expect(rows[0].action).toBe('connect')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('exports all types as importable JSON without secrets', () => {
  const json = exportConnections([
    { type: 'sqlite', name: 'Local', path: ':memory:', password: 'secret' },
    {
      type: 'ssh',
      name: 'Server',
      host: 'localhost',
      port: 22,
      username: 'root',
      privateKey: '/secret/key',
    },
  ])
  expect(json).not.toContain('secret')
  expect(parseConnectionImport(json).map((row) => row.config?.type)).toEqual(['sqlite', 'ssh'])
})
it('rotates local logs and retains both files for export', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'vork-rotation-'))
  try {
    await mkdir(join(dir, 'logs'))
    await writeFile(
      join(dir, 'logs', 'activity.jsonl'),
      JSON.stringify({
        time: 'old',
        level: 'info',
        action: 'older',
        connection: '',
        message: 'x'.repeat(5 * 1024 * 1024),
      }) + '\n',
    )
    const store = new ActivityLog(dir)
    await Promise.all([
      store.record('info', 'connect', 'first'),
      store.record('info', 'disconnect', 'second'),
    ])
    expect((await store.list()).map((row) => row.action)).toEqual([
      'disconnect',
      'connect',
      'older',
    ])
    expect(await store.exportText()).toContain('older')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('rebuilds SSH references on importing a native JSON bundle', async () => {
  const { ProfileStore } = await import('../src/main/profiles')
  const dir = await mkdtemp(join(tmpdir(), 'vork-native-import-'))
  try {
    const store = new ProfileStore(dir)
    const rows = parseConnectionImport(
      exportConnections([
        {
          id: 'ssh-old',
          type: 'ssh',
          name: 'Tunnel',
          host: 'localhost',
          port: 22,
          username: 'root',
        },
        {
          id: 'redis-old',
          type: 'redis',
          name: 'Redis',
          host: 'localhost',
          port: 6379,
          sshProfileId: 'ssh-old',
        },
      ]),
    )
    await store.importProfiles(rows.map((row) => row.config!))
    const configs = await store.list()
    expect(configs.find((c) => c.type === 'redis')?.sshProfileId).toBe(
      configs.find((c) => c.type === 'ssh')?.id,
    )
    expect(configs.find((c) => c.type === 'ssh')?.id).not.toBe('ssh-old')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
