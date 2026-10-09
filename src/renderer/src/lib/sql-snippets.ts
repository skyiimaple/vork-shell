export type SqlDialect = 'sqlite' | 'mysql' | 'postgresql'
export interface SqlSnippet {
  id: string
  name: string
  sql: string
  dialect: SqlDialect
  updatedAt: number
}
export const snippetsKey = 'vork.sql-snippets.v1'
function validate(items: unknown): SqlSnippet[] {
  if (!Array.isArray(items) || items.length > 100) throw new Error('SQL 收藏数据无效或超过100条')
  const ids = new Set<string>()
  return items.map((item) => {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 100 ||
      ids.has(item.id) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.trim().length > 100 ||
      typeof item.sql !== 'string' ||
      !item.sql.trim() ||
      new TextEncoder().encode(item.sql).length > 65536 ||
      !['sqlite', 'mysql', 'postgresql'].includes(item.dialect) ||
      !Number.isFinite(item.updatedAt) ||
      item.updatedAt < 0
    )
      throw new Error('SQL 收藏数据无效：请检查名称、SQL或方言')
    ids.add(item.id)
    return {
      id: item.id,
      name: item.name.trim(),
      sql: item.sql,
      dialect: item.dialect,
      updatedAt: item.updatedAt,
    }
  })
}
export function encodeSnippets(items: SqlSnippet[]): string {
  const encoded = JSON.stringify({ version: 1, items: validate(items) })
  if (new TextEncoder().encode(encoded).length > 1024 * 1024)
    throw new Error('SQL 收藏总大小不能超过1 MiB')
  return encoded
}
export function decodeSnippets(raw: string | null): SqlSnippet[] {
  if (raw === null) return []
  if (new TextEncoder().encode(raw).length > 1024 * 1024)
    throw new Error('SQL 收藏总大小不能超过1 MiB')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('SQL 收藏数据损坏，原始数据已保留')
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !('version' in data) ||
    data.version !== 1 ||
    !('items' in data)
  )
    throw new Error('SQL 收藏数据格式无效')
  return validate(data.items)
}
export function upsertSnippet(
  items: SqlSnippet[],
  input: Pick<SqlSnippet, 'name' | 'sql' | 'dialect'>,
  id: string,
  updatedAt = Date.now(),
): SqlSnippet[] {
  const next = [{ ...input, id, updatedAt }, ...items.filter((item) => item.id !== id)]
  return decodeSnippets(encodeSnippets(next))
}
