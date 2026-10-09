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
