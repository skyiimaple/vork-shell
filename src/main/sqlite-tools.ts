import type { DatabaseSync } from 'node:sqlite'
import type { QueryResult, SqliteToolRequest } from '../shared/contracts'
import { randomUUID } from 'node:crypto'
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'
export function parseSqliteCommand(
  command: string,
): { kind: 'import'; table: string } | { kind: 'dump'; table?: string } {
  const match = command.trim().match(/^\.(import|dump)(?:\s+("(?:[^"]|"")+"|[^\s";]+))?\s*$/)
  if (!match || (match[1] === 'import' && !match[2]))
    throw new Error('支持 .import 表名（选择带表头 CSV）与 .dump [表名]（导出 SQL）')
  const table = match[2]?.startsWith('"') ? match[2].slice(1, -1).replaceAll('""', '"') : match[2]
  if (table?.includes('\0')) throw new Error('表名无效')
  return match[1] === 'import' ? { kind: 'import', table: table! } : { kind: 'dump', table }
}
export function parseCsv(csv: string): string[][] {
  if (Buffer.byteLength(csv) > 16 * 1024 * 1024) throw new Error('CSV 超过 16 MiB')
  const rows: string[][] = []
  let row: string[] = [],
    field = '',
    quoted = false,
    endedQuote = false,
    started = false
  csv = csv.replace(/^\uFEFF/, '')
  const pushField = () => {
    row.push(field)
    field = ''
    endedQuote = false
    started = false
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
    if (rows.length > 100001) throw new Error('CSV 超过 100000 行')
  }
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]!
    if (quoted) {
      if (char === '"') {
        if (csv[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
          endedQuote = true
        }
      } else field += char
      continue
    }
    if (char === '"') {
      if (started || field || endedQuote) throw new Error('CSV 引号位置无效')
      quoted = true
      started = true
      continue
    }
    if (char === ',') {
      pushField()
      continue
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && csv[i + 1] === '\n') i++
      pushRow()
      continue
    }
    if (endedQuote) throw new Error('CSV 引号后存在额外字符')
    field += char
    started = true
  }
  if (quoted) throw new Error('CSV 引号未闭合')
  if (started || endedQuote || field || row.length) pushRow()
  return rows
}
function userTables(db: DatabaseSync, table?: string): { name: string; sql: string }[] {
  const rows = db
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    )
    .all() as unknown as { name: string; sql: string }[]
  const selected = table === undefined ? rows : rows.filter((row) => row.name === table)
  if (table !== undefined && !selected.length) throw new Error('main 数据库中不存在该用户表')
  const kinds = db.prepare('PRAGMA main.table_list').all()
  if (selected.some((row) => kinds.some((kind) => kind.name === row.name && kind.type !== 'table')))
    throw new Error('暂不支持虚拟表或其 shadow 内部表，请选择普通用户表')
  if (selected.some((row) => /^CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql)))
    throw new Error('暂不支持虚拟表导入或导出，请选择普通用户表')
  return selected
}
export function importCsv(db: DatabaseSync, table: string, csv: string): QueryResult {
  const started = performance.now()
  userTables(db, table)
  const rows = parseCsv(csv),
    headers = rows.shift()
  const columns = db.prepare(`PRAGMA main.table_xinfo(${quote(table)})`).all() as unknown as {
    name: string
    hidden: number
  }[]
  if (
    !headers?.length ||
    headers.some(
      (name) => !columns.some((column) => column.name === name && column.hidden === 0),
    ) ||
    new Set(headers).size !== headers.length
  )
    throw new Error('CSV 首行必须为唯一且匹配目标表可写字段的表头')
  if (rows.some((row) => row.length !== headers.length))
    throw new Error('CSV 行字段数量与表头不一致')
  const statement = db.prepare(
    `INSERT INTO main.${quote(table)} (${headers.map(quote).join(',')}) VALUES (${headers.map(() => '?').join(',')})`,
  )
  const savepoint = quote('vork_' + randomUUID())
  db.exec(`SAVEPOINT ${savepoint}`)
  try {
    for (const row of rows) statement.run(...row)
    db.exec(`RELEASE ${savepoint}`)
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
    throw error
  }
  return {
    columns: [],
    rows: [],
    affectedRows: rows.length,
    elapsedMs: Math.round(performance.now() - started),
    truncated: false,
  }
}
function literal(value: unknown): string {
  if (value === null) return 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return String(value)
    if (value === Infinity) return '9e999'
    if (value === -Infinity) return '-9e999'
    return 'NULL'
  }
  if (value instanceof Uint8Array) return "X'" + Buffer.from(value).toString('hex') + "'"
  if (typeof value === 'string') {
    if (value.includes('\0')) return "CAST(X'" + Buffer.from(value).toString('hex') + "' AS TEXT)"
    return "'" + value.replaceAll("'", "''") + "'"
  }
  throw new Error('不支持的 SQLite 数据类型')
}
export function dumpSqlite(db: DatabaseSync, table?: string): string {
  const statements: string[] = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;']
  let bytes = 64
  const append = (sql: string) => {
    bytes += Buffer.byteLength(sql)
    if (bytes > 16 * 1024 * 1024) throw new Error('导出 SQL 超过 16 MiB，请按表导出或使用 sqlite3')
    statements.push(sql)
  }
  // A read transaction keeps structure and rows consistent across concurrent writers.
  const savepoint = quote('vork_dump_' + randomUUID())
  db.exec(`SAVEPOINT ${savepoint}`)
  try {
    if (table === undefined) {
      if (
        db.prepare("SELECT 1 FROM sqlite_temp_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1").get()
      )
        throw new Error('存在临时对象，完整 .dump 暂不支持；请指定 main 中的普通表')
      if (
        db
          .prepare('PRAGMA database_list')
          .all()
          .some((database) => !['main', 'temp'].includes(String(database.name)))
      )
        throw new Error('存在附加数据库，完整 .dump 暂不支持；请指定 main 中的普通表')
    }
    const tables = userTables(db, table)
    for (const item of tables) append(item.sql + ';')
    for (const item of tables) {
      const columns = db
        .prepare(`PRAGMA main.table_xinfo(${quote(item.name)})`)
        .all() as unknown as { name: string; hidden: number }[]
      const writable = columns.filter((c) => c.hidden === 0).map((c) => c.name)
      const statement = db.prepare(
        `SELECT ${writable.map(quote).join(',')} FROM main.${quote(item.name)}`,
      )
      statement.setReadBigInts(true)
      statement.setReturnArrays(true)
      for (const values of statement.iterate())
        append(
          `INSERT INTO ${quote(item.name)} (${writable.map(quote).join(',')}) VALUES (${(values as unknown as unknown[]).map(literal).join(',')});`,
        )
    }
    const sequence = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()
    if (sequence) {
      const names = new Set(tables.map((t) => t.name))
      const query = db.prepare('SELECT name,seq FROM sqlite_sequence')
      query.setReadBigInts(true)
      for (const entry of query.iterate())
        if (names.has(String(entry.name))) {
          append(`DELETE FROM sqlite_sequence WHERE name=${literal(entry.name)};`)
          append(
            `INSERT INTO sqlite_sequence(name,seq) VALUES(${literal(entry.name)},${literal(entry.seq)});`,
          )
        }
    }
    const objects = db
      .prepare(
        "SELECT type,tbl_name,sql FROM sqlite_schema WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY CASE type WHEN 'view' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name",
      )
      .all()
    const names = new Set(tables.map((t) => t.name))
    for (const object of objects)
      if ((table === undefined && object.type === 'view') || names.has(String(object.tbl_name)))
        append(String(object.sql) + ';')
    append('COMMIT;')
    append('PRAGMA foreign_keys=ON;')
    db.exec(`RELEASE ${savepoint}`)
    return statements.join('\n') + '\n'
  } catch (error) {
    db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
    throw error
  }
}
export function runSqliteTool(db: DatabaseSync, request: SqliteToolRequest): QueryResult | string {
  if (request.kind === 'import') return importCsv(db, request.table, request.csv)
  if (request.kind === 'dump') return dumpSqlite(db, request.table)
  throw new Error('SQLite 工具命令无效')
}
