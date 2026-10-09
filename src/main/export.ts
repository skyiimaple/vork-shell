import type { QueryResult } from '../shared/contracts'
function escape(value: unknown) {
  let text = value == null ? '' : String(value)
  // CSV is intended for spreadsheet viewing; neutralize formula-like cells.
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text
  return '"' + text.replaceAll('"', '""') + '"'
}
export function resultCsv(result: QueryResult): string {
  if (
    !result ||
    !Array.isArray(result.columns) ||
    !Array.isArray(result.rows) ||
    result.rows.length > 1000 ||
    result.columns.some((c) => typeof c !== 'string') ||
    result.rows.some(
      (row) =>
        !Array.isArray(row) ||
        row.length !== result.columns.length ||
        row.some((c) => c !== null && !['string', 'number', 'boolean'].includes(typeof c)),
    )
  )
    throw new Error('导出结果格式无效')
  const csv =
    '\uFEFF' +
    [result.columns, ...result.rows].map((row) => row.map(escape).join(',')).join('\r\n') +
    '\r\n'
  if (Buffer.byteLength(csv) > 16 * 1024 * 1024) throw new Error('导出内容过大')
  return csv
}
