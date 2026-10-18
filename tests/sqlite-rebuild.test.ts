import { it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { runSqlite } from '../src/main/sqlite'
import { SqliteRebuildService } from '../src/main/sqlite-rebuild'
it('rebuilds a field default retaining exact rows, indexes, triggers, views, foreign keys and sequence', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    `PRAGMA foreign_keys=ON;CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT COLLATE NOCASE DEFAULT 'old',payload BLOB);CREATE TABLE child(id INTEGER REFERENCES items(id) ON DELETE CASCADE);CREATE INDEX title_idx ON items(title DESC) WHERE title IS NOT NULL;CREATE TABLE audit(message TEXT);CREATE TRIGGER audit_item AFTER INSERT ON items BEGIN INSERT INTO audit VALUES(NEW.title); END;CREATE VIEW item_view AS SELECT id,title FROM items;INSERT INTO items(id,title,payload)VALUES(9007199254740993,'Keep',X'00FF');INSERT INTO child VALUES(9007199254740993);UPDATE sqlite_sequence SET seq=9007199254740998 WHERE name='items'`,
  )
  const service = new SqliteRebuildService(async (sql, parameters = []) =>
      runSqlite(db, sql, 1000, parameters),
    ),
    table = { schema: 'main', name: 'items' }
  try {
    const plan = await service.preview(table, {
      kind: 'default',
      column: 'title',
      defaultSql: "'next''value'",
    })
    expect(db.prepare('PRAGMA table_info(items)').all()[1]!.dflt_value).toBe("'old'")
    await service.commit(plan.token)
    expect(db.prepare('SELECT title,hex(payload) AS payload FROM items').get()).toMatchObject({
      title: 'Keep',
      payload: '00FF',
    })
    expect(db.prepare('SELECT count(*) AS n FROM child').get()!.n).toBe(1)
    expect(db.prepare('SELECT count(*) AS n FROM audit').get()!.n).toBe(1)
    expect(db.prepare('SELECT title FROM item_view').get()!.title).toBe('Keep')
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='title_idx'").get()).toBeTruthy()
    expect(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1)
    expect(db.prepare('PRAGMA legacy_alter_table').get()!.legacy_alter_table).toBe(0)
    const stmt = db.prepare('INSERT INTO items DEFAULT VALUES')
    stmt.setReadBigInts(true)
    expect(stmt.run().lastInsertRowid).toBe(9007199254740999n)
    expect(db.prepare('SELECT message FROM audit ORDER BY rowid DESC LIMIT 1').get()!.message).toBe(
      "next'value",
    )
  } finally {
    db.close()
  }
})
it('rolls back NULL failures, stale previews and affinity conversions not explicitly allowed', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    "CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT);INSERT INTO items VALUES(1,NULL),(2,'001')",
  )
  const service = new SqliteRebuildService(async (sql, parameters = []) =>
      runSqlite(db, sql, 1000, parameters),
    ),
    table = { schema: 'main', name: 'items' }
  try {
    const bad = await service.preview(table, { kind: 'nullable', column: 'title', nullable: false })
    await expect(service.commit(bad.token)).rejects.toThrow()
    expect(db.prepare('SELECT count(*) AS n FROM items').get()!.n).toBe(2)
    const type = await service.preview(table, {
      kind: 'type',
      column: 'title',
      type: 'INTEGER',
      convert: false,
    })
    await expect(service.commit(type.token)).rejects.toThrow('转换')
    expect(db.prepare('SELECT title FROM items WHERE id=2').get()!.title).toBe('001')
    const explicit = await service.preview(table, {
      kind: 'type',
      column: 'title',
      type: 'INTEGER',
      convert: true,
    })
    await service.commit(explicit.token)
    expect(db.prepare('SELECT title FROM items WHERE id=2').get()!.title).toBe(1)
    const stale = await service.preview(table, {
      kind: 'default',
      column: 'title',
      defaultSql: '2',
    })
    db.exec('CREATE INDEX concurrent ON items(title)')
    await expect(service.commit(stale.token)).rejects.toThrow('结构')
    db.exec('BEGIN;INSERT INTO items VALUES(3,3)')
    const active = await service.preview(table, {
      kind: 'default',
      column: 'title',
      defaultSql: '4',
    })
    await expect(service.commit(active.token)).rejects.toThrow()
    expect(db.isTransaction).toBe(true)
    db.exec('ROLLBACK')
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '__vork_rebuild_%'").all(),
    ).toEqual([])
  } finally {
    db.close()
  }
})
it('retains WITHOUT ROWID, STRICT, generated values, named constraints and conflict clauses', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    `CREATE TABLE items(a TEXT PRIMARY KEY,b INTEGER CONSTRAINT nn NOT NULL ON CONFLICT FAIL CONSTRAINT df DEFAULT (1+2),c TEXT GENERATED ALWAYS AS(a||b) STORED) WITHOUT ROWID,STRICT;INSERT INTO items(a)VALUES('key')`,
  )
  const service = new SqliteRebuildService(async (sql, parameters = []) =>
      runSqlite(db, sql, 1000, parameters),
    ),
    table = { schema: 'main', name: 'items' }
  try {
    for (const change of [
      { kind: 'nullable', column: 'b', nullable: true },
      { kind: 'default', column: 'b', defaultSql: '7' },
      { kind: 'default', column: 'b' },
    ] as const) {
      const plan = await service.preview(table, change)
      await service.commit(plan.token)
    }
    expect(db.prepare('SELECT * FROM items').get()).toMatchObject({ a: 'key', b: 3, c: 'key3' })
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='items'").get()!.sql as string
    expect(sql).toMatch(/WITHOUT ROWID,STRICT/)
    expect(sql).not.toContain('CONSTRAINT nn')
    expect(sql).not.toContain('CONSTRAINT df')
    db.exec("INSERT INTO items(a)VALUES('second')")
    expect(db.prepare("SELECT b FROM items WHERE a='second'").get()!.b).toBeNull()
  } finally {
    db.close()
  }
})
it('rebuilds attached tables with shadowed rowid and recreates objects in the correct schema', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    `ATTACH ':memory:' AS other;CREATE TABLE other.items(rowid TEXT,value TEXT DEFAULT 'old');CREATE TABLE other.audit(value TEXT);CREATE INDEX other.idx ON items(value);CREATE TRIGGER other.tr AFTER INSERT ON items BEGIN INSERT INTO audit VALUES(NEW.value);END;INSERT INTO other.items(_rowid_,rowid,value)VALUES(99,'visible','keep')`,
  )
  const service = new SqliteRebuildService(async (sql, parameters = []) =>
      runSqlite(db, sql, 1000, parameters),
    ),
    table = { schema: 'other', name: 'items' }
  try {
    const plan = await service.preview(table, {
      kind: 'default',
      column: 'value',
      defaultSql: "'new'",
    })
    await service.commit(plan.token)
    expect(
      db.prepare('SELECT _rowid_ AS physical_id,rowid,value FROM other.items').get(),
    ).toMatchObject({
      physical_id: 99,
      rowid: 'visible',
      value: 'keep',
    })
    db.exec("INSERT INTO other.items(rowid)VALUES('next')")
    expect(
      db.prepare('SELECT value FROM other.audit ORDER BY rowid DESC LIMIT 1').get()!.value,
    ).toBe('new')
    expect(
      db.prepare("SELECT name FROM main.sqlite_schema WHERE name IN('idx','tr')").all(),
    ).toEqual([])
  } finally {
    db.close()
  }
})
it('rolls back even after table replacement if an object cannot be recreated', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    `CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT DEFAULT 'old');INSERT INTO items VALUES(1,'keep');CREATE TRIGGER original AFTER INSERT ON items BEGIN SELECT 1;END`,
  )
  const service = new SqliteRebuildService(async (sql, parameters = []) => {
    if (/^CREATE TRIGGER/.test(sql)) throw Error('injected recreate failure')
    return runSqlite(db, sql, 1000, parameters)
  })
  try {
    const before = db.prepare('SELECT sql FROM sqlite_schema ORDER BY name').all(),
      plan = await service.preview(
        { schema: 'main', name: 'items' },
        { kind: 'default', column: 'title', defaultSql: "'new'" },
      )
    await expect(service.commit(plan.token)).rejects.toThrow('injected')
    expect(db.prepare('SELECT sql FROM sqlite_schema ORDER BY name').all()).toEqual(before)
    expect(db.prepare('SELECT title FROM items').get()!.title).toBe('keep')
    expect(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1)
    expect(db.isTransaction).toBe(false)
  } finally {
    db.close()
  }
})
it('preserves empty AUTOINCREMENT high watermarks and does not invalidate previews on data-only changes', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    "CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT DEFAULT 'old');INSERT INTO items(id)VALUES(500);DELETE FROM items",
  )
  const service = new SqliteRebuildService(async (sql, parameters = []) =>
      runSqlite(db, sql, 1000, parameters),
    ),
    table = { schema: 'main', name: 'items' }
  try {
    let plan = await service.preview(table, {
      kind: 'default',
      column: 'value',
      defaultSql: "'new'",
    })
    await service.commit(plan.token)
    expect(db.prepare('INSERT INTO items DEFAULT VALUES').run().lastInsertRowid).toBe(501)
    plan = await service.preview(table, { kind: 'nullable', column: 'value', nullable: false })
    db.exec("INSERT INTO items(value)VALUES('concurrent')")
    await service.commit(plan.token)
    expect(
      db
        .prepare('SELECT value FROM items ORDER BY id')
        .all()
        .map((row) => row.value),
    ).toEqual(['new', 'concurrent'])
  } finally {
    db.close()
  }
})
it('checks incoming and self foreign keys without firing cascade deletion during replacement', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    `CREATE TABLE items(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES items(id) ON DELETE CASCADE,value TEXT DEFAULT 'old');INSERT INTO items VALUES(1,1,'one'),(2,1,'two');CREATE TABLE child(parent INTEGER REFERENCES items(id) ON DELETE CASCADE);INSERT INTO child VALUES(2)`,
  )
  const service = new SqliteRebuildService(async (sql, parameters = []) =>
    runSqlite(db, sql, 1000, parameters),
  )
  try {
    const plan = await service.preview(
      { schema: 'main', name: 'items' },
      { kind: 'default', column: 'value', defaultSql: "'new'" },
    )
    await service.commit(plan.token)
    expect(db.prepare('SELECT count(*) AS n FROM items').get()!.n).toBe(2)
    expect(db.prepare('SELECT count(*) AS n FROM child').get()!.n).toBe(1)
    db.exec('DELETE FROM items WHERE id=1')
    expect(db.prepare('SELECT count(*) AS n FROM child').get()!.n).toBe(0)
  } finally {
    db.close()
  }
})
it('rolls back a conversion that would break another table foreign key', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    "CREATE TABLE items(id TEXT PRIMARY KEY);CREATE TABLE child(parent TEXT REFERENCES items(id));INSERT INTO items VALUES('abc');INSERT INTO child VALUES('abc')",
  )
  const service = new SqliteRebuildService(async (sql, parameters = []) =>
    runSqlite(db, sql, 1000, parameters),
  )
  try {
    const plan = await service.preview(
      { schema: 'main', name: 'items' },
      { kind: 'type', column: 'id', type: 'NUMERIC', convert: true },
    )
    await expect(service.commit(plan.token)).rejects.toThrow('外键')
    expect(db.prepare('SELECT id FROM items').get()!.id).toBe('abc')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    db.close()
  }
})
it('handles a constraint that automatically rolls back the rebuild transaction', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    "CREATE TABLE items(value TEXT UNIQUE ON CONFLICT ROLLBACK);INSERT INTO items VALUES('01'),('1')",
  )
  const service = new SqliteRebuildService(async (sql, parameters = []) =>
    runSqlite(db, sql, 1000, parameters),
  )
  try {
    const plan = await service.preview(
      { schema: 'main', name: 'items' },
      { kind: 'type', column: 'value', type: 'INTEGER', convert: true },
    )
    await expect(service.commit(plan.token)).rejects.toThrow(/UNIQUE/)
    expect(
      db
        .prepare('SELECT value FROM items ORDER BY rowid')
        .all()
        .map((row) => row.value),
    ).toEqual(['01', '1'])
    expect(db.isTransaction).toBe(false)
    expect(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1)
  } finally {
    db.close()
  }
})
it('does not rebuild virtual-table shadow storage', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(content);INSERT INTO docs VALUES('search me')")
  const service = new SqliteRebuildService(async (sql, parameters = []) =>
    runSqlite(db, sql, 1000, parameters),
  )
  try {
    await expect(
      service.preview(
        { schema: 'main', name: 'docs_data' },
        { kind: 'default', column: 'block', defaultSql: 'NULL' },
      ),
    ).rejects.toThrow('影子')
    expect(db.prepare("SELECT content FROM docs WHERE docs MATCH 'search'").get()!.content).toBe(
      'search me',
    )
  } finally {
    db.close()
  }
})
