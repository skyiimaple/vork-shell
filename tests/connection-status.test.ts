import { expect, it } from 'vitest'
import { connectionStatuses } from '../src/renderer/src/lib/connection-status'
it('keeps connected highlight until every session for that profile is closed', () => {
  const sessions = [
    { id: 'one', profileId: 'p', name: 'A', type: 'redis' as const, target: 'localhost' },
    { id: 'two', profileId: 'p', name: 'A', type: 'redis' as const, target: 'localhost' },
  ]
  expect(connectionStatuses(sessions, {}, 'one').get('p')).toEqual({
    connected: true,
    active: true,
  })
  expect(connectionStatuses(sessions, { one: '断开' }, 'one').get('p')).toEqual({
    connected: true,
    active: false,
  })
  expect(connectionStatuses(sessions, { one: '断开', two: '断开' }, 'two').has('p')).toBe(false)
  expect(connectionStatuses([{ ...sessions[0], profileId: undefined }], {}, 'one').size).toBe(0)
})
