import { it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProfileStore } from '../src/main/profiles'
it('persists concurrent profiles without passwords or private-key passphrases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-profiles-'))
  try {
    const store = new ProfileStore(directory)
    await Promise.all(
      ['one', 'two'].map((name) =>
        store.save({
          type: 'ssh',
          name,
          host: name + '.test',
          port: 22,
          username: 'tester',
          password: 'secret-test-value',
          passphrase: 'secret-passphrase',
        }),
      ),
    )
    const text = await readFile(join(directory, 'connections.json'), 'utf8')
    expect(text).not.toContain('secret-test-value')
    expect(text).not.toContain('secret-passphrase')
    const items = await store.list()
    expect(items).toHaveLength(2)
    await store.remove(items[0].id!)
    expect(await store.list()).toHaveLength(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('restores encrypted credentials after reopening and removes them when cleared', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-credentials-'))
  const key = randomBytes(32)
  const cipher = {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const iv = randomBytes(12),
        c = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([c.update(value, 'utf8'), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), data])
    },
    decryptString(value: Buffer) {
      const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      c.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString('utf8')
    },
  }
  try {
    const store = new ProfileStore(directory, cipher)
    await store.save({
      type: 'ssh',
      name: 'saved',
      host: 'localhost',
      port: 22,
      username: 'tester',
      password: 'saved-password',
      passphrase: 'saved-passphrase',
    })
    const reopened = new ProfileStore(directory, cipher)
    const [profile] = await reopened.list()
    expect(profile.password).toBe('saved-password')
    expect(profile.passphrase).toBe('saved-passphrase')
    const disk = await readFile(join(directory, 'connections.json'), 'utf8')
    expect(disk).not.toContain('saved-password')
    expect(disk).not.toContain('saved-passphrase')
    await reopened.save({ ...profile, password: '', passphrase: '' })
    expect((await reopened.list())[0].password).toBeUndefined()
    await reopened.remove(profile.id!)
    expect(await reopened.list()).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('persists explicit order and keeps edited profiles in their original position', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-order-'))
  try {
    const store = new ProfileStore(directory)
    await store.save({ id: 'a', type: 'sqlite', name: 'A', path: ':memory:' })
    await store.save({ id: 'b', type: 'sqlite', name: 'B', path: ':memory:' })
    await store.reorder(['b', 'a'])
    await store.save({ id: 'b', type: 'sqlite', name: 'B edited', path: ':memory:' })
    expect((await store.list()).map((p) => p.id)).toEqual(['b', 'a'])
    await expect(store.reorder(['a', 'a'])).rejects.toThrow()
    await expect(store.reorder(['a'])).rejects.toThrow()
    expect((await store.list()).map((p) => p.id)).toEqual(['b', 'a'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('preserves trimmed folders and leaves legacy profiles ungrouped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-folders-'))
  try {
    const store = new ProfileStore(directory)
    await store.save({
      id: 'grouped',
      type: 'sqlite',
      name: 'A',
      path: ':memory:',
      group: '  开发  ',
    })
    await store.save({ id: 'legacy', type: 'sqlite', name: 'B', path: ':memory:' })
    expect((await store.list()).map((p) => p.group)).toEqual(['开发', undefined])
    expect(() =>
      store.save({ type: 'sqlite', name: 'C', path: ':memory:', group: 'x'.repeat(101) }),
    ).toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
it('moves a dragged connection to the destination folder atomically with its order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-move-'))
  try {
    const store = new ProfileStore(directory)
    await store.save({ id: 'a', type: 'sqlite', name: 'A', path: ':memory:', group: '开发' })
    await store.save({ id: 'b', type: 'sqlite', name: 'B', path: ':memory:', group: '生产' })
    await store.reorder(['b', 'a'], { id: 'a', group: '生产' })
    expect((await store.list()).map((p) => [p.id, p.group])).toEqual([
      ['b', '生产'],
      ['a', '生产'],
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('toggles favorites without changing saved credentials or profile order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-favorites-'))
  const cipher = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  }
  try {
    const store = new ProfileStore(directory, cipher)
    await store.save({ id: 'a', type: 'sqlite', name: 'A', path: ':memory:', password: 'retained' })
    await store.save({ id: 'b', type: 'sqlite', name: 'B', path: ':memory:' })
    await store.favorite('a', true)
    expect(await store.list()).toMatchObject([
      { id: 'a', favorite: true, password: 'retained' },
      { id: 'b' },
    ])
    await store.favorite('a', false)
    expect((await store.list())[0]!.favorite).toBe(false)
    await expect(store.favorite('missing', true)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
it('rejects duplicates atomically but permits editing the same identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vork-duplicate-'))
  try {
    const store = new ProfileStore(directory)
    const config = { type: 'redis' as const, name: 'Original', host: 'localhost', port: 6379 }
    const results = await Promise.allSettled([
      store.save(config),
      store.save({ ...config, name: 'Another', host: '127.0.0.1' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason.message).toContain('连接已存在')
    const [saved] = await store.list()
    await store.save({ ...saved, name: 'Edited' })
    expect(await store.list()).toHaveLength(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
