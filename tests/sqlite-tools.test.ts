import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { importCsv, dumpSqlite, parseSqliteCommand } from '../src/main/sqlite-tools'
it('imports quoted CSV with reordered headers and rolls back the entire import on constraint errors', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE "odd table" (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    expect(
      importCsv(db, 'odd table', 'value,id\r\n"hello, world",1\r\n"two\nlines",2\r\n').affectedRows,
    ).toBe(2)
    expect(db.prepare('SELECT value FROM "odd table" WHERE id=2').get()).toEqual({
      value: 'two\nlines',
    })
    expect(() => importCsv(db, 'odd table', 'id,value\n3,ok\n1,duplicate')).toThrow()
    expect(db.prepare('SELECT count(*) AS n FROM "odd table"').get()).toEqual({ n: 2 })
    expect(() => importCsv(db, 'odd table', 'id,value\n3')).toThrow()
    expect(parseSqliteCommand('.import "odd table"')).toEqual({
      kind: 'import',
      table: 'odd table',
    })
    expect(() => parseSqliteCommand('.read /etc/passwd')).toThrow()
  } finally {
    db.close()
  }
})
it('dump roundtrips blob, NULL, large integers, quoted text, indices, triggers and sequence state', () => {
  const source = new DatabaseSync(':memory:'),
    target = new DatabaseSync(':memory:')
  try {
    source.exec(
      "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, data BLOB, n INTEGER); CREATE INDEX ix ON t(text); INSERT INTO t VALUES (99,'it''s text',X'00FF',9223372036854775807); INSERT INTO t VALUES(100,NULL,NULL,NULL); DELETE FROM t WHERE id=100; CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET text=COALESCE(text,'trigger') WHERE id=new.id; END;",
    )
    const dump = dumpSqlite(source)
    target.exec(dump)
    const a = source.prepare('SELECT * FROM t'),
      b = target.prepare('SELECT * FROM t')
    a.setReadBigInts(true)
    b.setReadBigInts(true)
    expect(b.all()).toEqual(a.all())
    target.exec('INSERT INTO t(text) VALUES(NULL)')
    expect(target.prepare('SELECT id,text FROM t ORDER BY id DESC LIMIT 1').get()).toEqual({
      id: 101,
      text: 'trigger',
    })
    source.exec('CREATE VIRTUAL TABLE vt USING fts5(value)')
    expect(() => dumpSqlite(source)).toThrow(/虚拟/)
    expect(() => dumpSqlite(source, 'vt_content')).toThrow(/shadow/)
    expect(() => importCsv(source, 'vt_content', 'id,c0\n1,bad')).toThrow(/shadow/)
  } finally {
    source.close()
    target.close()
  }
})
it('includes legal sqliteX-prefixed tables and rejects an incomplete dump with temporary or attached schemas', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("CREATE TABLE sqliteXdemo(value TEXT); INSERT INTO sqliteXdemo VALUES ('kept')")
    expect(dumpSqlite(db)).toContain('CREATE TABLE sqliteXdemo')
    db.exec('CREATE TEMP TABLE temp_data(value TEXT)')
    expect(() => dumpSqlite(db)).toThrow(/临时/)
    db.exec(
      "DROP TABLE temp_data; ATTACH DATABASE ':memory:' AS extra; CREATE TABLE extra.other(value TEXT)",
    )
    expect(() => dumpSqlite(db)).toThrow(/附加/)
    expect(dumpSqlite(db, 'sqliteXdemo')).toContain('kept')
  } finally {
    db.close()
  }
})
