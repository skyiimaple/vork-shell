import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { formatSql } from '../src/renderer/src/lib/sql-format'
it('formats clauses without changing quoted SQL, comments or execution results', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const sql = "select 'from,; -- unchanged' as x, 10-2 as y from (select 1) where 1=1 order by y;"
    const formatted = formatSql(sql, 'sqlite')
    expect(formatted).toContain('\nfrom')
    expect(formatted).toContain("'from,; -- unchanged'")
    expect(db.prepare(formatted).all()).toEqual(db.prepare(sql).all())
    expect(
      formatSql("select $$a; from 'b'$$, $tag$-- x$tag$ -- keep\nfrom t", 'postgresql'),
    ).toContain("$$a; from 'b'$$")
    expect(formatSql('select `a\\`b` # keep\nfrom t', 'mysql')).toContain('`a\\`b`')
    expect(() => formatSql("select 'unterminated", 'sqlite')).toThrow()
  } finally {
    db.close()
  }
})

it('preserves adjacent parameter, hex, decimal, unicode literal and postgres placeholder tokens', () => {
  const db = new DatabaseSync(':memory:')
  try {
    for (const sql of ['select 0x10,.5,1e-2', 'select :v', 'select @v', 'select $v', 'select ?1']) {
      const formatted = formatSql(sql, 'sqlite')
      if (sql.includes('v'))
        expect(db.prepare(formatted).get({ v: 42 })).toEqual(db.prepare(sql).get({ v: 42 }))
      else if (sql.includes('?'))
        expect(db.prepare(formatted).get(42)).toEqual(db.prepare(sql).get(42))
      else expect(db.prepare(formatted).get()).toEqual(db.prepare(sql).get())
    }
    expect(formatSql('select $1::text, U&"d\\0061t", U&\'d\\0061t\'', 'postgresql')).toContain(
      '$1::text',
    )
    expect(formatSql("select U&'abc'", 'postgresql')).toContain("U&'abc'")
  } finally {
    db.close()
  }
})
it('retains PostgreSQL newline between adjacent string literals', () => {
  expect(formatSql("select 'a'\n'b' as x", 'postgresql')).toContain("'a'\n'b'")
})
it('keeps named parameter identifiers intact even when they are clause keywords', () => {
  const db = new DatabaseSync(':memory:')
  try {
    for (const sql of ['select :from', 'select @where', 'select $select', 'select :order'])
      expect(db.prepare(formatSql(sql, 'sqlite')).get({ [sql.slice(8)]: 42 })).toEqual(
        db.prepare(sql).get({ [sql.slice(8)]: 42 }),
      )
  } finally {
    db.close()
  }
})
it('does not combine separated column names with following string aliases', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("CREATE TABLE t(x TEXT); INSERT INTO t VALUES('actual')")
    const sql = "SELECT x\n'alias' FROM t"
    expect(db.prepare(formatSql(sql, 'sqlite')).all()).toEqual(db.prepare(sql).all())
  } finally {
    db.close()
  }
})
