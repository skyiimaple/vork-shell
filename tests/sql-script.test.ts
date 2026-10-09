import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { splitSqlScript, runSqlScript } from '../src/shared/sql-script'
import { runSqlite } from '../src/main/sqlite'
describe('SQL scripts', () => {
  it('respects quoted separators, escaped identifiers and comments', () => {
    expect(
      splitSqlScript('SELECT \';\'; -- ;\n SELECT "a;"; /* ; */ SELECT 3', 'sqlite'),
    ).toHaveLength(3)
    expect(splitSqlScript("SELECT 'a\\';b'; SELECT 2", 'mysql')).toHaveLength(2)
    expect(
      splitSqlScript(
        'SELECT $$a;b$$; DO $body$ BEGIN PERFORM 1; END $body$; SELECT 2',
        'postgresql',
      ),
    ).toHaveLength(3)
  })
  it('keeps SQLite trigger statements intact', () => {
    const sql =
      'CREATE TABLE t(n); CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET n=CASE WHEN n=1 THEN 2 ELSE n END; INSERT INTO t VALUES(3); END; SELECT 1;'
    expect(splitSqlScript(sql, 'sqlite')).toHaveLength(3)
  })
  it('rejects incomplete or unsupported scripts before executing anything', () => {
    expect(() => splitSqlScript("SELECT 1; SELECT 'oops", 'sqlite')).toThrow()
    expect(() =>
      splitSqlScript('DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END $$', 'mysql'),
    ).toThrow()
    expect(() => splitSqlScript('SELECT 1;'.repeat(101), 'sqlite')).toThrow()
  })
  it('runs ordered SQLite statements and retains results before first failure', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      const batch = await runSqlScript(
        'CREATE TABLE t(n); INSERT INTO t VALUES(1); SELECT n FROM t; SELECT missing FROM t; INSERT INTO t VALUES(2)',
        'sqlite',
        async (sql) => runSqlite(db, sql),
      )
      expect(batch.results).toHaveLength(3)
      expect(batch.results[2]!.result.rows).toEqual([[1]])
      expect(batch.failedIndex).toBe(4)
      expect(batch.error).toContain('missing')
      expect(db.prepare('SELECT count(*) AS n FROM t').get()!.n).toBe(1)
    } finally {
      db.close()
    }
  })
})

it('bounds cumulative results while marking the last completed statement as truncated', async () => {
  let calls = 0
  const batch = await runSqlScript('SELECT 1;'.repeat(10), 'sqlite', async () => {
    calls++
    return {
      columns: ['v'],
      rows: [['x'.repeat(3900000)]],
      affectedRows: 0,
      elapsedMs: 1,
      truncated: false,
    }
  })
  expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(
    16 * 1024 * 1024,
  )
  expect(calls).toBe(batch.results.length)
  expect(batch.results.at(-1)!.result.truncated).toBe(true)
  expect(batch.error).toBeUndefined()
  expect(batch.notice).toContain('后续语句未执行')
})
