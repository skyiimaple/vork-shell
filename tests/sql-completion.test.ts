import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { schemaCompletionSource, keywordCompletionSource, sql } from '@codemirror/lang-sql'
import {
  sqlCompletionConfig,
  safeSchemaCompletionSource,
} from '../src/renderer/src/lib/sql-completion'
const tables = [
  { schema: 'main', name: 'ui table', columns: ['id', 'title'] },
  { schema: '__proto__', name: 'constructor', columns: ['toString'] },
]
describe('local SQL completion', () => {
  it('offers loaded tables and safely quotes names with spaces', async () => {
    const config = sqlCompletionConfig('sqlite', tables)
    const doc = 'SELECT * FROM main.'
    const result = await schemaCompletionSource(config)(
      new CompletionContext(
        EditorState.create({ doc, extensions: [sql(config)] }),
        doc.length,
        true,
      ),
    )
    expect(result?.options.some((o) => o.label === 'ui table' && o.apply === '"ui table"')).toBe(
      true,
    )
    expect(Object.getPrototypeOf(config.schema)).toBeNull()
  })
  it('offers columns for a qualified table, including prototype-like identifiers', async () => {
    const config = sqlCompletionConfig('sqlite', tables)
    const doc = 'SELECT main."ui table".'
    const result = await schemaCompletionSource(config)(
      new CompletionContext(
        EditorState.create({ doc, extensions: [sql(config)] }),
        doc.length,
        true,
      ),
    )
    expect(result?.options.map((o) => o.label)).toContain('title')
    const prototypeDoc = 'SELECT "__proto__"."constructor".'
    const prototypeResult = await schemaCompletionSource(config)(
      new CompletionContext(
        EditorState.create({ doc: prototypeDoc, extensions: [sql(config)] }),
        prototypeDoc.length,
        true,
      ),
    )
    expect(prototypeResult?.options.map((o) => o.label)).toContain('toString')
  })
  it.each(['sqlite', 'mysql', 'postgresql'] as const)(
    'escapes embedded quotes when completing inside quotes in %s',
    async (language) => {
      const quote = language === 'mysql' ? '`' : '"'
      const name = 'a' + quote + '; DROP TABLE survivor; --'
      const config = sqlCompletionConfig(language, [{ schema: 'main', name, columns: [] }])
      const doc = 'SELECT * FROM main.' + quote + 'a'
      const result = await safeSchemaCompletionSource(config)(
        new CompletionContext(
          EditorState.create({ doc, extensions: [sql(config)] }),
          doc.length,
          true,
        ),
      )
      expect(result?.options.find((o) => o.type === 'type')?.apply).toBe(
        quote + name.replaceAll(quote, quote + quote) + quote,
      )
    },
  )
  it('offers uppercase dialect keywords without any schema', async () => {
    const config = sqlCompletionConfig('sqlite', [])
    const result = await keywordCompletionSource(
      config.dialect!,
      true,
    )(new CompletionContext(EditorState.create({ doc: 'SEL' }), 3, true))
    expect(result?.options.some((o) => o.label === 'SELECT')).toBe(true)
  })
})
