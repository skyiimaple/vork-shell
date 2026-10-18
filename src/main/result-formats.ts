import ExcelJS from 'exceljs'
import type { QueryResult } from '../shared/contracts'
import { resultCsv } from './export'
export function resultInsert(result: QueryResult, table: string, dialect: string): string {
  resultCsv(result)
  if (
    !['sqlite', 'mysql', 'postgresql'].includes(dialect) ||
    typeof table !== 'string' ||
    !table.trim() ||
    table.length > 256 ||
    table.includes('\0')
  )
    throw new Error('目标表名或数据库类型无效')
  if (
    !result.columns.length ||
    new Set(result.columns).size !== result.columns.length ||
    result.columns.some((column) => !column || column.includes('\0'))
  )
    throw new Error('INSERT 需要非空且不重复的字段名，请为查询字段设置别名')
  const quote = (name: string) =>
    dialect === 'mysql'
      ? '`' + name.replaceAll('`', '``') + '`'
      : '"' + name.replaceAll('"', '""') + '"'
  const literal = (value: unknown): string => {
    if (value === null) return 'NULL'
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('无法导出非有限数值')
      return String(value)
    }
    const text = String(value)
    if (dialect === 'mysql')
      return text ? `CONVERT(X'${Buffer.from(text).toString('hex')}' USING utf8mb4)` : "''"
    if (dialect === 'sqlite') return `CAST(X'${Buffer.from(text).toString('hex')}' AS TEXT)`
    if (text.includes('\0')) throw new Error('PostgreSQL 文本不能包含 NUL 字符')
    return "E'" + text.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'"
  }
  const text =
    result.rows
      .map(
        (row) =>
          `INSERT INTO ${quote(table)} (${result.columns.map(quote).join(', ')}) VALUES (${row.map(literal).join(', ')});`,
      )
      .join('\n') + '\n'
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('导出内容过大')
  return text
}
export async function resultXlsx(result: QueryResult): Promise<Buffer> {
  resultCsv(result)
  if (
    result.columns.length > 16384 ||
    result.columns.some((column) => column.length > 32767) ||
    result.rows.some((row) =>
      row.some((value) => typeof value === 'string' && value.length > 32767),
    )
  )
    throw new Error('内容超过 Excel 单元格或列数限制')
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('查询结果')
  sheet.addRow(result.columns)
  for (const row of result.rows) sheet.addRow(row)
  sheet.getRow(1).font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  return Buffer.from(await book.xlsx.writeBuffer())
}
