import { expect, it } from 'vitest'
import { groupConnectionsByType } from '../src/renderer/src/lib/connection-groups'
it('keeps exactly six fixed groups and ignores old user group labels', () => {
  const groups = groupConnectionsByType([
    { id: 'a', name: 'A', type: 'redis', group: 'old' },
    { id: 'b', name: 'B', type: 'ssh', group: 'old' },
  ])
  expect(groups.map((g) => g.name)).toEqual([
    'SSH',
    'SQLite',
    'MySQL',
    'PostgreSQL',
    'Redis',
    'MongoDB',
  ])
  expect(groups.find((g) => g.name === 'Redis')?.items.map((p) => p.id)).toEqual(['a'])
  expect(groups.find((g) => g.name === 'MySQL')?.items).toEqual([])
})
