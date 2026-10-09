import { describe, expect, it } from 'vitest'
import { decodeSnippets, encodeSnippets, upsertSnippet } from '../src/renderer/src/lib/sql-snippets'
const input = { name: '常用查询', sql: 'SELECT 1;', dialect: 'sqlite' as const }
describe('SQL snippet library', () => {
  it('round-trips only snippet data and updates the same identity', () => {
    const first = upsertSnippet([], input, 'one', 1)
    const next = upsertSnippet(first, { ...input, name: '改名' }, 'one', 2)
    expect(next).toHaveLength(1)
    expect(decodeSnippets(encodeSnippets(next))).toEqual(next)
    expect(next[0]).toEqual({ ...input, name: '改名', id: 'one', updatedAt: 2 })
  })
  it('rejects damaged storage instead of replacing it with an empty library', () => {
    expect(decodeSnippets(null)).toEqual([])
    expect(() => decodeSnippets('{')).toThrow()
    expect(() =>
      decodeSnippets(
        JSON.stringify({
          version: 1,
          items: [{ ...input, id: 'one', updatedAt: 1, dialect: 'redis' }],
        }),
      ),
    ).toThrow()
  })
  it('bounds names, SQL, count and encoded bytes', () => {
    expect(() => upsertSnippet([], { ...input, name: ' ' }, 'one')).toThrow()
    expect(() => upsertSnippet([], { ...input, sql: 'x'.repeat(65537) }, 'one')).toThrow()
    expect(() => upsertSnippet([], { ...input, sql: '汉'.repeat(22000) }, 'one')).toThrow()
    const many = Array.from({ length: 100 }, (_, i) => ({ ...input, id: String(i), updatedAt: 1 }))
    expect(() => upsertSnippet(many, input, 'new')).toThrow()
    expect(() =>
      encodeSnippets(
        Array.from({ length: 20 }, (_, i) => ({
          ...input,
          id: String(i),
          updatedAt: 1,
          sql: 'x'.repeat(60000),
        })),
      ),
    ).toThrow()
  })
  it('rejects duplicate identities and preserves SQL whitespace', () => {
    const item = upsertSnippet([], { ...input, sql: '  SELECT 1;\n' }, 'one', 1)[0]!
    expect(item.sql).toBe('  SELECT 1;\n')
    expect(() => decodeSnippets(JSON.stringify({ version: 1, items: [item, item] }))).toThrow()
  })
})
