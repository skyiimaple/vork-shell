import type { DatabaseSync } from 'node:sqlite'
import type { Cell, QueryResult } from '../shared/contracts'
import { assertSingleStatement } from './validation'

export function toCell(value: unknown): Cell {
  if (value == null) return null
  if (typeof value === 'bigint')
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')
    return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return '0x' + Buffer.from(value).toString('hex')
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
}

export function runSqlite(
  db: DatabaseSync,
  sql: string,
  limit = 1000,
  parameters: Cell[] = [],
): QueryResult {
  assertSingleStatement(sql)
  const start = performance.now()
  const statement = db.prepare(sql)
  statement.setReadBigInts(true)
  const columns = statement.columns().map((c) => c.name)
  const rows: Cell[][] = []
  let affectedRows = 0,
    truncated = false,
    bytes = 0
  if (columns.length) {
    statement.setReturnArrays(true)
    for (const raw of statement.iterate(
      ...parameters.map((value) => (typeof value === 'boolean' ? Number(value) : value)),
    )) {
      const row = (raw as unknown as unknown[]).map(toCell)
      bytes += Buffer.byteLength(JSON.stringify(row))
      if (rows.length >= limit || bytes > 4 * 1024 * 1024) {
        truncated = true
        break
      }
      rows.push(row)
    }
  } else {
    affectedRows = Number(
      statement.run(
        ...parameters.map((value) => (typeof value === 'boolean' ? Number(value) : value)),
      ).changes,
    )
  }
  return {
    columns,
    rows,
    affectedRows,
    elapsedMs: Math.round(performance.now() - start),
    truncated,
  }
}
