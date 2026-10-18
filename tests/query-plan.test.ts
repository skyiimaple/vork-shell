import { it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { explainQuery, parsePlan } from '../src/main/query-plan'
import { runSqlite } from '../src/main/sqlite'
it('explains indexed SQLite queries and never executes an explained write', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT);CREATE INDEX title_idx ON items(title)',
  )
  try {
    const query = async (sql: string) => runSqlite(db, sql, 1000)
    const result = await explainQuery('sqlite', "SELECT * FROM items WHERE title='test'", query)
    expect(result.nodes.some((node) => node.label.includes('title_idx'))).toBe(true)
    await explainQuery('sqlite', "INSERT INTO items VALUES(1,'not-executed')", query)
    expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()?.n).toBe(0)
    await expect(explainQuery('sqlite', 'SELECT 1;DELETE FROM items', query)).rejects.toThrow(
      '一条',
    )
    await expect(explainQuery('sqlite', 'EXPLAIN ANALYZE SELECT 1', query)).rejects.toThrow(
      '原始 SQL',
    )
    await explainQuery('sqlite', '-- comment\nSELECT 1;', query)
  } finally {
    db.close()
  }
})
it('preserves nested PostgreSQL nodes, estimates and MySQL JSON access details', () => {
  const result = (value: unknown) => ({
    columns: ['plan'],
    rows: [[JSON.stringify(value)]],
    affectedRows: 0,
    elapsedMs: 0,
    truncated: false,
  })
  const pg = parsePlan(
    'postgresql',
    result([
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Total Cost': 12.5,
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Index Name': 'idx',
              'Relation Name': 'items',
              'Plan Rows': 4,
            },
          ],
        },
      },
    ]),
  )
  expect(pg[0]?.label).toBe('Nested Loop')
  expect(pg[0]?.children[0]?.details['Index Name']).toBe('idx')
  const mysql = parsePlan(
    'mysql',
    result({
      query_block: {
        select_id: 1,
        nested_loop: [
          {
            table: {
              table_name: 'items',
              access_type: 'ref',
              key: 'title_idx',
              rows_examined_per_scan: 1,
            },
          },
        ],
      },
    }),
  )
  expect(JSON.stringify(mysql)).toContain('title_idx')
  expect(() => parsePlan('postgresql', result({ bad: true }))).toThrow()
})
