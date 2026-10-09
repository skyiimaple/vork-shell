import { describe, it, expect } from 'vitest'
import { decodeWorkspace, encodeWorkspace } from '../src/renderer/src/lib/workspace'
describe('workspace recovery', () => {
  it('round trips only session metadata and bounded SQL drafts', () => {
    const tabs = [
      {
        session: {
          id: 'one',
          name: 'Local',
          type: 'sqlite' as const,
          target: ':memory:',
          password: 'secret',
        },
        sql: 'SELECT 42',
        password: 'secret',
      },
    ]
    const json = encodeWorkspace(tabs, 'one')
    expect(json).not.toContain('secret')
    expect(decodeWorkspace(json)?.tabs[0]?.sql).toBe('SELECT 42')
    expect(decodeWorkspace(json)?.active).toBe('one')
  })
  it('rejects malformed data and ignores prototype keys', () => {
    expect(decodeWorkspace('{')).toBeNull()
    expect(decodeWorkspace('{"version":3,"tabs":[]}')).toBeNull()
    expect(decodeWorkspace('{"version":1,"tabs":[{"session":{"id":"a","type":"bad"}}]}')).toBeNull()
  })
  it('bounds tab and draft persistence', () => {
    const tabs = Array.from({ length: 30 }, (_, i) => ({
      session: { id: String(i), name: 'local', type: 'sqlite' as const, target: ':memory:' },
      sql: 'x'.repeat(70000),
    }))
    const restored = decodeWorkspace(encodeWorkspace(tabs, '0'))!
    expect(restored.tabs.length).toBeLessThanOrEqual(20)
    expect(restored.tabs[0]!.sql.length).toBeLessThanOrEqual(65536)
  })
})
