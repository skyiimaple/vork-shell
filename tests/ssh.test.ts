import { it, expect } from 'vitest'
import { Server, type Connection } from 'ssh2'
import { generateKeyPairSync } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { openSsh } from '../src/main/ssh'
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs1',
  format: 'pem',
})
it('opens a real SSH PTY, verifies host identity, streams output, and accepts input', async () => {
  const clients = new Set<Connection>()
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) =>
      ctx.username === 'test' && ctx.method === 'password' && ctx.password === 'test'
        ? ctx.accept()
        : ctx.reject(),
    )
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (accept) => accept?.())
        session.on('window-change', (accept) => accept?.())
        session.on('shell', (accept) => {
          const stream = accept()
          stream.write('local-ssh-ready\r\n')
          stream.on('data', (data: Buffer) => stream.write('echo:' + data.toString()))
        })
      }),
    )
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  let fingerprint = '',
    output = ''
  let done!: () => void
  const echoed = new Promise<void>((resolve) => (done = resolve))
  const ssh = await openSsh(
    { type: 'ssh', name: 'test', host: '127.0.0.1', port, username: 'test', password: 'test' },
    async (hash) => {
      fingerprint = hash
      return true
    },
    (type, data) => {
      if (type === 'data') {
        output += data
        if (output.includes('echo:hello')) done()
      }
    },
  )
  try {
    ssh.ack(0)
    ssh.resize(120, 40)
    ssh.write('hello')
    await echoed
    expect(fingerprint).toMatch(/^SHA256:/)
    expect(output).toContain('local-ssh-ready')
    expect(output).toContain('echo:hello')
  } finally {
    await ssh.close()
    for (const client of clients) client.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 10000)
