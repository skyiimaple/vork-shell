import { it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { runSqlite } from '../src/main/sqlite'
import { SqliteRebuildService, sqliteForeignKeyClauses } from '../src/main/sqlite-rebuild'
it('reads named composite and unnamed inline clauses without consuming adjacent constraints', () => {
  const sql = `CREATE TABLE c(id INTEGER PRIMARY KEY,a TEXT CONSTRAINT inline_fk REFERENCES parent(id) ON UPDATE CASCADE ON DELETE SET DEFAULT NOT NULL DEFAULT 'x',b INTEGER,CONSTRAINT "composite" FOREIGN KEY(a,b) REFERENCES p(x,y) DEFERRABLE INITIALLY DEFERRED)`
  const keys = sqliteForeignKeyClauses(sql)
  expect(keys).toHaveLength(2)
  expect(keys[0]).toMatchObject({
    name: 'inline_fk',
    fromColumns: ['a'],
    toTable: 'parent',
    toColumns: ['id'],
    onUpdate: 'CASCADE',
    onDelete: 'SET DEFAULT',
    whole: false,
  })
  expect(keys[0]!.definition).not.toContain('NOT NULL')
  expect(keys[1]).toMatchObject({
    name: 'composite',
    fromColumns: ['a', 'b'],
    toTable: 'p',
    toColumns: ['x', 'y'],
    whole: true,
  })
})
it('adds and drops table and inline foreign keys transactionally, including invalid-data repair', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE p(id INTEGER PRIMARY KEY);INSERT INTO p VALUES(1);CREATE TABLE c(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES p(id) NOT NULL DEFAULT 1);INSERT INTO c VALUES(1,1)',
  )
  const service = new SqliteRebuildService(async (sql, params = []) =>
      runSqlite(db, sql, 1000, params),
    ),
    table = { schema: 'main', name: 'c' }
  try {
    const source = () =>
      String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='c'").get()!.sql)
    let plan = await service.preview(table, {
      kind: 'drop-foreign-key',
      key: sqliteForeignKeyClauses(source())[0]!.key,
    } as never)
    await service.commit(plan.token)
    expect(db.prepare('PRAGMA foreign_key_list(c)').all()).toEqual([])
    expect(db.prepare('PRAGMA table_info(c)').all()[1]).toMatchObject({
      notnull: 1,
      dflt_value: '1',
    })
    plan = await service.preview(table, {
      kind: 'add-foreign-key',
      name: 'new_fk',
      definition:
        'CONSTRAINT "new_fk" FOREIGN KEY("pid") REFERENCES "p"("id") ON DELETE CASCADE ON UPDATE RESTRICT',
    } as never)
    await service.commit(plan.token)
    expect(db.prepare('PRAGMA foreign_key_list(c)').all()).toHaveLength(1)
    db.exec('PRAGMA foreign_keys=OFF;UPDATE c SET pid=99;PRAGMA foreign_keys=ON')
    plan = await service.preview(table, {
      kind: 'drop-foreign-key',
      key: sqliteForeignKeyClauses(source())[0]!.key,
    } as never)
    await service.commit(plan.token)
    expect(db.prepare('SELECT pid FROM c').get()!.pid).toBe(99)
    const invalid = await service.preview(table, {
      kind: 'add-foreign-key',
      name: 'invalid',
      definition: 'CONSTRAINT "invalid" FOREIGN KEY(pid) REFERENCES p(id)',
    } as never)
    await expect(service.commit(invalid.token)).rejects.toThrow('外键')
    expect(db.prepare('PRAGMA foreign_key_list(c)').all()).toEqual([])
  } finally {
    db.close()
  }
})
