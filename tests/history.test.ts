import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore } from '../src/main/history'
it('persists bounded histories across connections without merging the same SQL on different connections', async () => {
  const path = await mkdtemp(join(tmpdir(), 'vork-history-'))
  try {
    const store = new HistoryStore(path, 3)
    const session = {
      id: 'session',
      profileId: 'a',
      type: 'sqlite' as const,
      name: 'Alpha',
      target: ':memory:',
    }
    await store.record(session, 'select 1')
    await store.record({ ...session, profileId: 'b', name: 'Beta' }, 'select 1')
    await store.record(session, 'select 2')
    await store.record(session, 'select 1')
    const reopened = await new HistoryStore(path, 3).list()
    expect(reopened).toHaveLength(3)
    expect(reopened.map((h) => h.sql)).toEqual(['select 1', 'select 2', 'select 1'])
    expect(reopened.map((h) => h.profileId)).toEqual(['a', 'a', 'b'])
    expect(reopened[0]).not.toHaveProperty('password')
    await expect(store.record(session, 'x'.repeat(65537))).rejects.toThrow()
  } finally {
    await rm(path, { recursive: true, force: true })
  }
})
