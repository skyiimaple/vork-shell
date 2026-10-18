import { splitSqlScript, type SqlDialect } from '../shared/sql-script'
import type { QueryResult, QueryPlan, PlanNode } from '../shared/contracts'
function head(sql: string, dialect: SqlDialect): string {
  let index = 0
  while (index < sql.length) {
    if (/\s/.test(sql[index]!)) {
      index++
      continue
    }
    if (sql.startsWith('--', index) || (dialect === 'mysql' && sql[index] === '#')) {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end + 1
      continue
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1
      index += 2
      while (index < sql.length && depth) {
        if (dialect === 'postgresql' && sql.startsWith('/*', index)) {
          depth++
          index += 2
        } else if (sql.startsWith('*/', index)) {
          depth--
          index += 2
        } else index++
      }
      continue
    }
    break
  }
  return (
    sql
      .slice(index)
      .match(/^[a-z]+/i)?.[0]
      ?.toUpperCase() || ''
  )
}
export function parsePlan(dialect: SqlDialect, raw: QueryResult): PlanNode[] {
  let count = 0
  const create = (label: string): PlanNode => {
    if (++count > 2000) throw new Error('计划节点过多')
    return { id: String(count), label, details: {}, children: [] }
  }
  if (dialect === 'sqlite') {
    const nodes = new Map<string, PlanNode>(),
      parents = new Map<string, string>()
    for (const row of raw.rows) {
      if (
        row.length < 4 ||
        !['number', 'string'].includes(typeof row[0]) ||
        typeof row[3] !== 'string'
      )
        throw new Error('SQLite 计划格式无法识别')
      const id = String(row[0])
      if (nodes.has(id)) throw new Error('SQLite 计划节点重复')
      const node = create(row[3])
      node.details = { id, parent: String(row[1]) }
      nodes.set(id, node)
      parents.set(id, String(row[1]))
    }
    const roots: PlanNode[] = []
    for (const [id, node] of nodes) {
      const parent = parents.get(id)!
      let cursor = parent,
        depth = 0
      while (nodes.has(cursor) && cursor !== parents.get(cursor)) {
        if (cursor === id || ++depth > 64) throw new Error('计划层级过深或存在循环')
        cursor = parents.get(cursor)!
      }
      if (parent !== id && nodes.has(parent)) nodes.get(parent)!.children.push(node)
      else roots.push(node)
    }
    return roots
  }
  const cell = raw.rows[0]?.[0]
  if (typeof cell !== 'string') throw new Error('JSON 计划格式无法识别')
  const document: unknown = JSON.parse(cell)
  const record = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === 'object' && !Array.isArray(value))
  const scalar = (value: unknown) =>
    value === null ? 'NULL' : typeof value === 'string' ? value : JSON.stringify(value)
  if (dialect === 'postgresql') {
    const walk = (value: unknown, depth: number): PlanNode => {
      if (depth > 64 || !record(value) || typeof value['Node Type'] !== 'string')
        throw new Error('PostgreSQL 计划格式无法识别')
      const node = create(value['Node Type'])
      for (const [key, item] of Object.entries(value))
        if (key !== 'Plans') node.details[key] = scalar(item)
      if (value.Plans !== undefined) {
        if (!Array.isArray(value.Plans)) throw new Error('计划子节点无效')
        node.children = value.Plans.map((child) => walk(child, depth + 1))
      }
      return node
    }
    if (!Array.isArray(document) || !record(document[0]) || !record(document[0].Plan))
      throw new Error('PostgreSQL 计划缺少根节点')
    return [walk(document[0].Plan, 0)]
  }
  if (!record(document) || !record(document.query_block)) throw new Error('MySQL 计划缺少查询块')
  const walk = (key: string, value: Record<string, unknown>, depth: number): PlanNode => {
    if (depth > 64) throw new Error('计划层级过深')
    const node = create(
      key === 'table'
        ? '表 ' + String(value.table_name || '')
        : key === 'query_block'
          ? '查询块 ' + String(value.select_id || '')
          : key,
    )
    for (const [name, item] of Object.entries(value)) {
      if (record(item)) node.children.push(walk(name, item, depth + 1))
      else if (Array.isArray(item) && item.some(record)) {
        const group = create(name)
        for (const child of item)
          if (record(child)) group.children.push(walk(name, child, depth + 1))
        node.children.push(group)
      } else node.details[name] = scalar(item)
    }
    return node
  }
  return [walk('query_block', document.query_block, 0)]
}
export async function explainQuery(
  dialect: SqlDialect,
  sql: string,
  query: (sql: string) => Promise<QueryResult>,
): Promise<QueryPlan> {
  const statements = splitSqlScript(sql, dialect)
  if (statements.length !== 1) throw new Error('执行计划仅支持一条 SQL，请选中需要分析的语句')
  const statement = statements[0]!,
    keyword = head(statement, dialect)
  if (keyword === 'EXPLAIN') throw new Error('请提供原始 SQL，不要包含 EXPLAIN 或 ANALYZE')
  if (
    ![
      'SELECT',
      'WITH',
      'INSERT',
      'UPDATE',
      'DELETE',
      'REPLACE',
      'VALUES',
      'TABLE',
      'MERGE',
    ].includes(keyword)
  )
    throw new Error('此语句不支持执行计划，请使用查询或数据操作语句')
  const prefix =
    dialect === 'sqlite'
      ? 'EXPLAIN QUERY PLAN '
      : dialect === 'mysql'
        ? 'EXPLAIN FORMAT=JSON '
        : 'EXPLAIN (FORMAT JSON, VERBOSE TRUE, COSTS TRUE) '
  const raw = await query(prefix + statement),
    warnings: string[] = []
  if (raw.truncated) warnings.push('执行计划达到返回上限，显示内容可能不完整')
  let nodes: PlanNode[] = []
  try {
    nodes = parsePlan(dialect, raw)
  } catch (e) {
    warnings.push('可视化解析失败：' + (e as Error).message + '。请查看原始计划。')
  }
  if (!nodes.length && !warnings.length) warnings.push('数据库未为此语句返回可视计划节点')
  return { dialect, sql: statement, nodes, raw, warnings }
}
