import { expect, it, vi } from 'vitest'
import {
  parseConnectionImport,
  profileIdentity,
  ConnectionImportService,
} from '../src/main/connection-import'
import { ProfileStore } from '../src/main/profiles'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const fixture = {
  name: '测试连接',
  host: 'localhost',
  port: '6379',
  auth: 'fake-password',
  username: 'app',
}
it('decodes ano exports and plain JSON without retaining foreign IDs', () => {
  const result = parseConnectionImport(
    Buffer.from(JSON.stringify([{ ...fixture, key: 'foreign-id', order: 1 }])).toString('base64'),
  )
  expect(result[0].config).toMatchObject({
    name: '测试连接',
    type: 'redis',
    port: 6379,
    password: 'fake-password',
  })
  expect(result[0].config?.id).toBeUndefined()
  expect(parseConnectionImport(JSON.stringify({ connections: [fixture] }))).toHaveLength(1)
})
it('keeps per-row errors and refuses unsupported connection modes instead of silently weakening them', () => {
  const result = parseConnectionImport(
    JSON.stringify([
      fixture,
      { ...fixture, cluster: true },
      { ...fixture, connectionReadOnly: true },
      { ...fixture, sshOptions: { host: 'bastion' } },
      { ...fixture, sslOptions: { ca: '/cert' } },
      { ...fixture, port: 70000 },
    ]),
  )
  expect(result.filter((row) => row.config)).toHaveLength(1)
  expect(result.slice(1).every((row) => Boolean(row.error))).toBe(true)
  expect(JSON.stringify(result.slice(1))).not.toContain('fake-password')
})
it('rejects malformed, oversized, or excessive files without echoing source content', () => {
  expect(() => parseConnectionImport('bad-secret')).toThrow('无法识别')
  expect(() => parseConnectionImport('a'.repeat(2 * 1024 * 1024 + 1))).toThrow('2 MiB')
  expect(() =>
    parseConnectionImport(JSON.stringify(Array.from({ length: 501 }, () => fixture))),
  ).toThrow('500')
})
it('compares endpoints and credentials identities independently of names and passwords', () => {
  const a = { type: 'redis' as const, name: 'a', host: 'LOCALHOST', port: 6379, password: 'x' }
  expect(profileIdentity(a)).toBe(
    profileIdentity({ ...a, name: 'b', host: 'localhost', password: 'y', database: '0' }),
  )
  expect(profileIdentity(a)).not.toBe(profileIdentity({ ...a, username: 'app' }))
})
it('imports atomically, skips duplicate endpoints and encrypts credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vork-import-test-'))
  const cipher = {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(v).reverse(),
    decryptString: (v: Buffer) => Buffer.from(v).reverse().toString(),
  }
  try {
    const store = new ProfileStore(dir, cipher),
      config = parseConnectionImport(JSON.stringify([fixture]))[0].config!
    const results = await Promise.all([
      store.importProfiles([config, config]),
      store.importProfiles([config]),
    ])
    expect(results.reduce((n, r) => n + r.imported, 0)).toBe(1)
    expect(await store.list()).toHaveLength(1)
    expect(await readFile(join(dir, 'connections.json'), 'utf8')).not.toContain('fake-password')
    await expect(store.importProfiles([config, { ...config, port: 99999 }])).rejects.toThrow()
    expect(await store.list()).toHaveLength(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('refuses a credential import when encryption is unavailable without writing partial data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vork-import-test-'))
  try {
    const store = new ProfileStore(dir)
    await expect(
      store.importProfiles([
        { type: 'redis', name: 'x', host: 'localhost', port: 6379, password: 'fake-password' },
      ]),
    ).rejects.toThrow('加密')
    expect(await store.list()).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('preview omits credentials, handles duplicates, rejects cross-owner and invalid selections', async () => {
  const service = new ConnectionImportService(),
    source = JSON.stringify([fixture, fixture, { ...fixture, cluster: true }])
  const preview = service.preview(1, source, 'connections.ano', [])
  expect(preview.rows.map((r) => r.status)).toEqual(['ready', 'duplicate', 'invalid'])
  expect(JSON.stringify(preview)).not.toContain('fake-password')
  const save = vi.fn(async () => ({ imported: 1, skipped: 0 }))
  await expect(service.confirm(2, preview.token, [0], save)).rejects.toThrow('失效')
  await expect(service.confirm(1, preview.token, [1], save)).rejects.toThrow('无效')
  expect(save).not.toHaveBeenCalled()
  await service.confirm(1, preview.token, [0], save)
  expect(save).toHaveBeenCalledOnce()
  await expect(service.confirm(1, preview.token, [0], save)).rejects.toThrow('失效')
})
it('cancellation and expiration refuse writes; failed save can be retried', async () => {
  const service = new ConnectionImportService(),
    source = JSON.stringify([fixture])
  let preview = service.preview(1, source, 'connections.ano', [])
  await expect(
    service.confirm(1, preview.token, [0], async () => {
      throw new Error('disk failure')
    }),
  ).rejects.toThrow('disk failure')
  expect(
    await service.confirm(1, preview.token, [0], async () => ({ imported: 1, skipped: 0 })),
  ).toEqual({ imported: 1, skipped: 0 })
  preview = service.preview(1, source, 'connections.ano', [])
  service.clear(1)
  await expect(
    service.confirm(1, preview.token, [0], async () => ({ imported: 1, skipped: 0 })),
  ).rejects.toThrow('失效')
  preview = service.preview(1, source, 'connections.ano', [])
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000)
  try {
    await expect(
      service.confirm(1, preview.token, [0], async () => ({ imported: 1, skipped: 0 })),
    ).rejects.toThrow('失效')
  } finally {
    clock.mockRestore()
  }
})
it.skipIf(!process.env.VORK_IMPORT_FILE)(
  'recognizes supplied ano file without exposing or storing private data',
  async () => {
    const rows = parseConnectionImport(await readFile(process.env.VORK_IMPORT_FILE!, 'utf8'))
    expect(rows).toHaveLength(9)
    expect(rows.filter((row) => row.config)).toHaveLength(9)
  },
)

it('refuses referenced SSH tunnels and nonboolean TLS rather than importing a direct or weaker connection', () => {
  const rows = parseConnectionImport(
    JSON.stringify([
      { ...fixture, sshProfileId: 'saved-bastion' },
      { ...fixture, tls: { ca: '/cert' } },
    ]),
  )
  expect(rows.every((row) => row.error && !row.config)).toBe(true)
})
