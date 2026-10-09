import type { Completion, CompletionSource } from '@codemirror/autocomplete'
import {
  schemaCompletionSource,
  SQLite,
  MySQL,
  PostgreSQL,
  type SQLConfig,
  type SQLNamespace,
} from '@codemirror/lang-sql'
export interface SqlCompletionTable {
  schema: string
  name: string
  columns: string[]
}
export function sqlCompletionConfig(
  language: 'sqlite' | 'mysql' | 'postgresql',
  tables: readonly SqlCompletionTable[],
): SQLConfig {
  const quote = language === 'mysql' ? '`' : '"'
  const option = (name: string, type: string) => ({
    label: name,
    type,
    identifier: name,
    apply: quote + name.split(quote).join(quote + quote) + quote,
  })
  const path = (name: string) => name.replaceAll('.', '\\.')
  const schema: Record<
    string,
    { self: ReturnType<typeof option>; children: Record<string, SQLNamespace> }
  > = Object.create(null)
  for (const table of tables) {
    const key = path(table.schema)
    if (!Object.hasOwn(schema, key))
      schema[key] = { self: option(table.schema, 'namespace'), children: Object.create(null) }
    schema[key]!.children[path(table.name)] = {
      self: option(table.name, 'type'),
      children: table.columns.map((name) => option(name, 'property')),
    }
  }
  return {
    dialect: { sqlite: SQLite, mysql: MySQL, postgresql: PostgreSQL }[language],
    schema,
    defaultSchema:
      language === 'sqlite' ? 'main' : language === 'postgresql' ? 'public' : tables[0]?.schema,
    upperCaseKeywords: true,
  }
}

// The upstream SQL source drops `apply` inside an already quoted identifier.
// Keep the original identifier on each option so quoting never loses escaping.
export function safeSchemaCompletionSource(config: SQLConfig): CompletionSource {
  const source = schemaCompletionSource(config)
  return async (context) => {
    const result = await source(context)
    if (!result) return null
    const quote = context.state.sliceDoc(result.from, result.from + 1)
    if (quote !== '"' && quote !== '`') return result
    return {
      ...result,
      options: result.options.map((option) => {
        const name = (option as Completion & { identifier?: string }).identifier
        if (name === undefined) return option
        const quoted = quote + name.split(quote).join(quote + quote) + quote
        return { ...option, label: quoted, apply: quoted }
      }),
    }
  }
}
