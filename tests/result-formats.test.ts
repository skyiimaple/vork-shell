import { it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import ExcelJS from 'exceljs'
import { resultInsert, resultXlsx } from '../src/main/result-formats'
const result = {
  columns: ['a', 'b', 'c'],
  rows: [
    ["O'Reilly\\path", null, '9007199254740993'],
    ['=1+1', true, 12],
  ],
  affectedRows: 0,
  elapsedMs: 0,
  truncated: false,
}
it('round trips INSERT values using safely quoted SQLite identifiers', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE "odd\""table" (a, b, c)')
    db.exec(resultInsert(result, 'odd"table', 'sqlite'))
    expect(
      db
        .prepare('SELECT * FROM "odd\""table"')
        .all()
        .map((row) => Object.values(row)),
    ).toEqual([result.rows[0], ['=1+1', 1, 12]])
  } finally {
    db.close()
  }
})
it('escapes MySQL strings without depending on server backslash mode and rejects duplicate columns', () => {
  const text = resultInsert(result, 'we`ird', 'mysql')
  expect(text).toContain('INSERT INTO `we``ird`')
  expect(text).toContain("CONVERT(X'4f275265696c6c795c70617468' USING utf8mb4)")
  expect(() => resultInsert({ ...result, columns: ['a', 'a', 'c'] }, 'target', 'sqlite')).toThrow()
  expect(() => resultInsert(result, '', 'postgresql')).toThrow()
})
it('writes a real XLSX keeping text, duplicate headers, booleans and nulls without formulas', async () => {
  const bytes = await resultXlsx(result)
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(Uint8Array.from(bytes).buffer)
  const sheet = book.worksheets[0]!
  expect(sheet.getCell('A2').value).toBe("O'Reilly\\path")
  expect(sheet.getCell('C2').value).toBe('9007199254740993')
  expect(sheet.getCell('A3').value).toBe('=1+1')
  expect(sheet.getCell('B2').value).toBeNull()
  expect(sheet.getCell('B3').value).toBe(true)
})
it('rejects XLSX truncation and PostgreSQL NUL strings explicitly', async () => {
  await expect(resultXlsx({ ...result, rows: [['x'.repeat(32768), null, null]] })).rejects.toThrow(
    'Excel',
  )
  expect(() =>
    resultInsert({ ...result, rows: [['a\0b', null, null]] }, 'target', 'postgresql'),
  ).toThrow('NUL')
  expect(() =>
    resultInsert({ ...result, rows: [[Infinity, null, null]] }, 'target', 'sqlite'),
  ).toThrow()
})
