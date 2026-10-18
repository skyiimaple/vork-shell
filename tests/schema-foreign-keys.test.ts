import { it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SchemaTools } from '../src/main/schema-tools'
import { runSqlite } from '../src/main/sqlite'
it('manages real SQLite composite foreign keys through preview tokens and protects invalid mappings', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    "CREATE TABLE p(a INTEGER,b TEXT,PRIMARY KEY(a,b));INSERT INTO p VALUES(1,'one');CREATE TABLE c(id INTEGER PRIMARY KEY,pa INTEGER,pb TEXT);INSERT INTO c VALUES(1,1,'one')",
  )
  const service = new SchemaTools('sqlite', async (sql, params = []) =>
      runSqlite(db, sql, 1000, params),
    ),
    table = { schema: 'main', name: 'c' }
  const input = {
    kind: 'preview-create-foreign-key',
    table,
    name: 'odd"fk',
    columns: ['pa', 'pb'],
    reference: { schema: 'main', name: 'p' },
    referenceColumns: ['a', 'b'],
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT',
  } as const
  try {
    const plan = await service.request({
      ...input,
      columns: [...input.columns],
      referenceColumns: [...input.referenceColumns],
    })
    if (plan.kind !== 'schema-preview') throw Error()
    expect(db.prepare('PRAGMA foreign_key_list(c)').all()).toEqual([])
    await service.request({ kind: 'commit', token: plan.token })
    const list = await service.request({ kind: 'foreign-keys', table })
    if (list.kind !== 'foreign-keys') throw Error()
    expect(list.keys[0]).toMatchObject({
      name: 'odd"fk',
      fromColumns: ['pa', 'pb'],
      toColumns: ['a', 'b'],
      droppable: true,
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    })
    expect(() => db.exec("INSERT INTO c VALUES(2,9,'bad')")).toThrow()
    db.exec('UPDATE p SET a=2')
    expect(db.prepare('SELECT pa FROM c').get()!.pa).toBe(2)
    const drop = await service.request({
      kind: 'preview-drop-foreign-key',
      table,
      key: list.keys[0]!.key,
    })
    if (drop.kind !== 'schema-preview') throw Error()
    await service.request({ kind: 'commit', token: drop.token })
    db.exec('DELETE FROM p')
    expect(db.prepare('SELECT pa FROM c').get()!.pa).toBe(2)
    for (const invalid of [
      { columns: ['missing', 'pb'] },
      { referenceColumns: ['a', 'missing'] },
      { onDelete: 'CASCADE;DROP TABLE p' },
      { columns: ['pa', 'pa'] },
      { reference: undefined },
    ])
      await expect(
        service.request({
          ...input,
          columns: [...input.columns],
          referenceColumns: [...input.referenceColumns],
          ...invalid,
        } as never),
      ).rejects.toThrow()
  } finally {
    db.close()
  }
})
