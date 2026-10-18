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

it('round trips every query draft, order, database and active query without connection secrets', () => {
  const queries = {
    active: 'q2',
    tabs: [
      { id: 'q1', name: 'Query 1', sql: 'SELECT 1', database: 'alpha', password: 'secret' },
      { id: 'q2', name: 'Query 2', sql: 'SELECT 2', database: 'beta' },
    ],
  }
  const json = encodeWorkspace(
    [
      {
        session: { id: 's', name: 'local', type: 'sqlite', target: ':memory:' },
        sql: 'SELECT 2',
        queries,
      },
    ],
    's',
  )
  expect(json).not.toContain('secret')
  expect(decodeWorkspace(json)?.tabs[0]?.queries).toEqual({
    active: 'q2',
    tabs: queries.tabs.map(({ id, name, sql, database }) => ({ id, name, sql, database })),
  })
})

it('bounds each recovered query and drops invalid snapshots without losing the legacy draft', () => {
  const session = { id: 's', name: 'local', type: 'sqlite' as const, target: ':memory:' }
  const queries = {
    active: 'q',
    tabs: [{ id: 'q', name: 'Query 1', sql: 'x'.repeat(70000), database: 'main' }],
  }
  const result = decodeWorkspace(encodeWorkspace([{ session, sql: 'legacy', queries }], 's'))!
  expect(result.tabs[0]?.queries?.tabs[0]?.sql).toHaveLength(65536)
  const invalid = { ...queries, active: 'missing' }
  const fallback = decodeWorkspace(
    encodeWorkspace([{ session, sql: 'legacy', queries: invalid }], 's'),
  )!
  expect(fallback.tabs[0]?.queries).toBeUndefined()
  expect(fallback.tabs[0]?.sql).toBe('legacy')
})
