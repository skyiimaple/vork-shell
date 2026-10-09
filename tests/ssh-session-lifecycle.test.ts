import { expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
  emit: undefined as
    undefined | ((type: 'data' | 'closed' | 'error', data: string, channelId?: string) => void),
  close: vi.fn(async () => {}),
}))
vi.mock('../src/main/ssh', () => ({
  openSsh: async (_config: unknown, _verify: unknown, emit: any) => {
    state.emit = emit
    return {
      close: state.close,
      write: vi.fn(),
      resize: vi.fn(),
      ack: vi.fn(),
      tools: {},
      openTerminal: async () => 'child',
      closeTerminal: async () => {},
    }
  },
}))
import { SessionManager } from '../src/main/sessions'
test('child PTY exit keeps session ownership while transport exit releases the connection', async () => {
  const events: any[] = [],
    manager = new SessionManager(
      (_owner, event) => events.push(event),
      async () => true,
    )
  const session = await manager.connect(7, {
    type: 'ssh',
    name: 'test',
    host: 'example.test',
    port: 22,
    username: 'tester',
    password: 'secret',
  })
  state.emit!('closed', 'child exited', 'child')
  expect(() => manager.assertOwned(7, session.id)).not.toThrow()
  expect(state.close).not.toHaveBeenCalled()
  expect(events.at(-1)).toMatchObject({ channelId: 'child', type: 'closed' })
  state.emit!('closed', 'transport exited')
  expect(() => manager.assertOwned(7, session.id)).toThrow('会话')
  expect(state.close).toHaveBeenCalledOnce()
})

test('manual reconnect retains owner-bound config only until owner closes', async () => {
  const manager = new SessionManager(
    () => {},
    async () => true,
  )
  const session = await manager.connect(13, {
    type: 'ssh',
    name: 'Reconnect',
    host: 'example.test',
    port: 22,
    username: 'tester',
    password: 'secret',
  })
  await manager.disconnect(13, session.id)
  await expect(manager.reconnect(14, session.id)).rejects.toThrow()
  const replacement = await manager.reconnect(13, session.id)
  expect(replacement.id).not.toBe(session.id)
  expect(replacement.name).toBe(session.name)
  await manager.closeOwner(13)
  await expect(manager.reconnect(13, replacement.id)).rejects.toThrow()
})
