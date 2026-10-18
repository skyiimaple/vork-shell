import { it, expect } from 'vitest'
import { resultCsv } from '../src/main/export'
it('escapes CSV quotes, newlines, nulls and spreadsheet formulas without rounding big strings', () => {
  const csv = resultCsv({
    columns: ['a', 'b'],
    rows: [
      ['"\n,', '9007199254740993'],
      ['=1+1', null],
    ],
    affectedRows: 0,
    elapsedMs: 0,
    truncated: false,
  })
  expect(csv).toContain('"""\n,"')
  expect(csv).toContain('"9007199254740993"')
  expect(csv).toContain('"\'=1+1",""')
  expect(() =>
    resultCsv({ columns: ['a'], rows: [[{}, null]], affectedRows: 0 } as never),
  ).toThrow()
})

it('exports JSON arrays without losing duplicate column names and escapes Markdown cells', async () => {
  const { resultText } = await import('../src/main/export')
  const result = {
    columns: ['a', 'a'],
    rows: [['x|y\nz', null]],
    affectedRows: 0,
    elapsedMs: 0,
    truncated: false,
  }
  expect(JSON.parse(resultText(result, 'json'))).toEqual({
    columns: ['a', 'a'],
    rows: [['x|y\nz', null]],
  })
  expect(resultText(result, 'markdown')).toContain('x\\|y<br>z')
  expect(() => resultText(result, 'exe' as never)).toThrow()
})

it('quotes TSV separators and line breaks while retaining NULL and large integer text', async () => {
  const { resultText } = await import('../src/main/export')
  expect(
    resultText(
      {
        columns: ['a', 'b'],
        rows: [
          ['x\ty\n"z', null],
          ['9007199254740993', false],
        ],
        affectedRows: 0,
        elapsedMs: 0,
        truncated: false,
      },
      'tsv',
    ),
  ).toBe('a\tb\n"x\ty\n""z"\tNULL\n9007199254740993\tfalse')
})
