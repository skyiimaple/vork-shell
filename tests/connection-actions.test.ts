import type { ConnectionConfig } from '../src/shared/contracts'
import { describe, it, expect, vi } from 'vitest'
import { duplicateProfile, testConnection } from '../src/renderer/src/lib/connection-actions'
const config = {
  id: 'saved',
  type: 'sqlite' as const,
  name: 'Local',
  path: ':memory:',
  password: 'secret',
  passphrase: 'secret',
}
describe('connection actions', () => {
  it('duplicates settings without identity or secrets', () => {
    expect(duplicateProfile(config)).toEqual({
      type: 'sqlite',
      name: 'Local 副本',
      path: ':memory:',
    })
    expect(config.id).toBe('saved')
  })
  it('releases the exact successful connection before reporting success', async () => {
    const session = { id: 'temporary', type: 'sqlite' as const, name: 'Local' }
    const bridge = {
      connect: vi.fn().mockResolvedValue(session),
      disconnect: vi.fn().mockResolvedValue(undefined),
    }
    await testConnection(bridge, config)
    expect(bridge.connect).toHaveBeenCalledWith(config)
    expect(bridge.disconnect).toHaveBeenCalledExactlyOnceWith('temporary')
  })
  it('propagates connection and cleanup failures', async () => {
    const bridge = {
      connect: vi.fn().mockRejectedValue(new Error('unreachable')),
      disconnect: vi.fn(),
    }
    await expect(testConnection(bridge, config)).rejects.toThrow('unreachable')
    expect(bridge.disconnect).not.toHaveBeenCalled()
    bridge.connect.mockResolvedValue({ id: 'temporary' })
    bridge.disconnect.mockRejectedValue(new Error('cleanup failed'))
    await expect(testConnection(bridge, config)).rejects.toThrow('cleanup failed')
  })
})

it('updates credentials when reconnecting a saved profile', async () => {
  const { connectProfile } = await import('../src/renderer/src/lib/connection-actions')
  let saved: ConnectionConfig | undefined
  const session = { id: 'session', type: 'sqlite' as const, name: 'Local', target: ':memory:' }
  const bridge = {
    connect: async () => session,
    disconnect: async () => {},
    profiles: async () => [],
    saveProfile: async (value: ConnectionConfig) => {
      saved = value
    },
  }
  expect(await connectProfile(bridge, config)).toEqual(session)
  expect(saved?.password).toBe('secret')
})
it('auto-saves a successful new connection with matching session profile identity', async () => {
  const { connectProfile } = await import('../src/renderer/src/lib/connection-actions')
  const bridge = {
    connect: vi.fn().mockImplementation(async (c) => ({
      id: 'session',
      profileId: c.id,
      type: c.type,
      name: c.name,
      target: c.path,
    })),
    disconnect: vi.fn(),
    profiles: async () => [],
    saveProfile: vi.fn().mockResolvedValue(undefined),
  }
  const session = await connectProfile(bridge, { type: 'sqlite', name: 'New', path: ':memory:' })
  expect(bridge.saveProfile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: session.profileId }),
  )
  expect(session.profileId).toBeTruthy()
})
it('does not save failed connections and releases a session if saving fails', async () => {
  const { connectProfile } = await import('../src/renderer/src/lib/connection-actions')
  const bridge = {
    connect: vi.fn().mockRejectedValue(new Error('connect failed')),
    disconnect: vi.fn().mockResolvedValue(undefined),
    profiles: async () => [],
    saveProfile: vi.fn().mockRejectedValue(new Error('save failed')),
  }
  await expect(connectProfile(bridge, config)).rejects.toThrow('connect failed')
  expect(bridge.saveProfile).not.toHaveBeenCalled()
  bridge.connect.mockResolvedValue({ id: 'session' })
  await expect(connectProfile(bridge, config)).rejects.toThrow('save failed')
  expect(bridge.disconnect).toHaveBeenCalledWith('session')
})
it('reports an existing connection before opening a server session', async () => {
  const { connectProfile } = await import('../src/renderer/src/lib/connection-actions')
  const bridge = {
    profiles: async () => [
      {
        id: 'existing',
        type: 'redis' as const,
        name: 'Already saved',
        host: '127.0.0.1',
        port: 6379,
      },
    ],
    connect: vi.fn(),
    saveProfile: vi.fn(),
    disconnect: vi.fn(),
  }
  await expect(
    connectProfile(bridge, { type: 'redis', name: 'Duplicate', host: 'localhost', port: 6379 }),
  ).rejects.toThrow('连接已存在：Already saved')
  expect(bridge.connect).not.toHaveBeenCalled()
})
