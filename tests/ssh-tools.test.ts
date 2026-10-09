import { it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSsh } from '../src/main/ssh'
import { remotePath } from '../src/main/ssh-tools'
import { runTransferBatch } from '../src/main/ssh-batch'
const { createSshFixture } = createRequire(import.meta.url)('../scripts/ssh-fixture.cjs')
it('uses a real SSH/SFTP protocol connection for file operations and TCP forwarding, and releases listeners', async () => {
  const fixture = await createSshFixture(),
    directory = await mkdtemp(join(tmpdir(), 'vork-sftp-'))
  const ssh = await openSsh(
    {
      type: 'ssh',
      name: 'test',
      host: '127.0.0.1',
      port: fixture.port,
      username: 'fixture',
      password: 'fixture',
    },
    async () => true,
    () => {},
  )
  try {
    const listing = await ssh.tools.request({ kind: 'list', path: '.' })
    expect(listing).toMatchObject({
      kind: 'listing',
      path: '/',
      entries: expect.arrayContaining([
        expect.objectContaining({ name: 'hello.txt', directory: false }),
      ]),
    })
    await ssh.tools.request({ kind: 'mkdir', path: '/created' })
    expect(fixture.folders.has('/created')).toBe(true)
    await ssh.tools.transfer('download', '/hello.txt', join(directory, 'download.txt'))
    expect(await readFile(join(directory, 'download.txt'), 'utf8')).toBe('hello from SFTP\n')
    await writeFile(join(directory, 'source.txt'), 'upload value')
    await ssh.tools.transfer('upload', '/files/upload.txt', join(directory, 'source.txt'))
    expect(fixture.files.get('/files/upload.txt').toString()).toBe('upload value')
    await expect(
      ssh.tools.transfer('upload', '/files/upload.txt', join(directory, 'source.txt')),
    ).rejects.toThrow()
    expect(fixture.files.get('/files/upload.txt').toString()).toBe('upload value')
    await expect(
      ssh.tools.transfer('download', '/missing', join(directory, 'source.txt')),
    ).rejects.toThrow()
    expect(await readFile(join(directory, 'source.txt'), 'utf8')).toBe('upload value')
    fixture.hooks.beforeRename = (_old: string, target: string) =>
      fixture.files.set(target, Buffer.from('race winner'))
    await expect(
      ssh.tools.transfer('upload', '/files/raced.txt', join(directory, 'source.txt')),
    ).rejects.toThrow()
    expect(fixture.files.get('/files/raced.txt').toString()).toBe('race winner')
    expect([...fixture.files.keys()].some((path) => String(path).includes('.vork-'))).toBe(false)
    fixture.hooks.beforeRename = undefined
    const tunnels = await ssh.tools.request({
      kind: 'tunnel-start',
      host: '127.0.0.1',
      port: fixture.echoPort,
      localPort: 0,
    })
    if (tunnels.kind !== 'tunnels') throw new Error('隧道响应错误')
    const tunnel = tunnels.tunnels[0]!
    const output = await new Promise<string>((resolve, reject) => {
      const socket = connect(tunnel.localPort, '127.0.0.1', () => socket.write('forwarded'))
      socket.on('error', reject)
      socket.once('data', (data) => {
        resolve(data.toString())
        socket.destroy()
      })
    })
    expect(output).toBe('forwarded')
    await ssh.tools.request({ kind: 'tunnel-stop', id: tunnel.id })
    expect(await ssh.tools.request({ kind: 'tunnels' })).toMatchObject({ tunnels: [] })
    const rebound = createServer()
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject)
      rebound.listen(tunnel.localPort, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve) => rebound.close(() => resolve()))
    await expect(
      ssh.tools.request({ kind: 'tunnel-start', host: 'bad host', port: 1, localPort: 0 }),
    ).rejects.toThrow(/端口/)
    expect(() => remotePath('bad\0path')).toThrow()
    expect(() => remotePath('/bad�name')).toThrow()
  } finally {
    await ssh.close()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

it('does not publish a partial upload when SSH disconnects during writing', async () => {
  const fixture = await createSshFixture(),
    directory = await mkdtemp(join(tmpdir(), 'vork-sftp-cancel-'))
  const ssh = await openSsh(
    {
      type: 'ssh',
      name: 'test',
      host: '127.0.0.1',
      port: fixture.port,
      username: 'fixture',
      password: 'fixture',
    },
    async () => true,
    () => {},
  )
  try {
    await writeFile(join(directory, 'source.txt'), Buffer.alloc(65536, 65))
    fixture.hooks.onWrite = () => fixture.disconnect()
    await expect(
      ssh.tools.transfer('upload', '/files/final.txt', join(directory, 'source.txt')),
    ).rejects.toThrow()
    expect(fixture.files.has('/files/final.txt')).toBe(false)
    expect(
      [...fixture.files.keys()]
        .filter((path) => String(path).startsWith('/files/'))
        .every((path) => String(path).endsWith('.part')),
    ).toBe(true)
  } finally {
    await ssh.close()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

it('uses independent PTYs and preserves SFTP after closing a split; batches report missing and existing files individually', async () => {
  const fixture = await createSshFixture(),
    directory = await mkdtemp(join(tmpdir(), 'vork-sftp-batch-'))
  const events: { type: string; data: string; channelId?: string }[] = []
  const ssh = await openSsh(
    {
      type: 'ssh',
      name: 'test',
      host: '127.0.0.1',
      port: fixture.port,
      username: 'fixture',
      password: 'fixture',
    },
    async () => true,
    (type, data, channelId) => events.push({ type, data, channelId }),
  )
  try {
    const id = await ssh.openTerminal()
    ssh.ack(0)
    ssh.ack(0, id)
    ssh.write('child-only', id)
    ssh.write('parent-only')
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (
          events.some((event) => event.channelId === id && event.data.includes('child-only')) &&
          events.some(
            (event) => event.channelId === 'default' && event.data.includes('parent-only'),
          )
        ) {
          clearInterval(timer)
          clearTimeout(timeout)
          resolve()
        }
      }, 10)
      const timeout = setTimeout(() => {
        clearInterval(timer)
        reject(new Error('PTY output timed out'))
      }, 3000)
    })
    expect(
      events
        .filter((event) => event.channelId === id)
        .some((event) => event.data.includes('parent-only')),
    ).toBe(false)
    await ssh.closeTerminal(id)
    expect(await ssh.tools.request({ kind: 'list', path: '/' })).toMatchObject({ kind: 'listing' })
    await writeFile(join(directory, 'hello.txt'), 'existing local')
    fixture.files.set('/last.txt', Buffer.from('last'))
    const downloaded = await runTransferBatch(
      'download',
      ['/hello.txt', '/missing.txt', '/last.txt'],
      directory,
      (...args) => ssh.tools.transfer(...args),
    )
    expect(downloaded.results.map((file) => file.ok)).toEqual([false, false, true])
    expect(await readFile(join(directory, 'hello.txt'), 'utf8')).toBe('existing local')
    expect(await readFile(join(directory, 'last.txt'), 'utf8')).toBe('last')
    await writeFile(join(directory, 'new.txt'), 'new upload')
    const uploaded = await runTransferBatch(
      'upload',
      [join(directory, 'hello.txt'), join(directory, 'new.txt')],
      '/',
      (...args) => ssh.tools.transfer(...args),
    )
    expect(uploaded.results.map((file) => file.ok)).toEqual([false, true])
    expect(fixture.files.get('/hello.txt').toString()).toBe('hello from SFTP\n')
    expect(fixture.files.get('/new.txt').toString()).toBe('new upload')
  } finally {
    await ssh.close()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

it('renames without overwriting and deletes only files or empty directories', async () => {
  const fixture = await createSshFixture()
  const ssh = await openSsh(
    {
      type: 'ssh',
      name: 'test',
      host: '127.0.0.1',
      port: fixture.port,
      username: 'fixture',
      password: 'fixture',
    },
    async () => true,
    () => {},
  )
  try {
    await ssh.tools.request({ kind: 'rename', path: '/hello.txt', newName: 'renamed.txt' })
    expect(fixture.files.has('/renamed.txt')).toBe(true)
    fixture.files.set('/occupied', Buffer.from('keep'))
    await expect(
      ssh.tools.request({ kind: 'rename', path: '/renamed.txt', newName: 'occupied' }),
    ).rejects.toThrow(/存在/)
    await expect(
      ssh.tools.request({ kind: 'rename', path: '/renamed.txt', newName: '../escape' }),
    ).rejects.toThrow(/名称/)
    await expect(ssh.tools.request({ kind: 'delete', path: '/' })).rejects.toThrow(/根目录/)
    await ssh.tools.request({ kind: 'delete', path: '/renamed.txt' })
    expect(fixture.files.has('/renamed.txt')).toBe(false)
    fixture.files.set('/files/keep.txt', Buffer.from('keep'))
    await expect(ssh.tools.request({ kind: 'delete', path: '/files' })).rejects.toThrow()
    expect(fixture.files.get('/files/keep.txt').toString()).toBe('keep')
    await ssh.tools.request({ kind: 'delete', path: '/files/keep.txt' })
    await ssh.tools.request({ kind: 'delete', path: '/files' })
    expect(fixture.folders.has('/files')).toBe(false)
  } finally {
    await ssh.close()
    await fixture.close()
  }
}, 15000)

it('cancels only the transfer, cleans partial upload and keeps SFTP and PTY alive', async () => {
  const fixture = await createSshFixture(),
    directory = await mkdtemp(join(tmpdir(), 'vork-progress-'))
  const ssh = await openSsh(
    {
      type: 'ssh',
      name: 'test',
      host: '127.0.0.1',
      port: fixture.port,
      username: 'fixture',
      password: 'fixture',
    },
    async () => true,
    () => {},
  )
  const progress: any[] = []
  try {
    await writeFile(join(directory, 'source'), Buffer.alloc(512 * 1024, 65))
    fixture.hooks.onWrite = () => ssh.tools.cancelTransfer()
    const result = await ssh.tools.transfer(
      'upload',
      '/files/cancel.txt',
      join(directory, 'source'),
      { onProgress: (value: any) => progress.push(value) },
    )
    expect(result.canceled).toBe(true)
    expect(fixture.files.has('/files/cancel.txt')).toBe(false)
    expect([...fixture.files.keys()].some((p) => String(p).includes('.part'))).toBe(false)
    expect(progress[0]).toMatchObject({ bytes: 0, total: 512 * 1024 })
    expect(await ssh.tools.request({ kind: 'list', path: '/' })).toMatchObject({ kind: 'listing' })
    fixture.hooks.onWrite = undefined
    await ssh.tools.transfer('upload', '/files/complete.txt', join(directory, 'source'))
    expect(fixture.files.get('/files/complete.txt').length).toBe(512 * 1024)
    ssh.ack(0)
    ssh.write('still alive')
  } finally {
    await ssh.close()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)
