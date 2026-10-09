import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({ clients: [] as any[] }))
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events')
  class Channel extends EventEmitter {
    stderr = new EventEmitter()
    writes: string[] = []
    paused = false
    size?: number[]
    write(data: string) {
      this.writes.push(data)
    }
    pause() {
      this.paused = true
    }
    resume() {
      this.paused = false
    }
    setWindow(...size: number[]) {
      this.size = size
    }
    close() {
      this.emit('close')
    }
  }
  class Client extends EventEmitter {
    channels: Channel[] = []
    destroyed = false
    constructor() {
      super()
      state.clients.push(this)
    }
    connect() {
      queueMicrotask(() => this.emit('ready'))
    }
    shell(_options: unknown, callback: (error: null, channel: Channel) => void) {
      const channel = new Channel()
      this.channels.push(channel)
      callback(null, channel)
    }
    destroy() {
      this.destroyed = true
      this.emit('close')
    }
  }
  return { Client }
})
import { openSsh } from '../src/main/ssh'
beforeEach(() => (state.clients.length = 0))
test('split terminals route independent input, size and close without disconnecting authenticated client', async () => {
  const events: any[] = []
  const ssh = await openSsh(
    { type: 'ssh', name: 'test' },
    async () => true,
    (...event) => events.push(event),
  )
  const id = await ssh.openTerminal()
  const client = state.clients[0],
    [first, second] = client.channels
  ssh.ack(0)
  ssh.ack(0, id)
  ssh.write('one')
  ssh.write('two', id)
  ssh.resize(80, 24, id)
  first.emit('data', Buffer.from('first'))
  second.emit('data', Buffer.from('second'))
  expect(first.writes).toEqual(['one'])
  expect(second.writes).toEqual(['two'])
  expect(second.size).toEqual([24, 80, 0, 0])
  expect(events).toContainEqual(['data', 'first', 'default'])
  expect(events).toContainEqual(['data', 'second', id])
  await ssh.closeTerminal(id)
  expect(client.destroyed).toBe(false)
  expect(() => ssh.write('closed', id)).toThrow('终端')
  ssh.write('still connected')
  await ssh.close()
  expect(client.destroyed).toBe(true)
})
test('backpressure and overflowing buffers are isolated to their PTY', async () => {
  const events: any[] = []
  const ssh = await openSsh(
    { type: 'ssh', name: 'test' },
    async () => true,
    (...event) => events.push(event),
  )
  const id = await ssh.openTerminal(),
    client = state.clients[0]
  ssh.ack(0)
  client.channels[1].emit('data', Buffer.alloc(130 * 1024, 97))
  expect(client.channels[1].paused).toBe(true)
  expect(client.channels[0].paused).toBe(false)
  client.channels[1].emit('data', Buffer.alloc(130 * 1024, 97))
  expect(client.destroyed).toBe(false)
  expect(events.some(([type, , channelId]) => type === 'error' && channelId === id)).toBe(true)
  client.channels[0].emit('data', Buffer.from('healthy'))
  expect(events).toContainEqual(['data', 'healthy', 'default'])
  await ssh.close()
})
test('limits terminal creation and rejects unknown channel ids', async () => {
  const ssh = await openSsh(
    { type: 'ssh', name: 'test' },
    async () => true,
    () => {},
  )
  for (let i = 0; i < 3; i++) await ssh.openTerminal()
  await expect(ssh.openTerminal()).rejects.toThrow('4')
  expect(() => ssh.ack(0, 'missing')).toThrow('终端')
  await ssh.close()
})
test('closing a PTY releases its quota immediately while remote close event is delayed', async () => {
  const ssh = await openSsh(
    { type: 'ssh', name: 'test' },
    async () => true,
    () => {},
  )
  const id = await ssh.openTerminal()
  await ssh.openTerminal()
  await ssh.openTerminal()
  state.clients[0].channels[1].close = () => {}
  await ssh.closeTerminal(id)
  const replacement = await ssh.openTerminal()
  expect(replacement).not.toBe(id)
  expect(() => ssh.write('late', id)).toThrow('终端')
  await ssh.close()
})
test('renderer reattachment releases stale in-flight backpressure for surviving default PTY', async () => {
  const ssh = await openSsh(
    { type: 'ssh', name: 'test' },
    async () => true,
    () => {},
  )
  const channel = state.clients[0].channels[0]
  ssh.ack(0)
  channel.emit('data', Buffer.alloc(130 * 1024, 97))
  expect(channel.paused).toBe(true)
  ssh.ack(0)
  expect(channel.paused).toBe(false)
  await ssh.close()
})
test('retry recreates a closed default terminal without replacing authentication or duplicating an existing default', async () => {
  const ssh = await openSsh(
    { type: 'ssh', name: 'test' },
    async () => true,
    () => {},
  )
  const client = state.clients[0]
  expect(await ssh.openTerminal('default')).toBe('default')
  expect(client.channels).toHaveLength(1)
  await ssh.closeTerminal('default')
  expect(await Promise.all([ssh.openTerminal('default'), ssh.openTerminal('default')])).toEqual([
    'default',
    'default',
  ])
  expect(client.channels).toHaveLength(2)
  ssh.write('recovered')
  expect(client.channels[1].writes).toEqual(['recovered'])
  expect(client.destroyed).toBe(false)
  await ssh.close()
})
