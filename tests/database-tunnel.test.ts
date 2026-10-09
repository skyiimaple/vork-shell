import { test, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({
  closed: 0,
  endpoints: [] as any[],
  fail: false,
  emit: undefined as any,
}))
vi.mock('../src/main/ssh', () => ({
  openSsh: async (_c: any, _v: any, emit: any, terminal: any) => {
    state.emit = emit
    expect(terminal).toBe(false)
    return {
      tools: {
        request: async (r: any) => {
          expect(r).toMatchObject({
            kind: 'tunnel-start',
            host: 'db.internal',
            port: 6379,
            localPort: 0,
          })
          return { kind: 'tunnels', tunnels: [{ id: 't', localPort: 54321 }] }
        },
      },
      close: async () => {
        state.closed++
      },
    }
  },
}))
vi.mock('../src/main/adapters', () => ({
  openDatabase: async (config: any, _emit: any, endpoint: any) => {
    state.endpoints.push({ config, endpoint })
    if (state.fail) throw new Error('database failed')
    return { execute: async () => ({ rows: [['PONG']] }), close: async () => {} }
  },
}))
import { SessionManager } from '../src/main/sessions'
import { validateConnection } from '../src/main/validation'
const ssh = {
  id: 'bastion',
  type: 'ssh' as const,
  name: 'Bastion',
  host: 'ssh.internal',
  port: 22,
  username: 'tester',
  password: 'secret',
}
const config = {
  type: 'redis' as const,
  name: 'db',
  host: 'db.internal',
  port: 6379,
  sshProfileId: 'bastion',
}
test('database tunnel preserves target and closes owned transport on disconnect and failure', async () => {
  const manager = new SessionManager(
    () => {},
    async () => true,
    async () => ssh,
  )
  const session = await manager.connect(7, config)
  expect(state.endpoints.at(-1)).toMatchObject({
    config: { host: 'db.internal' },
    endpoint: { host: '127.0.0.1', port: 54321 },
  })
  await manager.disconnect(7, session.id)
  expect(state.closed).toBe(1)
  state.fail = true
  await expect(manager.connect(7, config)).rejects.toThrow('database failed')
  expect(state.closed).toBe(2)
  state.fail = false
  const next = await manager.connect(7, config)
  state.emit('closed', 'SSH lost')
  expect(() => manager.assertOwned(7, next.id)).toThrow()
  expect(state.closed).toBe(3)
})
test('rejects invalid SSH references and unsupported connection types', () => {
  expect(() => validateConnection({ ...config, sshProfileId: 23 })).toThrow()
  expect(() =>
    validateConnection({
      type: 'sqlite',
      name: 'local',
      path: ':memory:',
      sshProfileId: 'bastion',
    }),
  ).toThrow()
})

test('refuses MySQL TLS IP tunnels instead of weakening target identity verification', () => {
  expect(() =>
    validateConnection({
      type: 'mysql',
      name: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: 'tester',
      sshProfileId: 'bastion',
      tls: true,
    }),
  ).toThrow(/DNS/)
  expect(
    validateConnection({
      type: 'mysql',
      name: 'mysql',
      host: 'db.internal',
      port: 3306,
      username: 'tester',
      sshProfileId: 'bastion',
      tls: true,
    }).host,
  ).toBe('db.internal')
})
