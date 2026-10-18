import { DatabaseSync } from 'node:sqlite'
import { it, expect } from 'vitest'
import { runSqlite } from '../src/main/sqlite'
import { SchemaTools } from '../src/main/schema-tools'
it('inspects structure and previews index creation/deletion without executing before confirmation', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    `PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT UNIQUE, parent_id INTEGER REFERENCES parent(id)); CREATE TRIGGER item_trigger AFTER INSERT ON items BEGIN SELECT 1; END`,
  )
  const service = new SchemaTools('sqlite', async (sql, params = []) =>
    runSqlite(db, sql, 1000, params),
  )
  const table = { schema: 'main', name: 'items' }
  try {
    const info = await service.request({ kind: 'inspect', table })
    if (info.kind !== 'schema') throw Error()
    expect(info.foreignKeys.rows).toHaveLength(1)
    expect(info.triggers.rows).toHaveLength(1)
    expect(info.indexes.some((index) => index.protected)).toBe(true)
    const preview = await service.request({
      kind: 'preview-create-index',
      table,
      name: 'odd"index',
      columns: [{ name: 'parent_id', descending: true }],
      unique: false,
    })
    if (preview.kind !== 'schema-preview') throw Error()
    expect(
      db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get('odd"index'),
    ).toBeUndefined()
    await service.request({ kind: 'commit', token: preview.token })
    const updated = await service.request({ kind: 'inspect', table })
    if (updated.kind !== 'schema') throw Error()
    expect(updated.indexes.find((index) => index.name === 'odd"index')?.columns).toEqual([
      'parent_id DESC',
    ])
    const drop = await service.request({ kind: 'preview-drop-index', table, name: 'odd"index' })
    if (drop.kind !== 'schema-preview') throw Error()
    await service.request({ kind: 'commit', token: drop.token })
    await expect(service.request({ kind: 'commit', token: drop.token })).rejects.toThrow()
    await expect(
      service.request({ kind: 'preview-drop-index', table, name: info.indexes[0]!.name }),
    ).rejects.toThrow('约束')
    await expect(
      service.request({
        kind: 'preview-create-index',
        table,
        name: 'bad',
        columns: [{ name: 'missing', descending: false }],
        unique: false,
      }),
    ).rejects.toThrow()
  } finally {
    db.close()
  }
})
it('rejects a stale schema preview and index creation on a view', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT);CREATE VIEW visible AS SELECT * FROM items',
  )
  const service = new SchemaTools('sqlite', async (sql, params = []) =>
    runSqlite(db, sql, 1000, params),
  )
  const table = { schema: 'main', name: 'items' }
  try {
    const preview = await service.request({
      kind: 'preview-create-index',
      table,
      name: 'planned',
      columns: [{ name: 'title', descending: false }],
      unique: false,
    })
    if (preview.kind !== 'schema-preview') throw Error()
    db.exec('CREATE INDEX concurrent ON items(title)')
    await expect(service.request({ kind: 'commit', token: preview.token })).rejects.toThrow(
      '结构已变化',
    )
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='planned'").get()).toBeUndefined()
    await expect(
      service.request({
        kind: 'preview-create-index',
        table: { schema: 'main', name: 'visible' },
        name: 'view_index',
        columns: [{ name: 'title', descending: false }],
        unique: false,
      }),
    ).rejects.toThrow('不支持')
  } finally {
    db.close()
  }
})

it('previews add/rename/drop column with literal defaults and rejects injected types', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(1)')
  const service = new SchemaTools('sqlite', async (sql, parameters = []) =>
      runSqlite(db, sql, 1000, parameters),
    ),
    table = { schema: 'main', name: 'items' }
  try {
    const plan = await service.request({
      kind: 'preview-add-column',
      table,
      name: 'odd"name',
      type: 'TEXT',
      nullable: false,
      default: { kind: 'value', value: "O'Reilly; --" },
    } as never)
    if (plan.kind !== 'schema-preview') throw Error()
    expect(db.prepare('PRAGMA table_info(items)').all()).toHaveLength(1)
    await service.request({ kind: 'commit', token: plan.token })
    expect(db.prepare('SELECT * FROM items').all()[0]!['odd"name']).toBe("O'Reilly; --")
    const rename = await service.request({
      kind: 'preview-rename-column',
      table,
      column: 'odd"name',
      name: 'renamed',
    } as never)
    if (rename.kind !== 'schema-preview') throw Error()
    await service.request({ kind: 'commit', token: rename.token })
    expect(db.prepare('SELECT renamed FROM items').get()!.renamed).toBe("O'Reilly; --")
    const drop = await service.request({
      kind: 'preview-drop-column',
      table,
      name: 'renamed',
    } as never)
    if (drop.kind !== 'schema-preview') throw Error()
    await service.request({ kind: 'commit', token: drop.token })
    expect(db.prepare('PRAGMA table_info(items)').all()).toHaveLength(1)
    await expect(
      service.request({
        kind: 'preview-add-column',
        table,
        name: 'bad',
        type: 'TEXT);DROP TABLE items;--',
        nullable: true,
      } as never),
    ).rejects.toThrow()
    await expect(
      service.request({
        kind: 'preview-add-column',
        table: { schema: 'main', name: 'nope' },
        name: 'bad',
        type: 'TEXT',
        nullable: true,
      } as never),
    ).rejects.toThrow()
  } finally {
    db.close()
  }
})
it('integrates SQLite field edits through a real rebuild and preserves existing values', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT);INSERT INTO items VALUES(1,'42')")
  const service = new SchemaTools('sqlite', async (sql, parameters = []) =>
      runSqlite(db, sql, 1000, parameters),
    ),
    table = { schema: 'main', name: 'items' }
  try {
    for (const change of [
      { kind: 'preview-column-default', default: { kind: 'value', value: '7' } },
      { kind: 'preview-column-type', type: 'INTEGER', convert: true },
      { kind: 'preview-column-nullable', nullable: false },
    ]) {
      const plan = await service.request({ ...change, table, name: 'title' } as never)
      if (plan.kind !== 'schema-preview') throw Error()
      expect(plan.sql).toContain('BEGIN IMMEDIATE')
      await service.request({ kind: 'commit', token: plan.token })
    }
    expect(db.prepare('SELECT title FROM items').get()!.title).toBe(42)
    expect(db.prepare('PRAGMA table_info(items)').all()[1]!.notnull).toBe(1)
  } finally {
    db.close()
  }
})
