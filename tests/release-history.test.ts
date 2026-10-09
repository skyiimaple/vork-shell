import { test, expect } from 'vitest'
import history from '../src/shared/release-history.json'
import pkg from '../package.json'
test('release notes keep real milestone dates in reverse order and do not claim a release', () => {
  expect(history.version).toBe(pkg.version)
  expect(history.released).toBe(false)
  expect(history.entries.map((e) => e.date)).toEqual([
    '2026-10-09',
    '2026-10-08',
    '2026-10-06',
    '2026-10-05',
  ])
  expect(history.entries.every((e) => e.changes.length > 0)).toBe(true)
})
