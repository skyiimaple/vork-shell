import { expect, it } from 'vitest'
import {
  normalizeShortcut,
  validateShortcuts,
  matchesShortcut,
  defaultShortcuts,
} from '../src/renderer/src/lib/shortcuts'
it('normalizes shortcuts and rejects conflicts and bare typing keys', () => {
  expect(normalizeShortcut('ctrl+shift+k')).toBe('Ctrl-Shift-k')
  expect(() => normalizeShortcut('x')).toThrow()
  expect(() => validateShortcuts({ ...defaultShortcuts, close: 'Mod-n' })).toThrow(/冲突/)
  expect(
    matchesShortcut(
      { key: 'K', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false },
      'Ctrl-Shift-k',
    ),
  ).toBe(true)
  expect(
    matchesShortcut(
      { key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false },
      'Ctrl-Shift-k',
    ),
  ).toBe(false)
})
