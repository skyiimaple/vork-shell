import { it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { objectsSql, schemasSql, columnsSql, previewSql } from '../src/renderer/src/lib/sql-browser'
it('browses real SQLite objects and quotes unusual names without executing injected statements', () => {
  const db = new DatabaseSync(':memory:')
  const name = 'a"; DROP TABLE survivor; --'
  const quoted = '"' + name.replaceAll('"', '""') + '"'
  db.exec(
    'CREATE TABLE survivor(id INTEGER); CREATE TABLE sqliteData(value TEXT); CREATE TABLE ' +
      quoted +
      '(value TEXT); INSERT INTO ' +
      quoted +
      " VALUES ('safe')",
  )
  const object = { schema: 'main', name, kind: 'table' }
  expect(db.prepare(objectsSql('sqlite')).all()).toHaveLength(3)
  expect(db.prepare(columnsSql('sqlite', object)).all()).toMatchObject([{ name: 'value' }])
  expect(db.prepare(previewSql('sqlite', object)).get()).toMatchObject({ value: 'safe' })
  expect(db.prepare('SELECT * FROM survivor').all()).toEqual([])
  db.close()
})
it('quotes MySQL and PostgreSQL identifiers and metadata predicates', () => {
  const object = { schema: 's`"', name: "a\\'; --", kind: 'table' }
  expect(previewSql('mysql', object)).toBe('SELECT * FROM `s``"`.`a\\\'; --` LIMIT 1000;')
  expect(previewSql('postgresql', object)).toContain('"s`""".')
  expect(columnsSql('mysql', object)).toContain('CONVERT(0x')
  expect(columnsSql('postgresql', object)).toContain("E'a\\\\''; --'")
  expect(() => objectsSql('redis')).toThrow()
})

it('browses attached SQLite databases without changing connection state', () => {
  const db = new DatabaseSync(':memory:')
  db.exec("ATTACH ':memory:' AS extra; CREATE TABLE extra.people(id INTEGER)")
  expect(db.prepare(schemasSql('sqlite')).all()).toMatchObject([
    { schema_name: 'main' },
    { schema_name: 'extra' },
  ])
  expect(db.prepare(objectsSql('sqlite', 'extra')).all()).toMatchObject([
    { schema_name: 'extra', name: 'people' },
  ])
  expect(db.prepare(objectsSql('sqlite')).all()).toEqual([])
  db.close()
})

it('previews 1000 rows and counts quoted objects using real SQLite queries', async () => {
  const { countSql, qualifiedName } = await import('../src/renderer/src/lib/sql-browser')
  const db = new DatabaseSync(':memory:')
  const object = { schema: 'main', name: 'quoted"table', kind: 'table' }
  try {
    db.exec(
      'CREATE TABLE "quoted""table" (value INTEGER); INSERT INTO "quoted""table" VALUES (1), (2)',
    )
    expect(db.prepare(countSql('sqlite', object)).get()).toMatchObject({ count: 2 })
    expect(previewSql('sqlite', object)).toContain('LIMIT 1000;')
    expect(qualifiedName('postgresql', object)).toBe('"main"."quoted""table"')
  } finally {
    db.close()
  }
})
