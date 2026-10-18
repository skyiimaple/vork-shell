import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runSqlite } from '../src/main/sqlite'
import { TableDataService } from '../src/main/table-data'
const databases: DatabaseSync[] = []
function setup(
  sql = "CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT, score INTEGER); INSERT INTO items VALUES(1,'one',10),(2,'two',20),(3,'three',30)",
) {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec(sql)
  const service = new TableDataService('sqlite', async (sql, parameters = []) =>
    runSqlite(db, sql, 1000, parameters),
  )
  return { db, service }
}
const request = {
  kind: 'browse' as const,
  table: { schema: 'main', name: 'items' },
  page: 0,
  pageSize: 20,
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
describe('database table data', () => {
  it('reads bounded server pages with stable primary-key order and literal filters', async () => {
    const { service } = setup()
    const first = await service.request({ ...request, pageSize: 2 })
    expect(first.kind).toBe('page')
    if (first.kind !== 'page') throw Error()
    expect(first.result.rows.map((row) => row[0])).toEqual([1, 2])
    expect(first.hasNext).toBe(true)
    const second = await service.request({ ...request, pageSize: 2, page: 1 })
    if (second.kind !== 'page') throw Error()
    expect(second.result.rows.map((row) => row[0])).toEqual([3])
    expect(second.hasNext).toBe(false)
    const sorted = await service.request({
      ...request,
      sort: { column: 'score', descending: true },
    })
    if (sorted.kind !== 'page') throw Error()
    expect(sorted.result.rows[0]?.[0]).toBe(3)
    const filtered = await service.request({
      ...request,
      filter: { column: 'title', operator: 'contains', value: 'wo' },
    })
    if (filtered.kind !== 'page') throw Error()
    expect(filtered.result.rows.map((row) => row[0])).toEqual([2])
    await expect(
      service.request({ ...request, sort: { column: 'missing', descending: false } }),
    ).rejects.toThrow()
    await expect(service.request({ ...request, page: -1 })).rejects.toThrow()
  })
  it('edits exactly one cell with a server snapshot and detects external changes', async () => {
    const { db, service } = setup()
    const page = await service.request(request)
    if (page.kind !== 'page') throw Error()
    expect(page.columns.find((c) => c.name === 'id')?.editable).toBe(false)
    await expect(
      service.request({
        kind: 'edit',
        snapshotId: page.snapshotId!,
        rowIndex: 0,
        column: 'id',
        value: 4,
      }),
    ).rejects.toThrow()
    db.exec("UPDATE items SET title='external' WHERE id=1")
    await expect(
      service.request({
        kind: 'edit',
        snapshotId: page.snapshotId!,
        rowIndex: 0,
        column: 'title',
        value: 'overwrite',
      }),
    ).rejects.toThrow(/修改|冲突/)
    const fresh = await service.request(request)
    if (fresh.kind !== 'page') throw Error()
    const text = "quoted ' ; DROP TABLE items; --"
    expect(
      await service.request({
        kind: 'edit',
        snapshotId: fresh.snapshotId!,
        rowIndex: 1,
        column: 'title',
        value: text,
      }),
    ).toEqual({ kind: 'edited', affectedRows: 1 })
    expect(db.prepare('SELECT title FROM items WHERE id=2').get()?.title).toBe(text)
    await expect(
      service.request({
        kind: 'edit',
        snapshotId: fresh.snapshotId!,
        rowIndex: 1,
        column: 'title',
        value: 'again',
      }),
    ).rejects.toThrow(/快照/)
  })
  it('keeps views, unkeyed tables, binary and generated columns read-only', async () => {
    const { service } = setup(
      "CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT, bytes BLOB, upper_title TEXT GENERATED ALWAYS AS (upper(title))); INSERT INTO items(id,title,bytes) VALUES(1,'a',x'01'); CREATE VIEW v AS SELECT * FROM items; CREATE TABLE unkeyed(title TEXT)",
    )
    const page = await service.request(request)
    if (page.kind !== 'page') throw Error()
    expect(page.columns.filter((c) => c.editable).map((c) => c.name)).toEqual(['title'])
    for (const name of ['v', 'unkeyed']) {
      const value = await service.request({ ...request, table: { schema: 'main', name } })
      if (value.kind !== 'page') throw Error()
      expect(value.snapshotId).toBeUndefined()
    }
  })
  it('quotes special identifiers, handles composite keys and NULL old values', async () => {
    const { db, service } = setup(
      'CREATE TABLE "odd""table"("a""key" TEXT NOT NULL,b INTEGER NOT NULL,title TEXT,PRIMARY KEY("a""key",b)); INSERT INTO "odd""table" VALUES(\'x\',1,NULL),(\'x\',2,\'keep\')',
    )
    const page = await service.request({ ...request, table: { schema: 'main', name: 'odd"table' } })
    if (page.kind !== 'page') throw Error()
    await service.request({
      kind: 'edit',
      snapshotId: page.snapshotId!,
      rowIndex: 0,
      column: 'title',
      value: 'new',
    })
    expect(
      db
        .prepare('SELECT title FROM "odd""table" ORDER BY b')
        .all()
        .map((row) => row.title),
    ).toEqual(['new', 'keep'])
  })
})

it('does not alias binary SQLite primary keys to displayed text keys', async () => {
  const { db, service } = setup(
    "CREATE TABLE items(id TEXT PRIMARY KEY,title TEXT); INSERT INTO items VALUES('0xff','text'),(x'ff','blob')",
  )
  const page = await service.request(request)
  if (page.kind !== 'page') throw Error()
  expect(page.snapshotId).toBeUndefined()
  expect(page.readOnlyReason).toMatch(/二进制/)
  expect(db.prepare("SELECT title FROM items WHERE typeof(id)='text'").get()?.title).toBe('text')
})
it('detects case-only external changes despite SQLite NOCASE collation', async () => {
  const { db, service } = setup(
    "CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT COLLATE NOCASE); INSERT INTO items VALUES(1,'hello')",
  )
  const page = await service.request(request)
  if (page.kind !== 'page') throw Error()
  db.exec("UPDATE items SET title='HELLO' WHERE id=1")
  await expect(
    service.request({
      kind: 'edit',
      snapshotId: page.snapshotId!,
      rowIndex: 0,
      column: 'title',
      value: 'next',
    }),
  ).rejects.toThrow(/冲突/)
})
it.each(['mysql', 'postgresql'] as const)(
  'binds %s page/filter/update values and quotes identifiers',
  async (type) => {
    const calls: { sql: string; parameters: unknown[] }[] = []
    const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
      calls.push({ sql, parameters })
      const rows = sql.startsWith('SELECT table_type')
        ? [['BASE TABLE']]
        : sql.includes('information_schema.columns')
          ? [
              ['id', 'integer', 1, type === 'mysql' ? '' : 'NEVER'],
              ['title', 'text', 0, type === 'mysql' ? '' : 'NEVER'],
            ]
          : sql.startsWith('UPDATE')
            ? []
            : [[1, 'before']]
      return {
        columns: ['id', 'title'],
        rows,
        affectedRows: sql.startsWith('UPDATE') ? 1 : 0,
        elapsedMs: 0,
        truncated: false,
      }
    })
    const service = new TableDataService(type, query)
    const malicious = "' OR 1=1; -- %_!"
    const page = await service.request({
      ...request,
      table: { schema: 'odd"`schema', name: 'items' },
      filter: { column: 'title', operator: 'contains', value: malicious },
    })
    if (page.kind !== 'page') throw Error()
    const select = calls.find((c) => c.sql.includes(' LIMIT '))!
    expect(select.sql).not.toContain(malicious)
    expect(select.parameters[0]).toBe("%' OR 1=1; -- !%!_!!%")
    expect(select.sql).toContain(type === 'postgresql' ? 'LIMIT $2 OFFSET $3' : 'LIMIT 21 OFFSET 0')
    await service.request({
      kind: 'edit',
      snapshotId: page.snapshotId!,
      rowIndex: 0,
      column: 'title',
      value: malicious,
    })
    const update = calls.find((c) => c.sql.startsWith('UPDATE'))!
    expect(update.sql).not.toContain(malicious)
    expect(update.parameters).toEqual([malicious, 1, 'before'])
    expect(update.sql).toContain(type === 'postgresql' ? 'IS NOT DISTINCT FROM' : 'BINARY')
  },
)

it('prevents paging past a byte-truncated result and does not issue edit snapshots', async () => {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  db.exec(
    "CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT); INSERT INTO items VALUES(1,'a'),(2,'b')",
  )
  const service = new TableDataService('sqlite', async (sql, parameters = []) => {
    const result = runSqlite(db, sql, 1000, parameters)
    return sql.includes(' LIMIT ')
      ? { ...result, rows: result.rows.slice(0, 1), truncated: true }
      : result
  })
  const page = await service.request(request)
  if (page.kind !== 'page') throw Error()
  expect(page.hasNext).toBe(false)
  expect(page.snapshotId).toBeUndefined()
})
it('keeps PostgreSQL traditional inheritance parents read-only', async () => {
  const query = vi.fn(async (sql: string) => ({
    columns: [],
    rows: sql.startsWith('SELECT table_type')
      ? [['BASE TABLE']]
      : sql.includes('information_schema.columns')
        ? [
            ['id', 'integer', 1, 'NEVER', true],
            ['title', 'text', 0, 'NEVER', true],
          ]
        : [
            [1, 'same'],
            [1, 'same'],
          ],
    affectedRows: 0,
    elapsedMs: 0,
    truncated: false,
  }))
  const service = new TableDataService('postgresql', query)
  const page = await service.request(request)
  if (page.kind !== 'page') throw Error()
  expect(page.snapshotId).toBeUndefined()
  expect(page.columns.every((c) => !c.editable)).toBe(true)
  await expect(
    service.request({
      kind: 'edit',
      snapshotId: 'forged',
      rowIndex: 0,
      column: 'title',
      value: 'wrong',
    }),
  ).rejects.toThrow()
  expect(query.mock.calls.every(([sql]) => !sql.startsWith('UPDATE'))).toBe(true)
})

it('compares MySQL large integer primary keys as exact binary strings', async () => {
  const calls: { sql: string; parameters: unknown[] }[] = []
  const query = vi.fn(async (sql: string, parameters: unknown[] = []) => {
    calls.push({ sql, parameters })
    return {
      columns: [],
      rows: sql.startsWith('SELECT table_type')
        ? [['BASE TABLE']]
        : sql.includes('information_schema.columns')
          ? [
              ['id', 'bigint', 1, ''],
              ['title', 'text', 0, ''],
            ]
          : sql.startsWith('UPDATE')
            ? []
            : [['9007199254740993', 'same']],
      affectedRows: sql.startsWith('UPDATE') ? 1 : 0,
      elapsedMs: 0,
      truncated: false,
    }
  })
  const service = new TableDataService('mysql', query)
  const page = await service.request(request)
  if (page.kind !== 'page') throw Error()
  await service.request({
    kind: 'edit',
    snapshotId: page.snapshotId!,
    rowIndex: 0,
    column: 'title',
    value: 'changed',
  })
  const update = calls.find((call) => call.sql.startsWith('UPDATE'))!
  expect(update.sql).toContain('BINARY `id` <=> BINARY ?')
  expect(update.parameters).toEqual(['changed', '9007199254740993', 'same'])
})

it('reads unkeyed PostgreSQL JSON-only tables without inventing an unsupported sort', async () => {
  let pageSql = ''
  const service = new TableDataService('postgresql', async (sql) => {
    if (sql.includes(' LIMIT ')) pageSql = sql
    return {
      columns: [],
      rows: sql.startsWith('SELECT table_type')
        ? [['BASE TABLE']]
        : sql.includes('information_schema.columns')
          ? [['document', 'json', 0, 'NEVER', false]]
          : [['{"a":1}']],
      affectedRows: 0,
      elapsedMs: 0,
      truncated: false,
    }
  })
  const page = await service.request(request)
  if (page.kind !== 'page') throw Error()
  expect(page.result.rows).toEqual([['{"a":1}']])
  expect(pageSql).not.toContain('ORDER BY')
  expect(page.snapshotId).toBeUndefined()
})

it('previews and confirms inserts once, preserving defaults and literal values', async () => {
  const { db, service } = setup(
    "CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT DEFAULT 'default', score INTEGER)",
  )
  const preview = await service.request({
    kind: 'preview-insert',
    table: request.table,
    values: [{ column: 'score', value: 9 }],
  })
  if (preview.kind !== 'mutation-preview') throw Error()
  expect(preview.sql).toContain('INSERT INTO "main"."items" ("score") VALUES (?)')
  expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()?.n).toBe(0)
  await service.request({ kind: 'commit', token: preview.token })
  expect(db.prepare('SELECT title,score FROM items').get()).toMatchObject({
    title: 'default',
    score: 9,
  })
  await expect(service.request({ kind: 'commit', token: preview.token })).rejects.toThrow()
})
it('previews exact row deletion and rejects changes after preview', async () => {
  const { db, service } = setup()
  const page = await service.request(request)
  if (page.kind !== 'page') throw Error()
  const preview = await service.request({
    kind: 'preview-delete',
    snapshotId: page.snapshotId!,
    rowIndex: 0,
  })
  if (preview.kind !== 'mutation-preview') throw Error()
  expect(preview.sql).toContain('DELETE FROM')
  db.exec("UPDATE items SET title='concurrent' WHERE id=1")
  await expect(service.request({ kind: 'commit', token: preview.token })).rejects.toThrow('冲突')
  expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()?.n).toBe(3)
  const fresh = await service.request(request)
  if (fresh.kind !== 'page') throw Error()
  const next = await service.request({
    kind: 'preview-delete',
    snapshotId: fresh.snapshotId!,
    rowIndex: 1,
  })
  if (next.kind !== 'mutation-preview') throw Error()
  await service.request({ kind: 'commit', token: next.token })
  expect(
    db
      .prepare('SELECT id FROM items ORDER BY id')
      .all()
      .map((row) => row.id),
  ).toEqual([1, 3])
})

it('rejects generated fields, views, expired previews and schema changes before commit', async () => {
  const { db, service } = setup(
    'CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT,score INTEGER GENERATED ALWAYS AS (length(title)) STORED); CREATE VIEW view_items AS SELECT * FROM items',
  )
  await expect(
    service.request({
      kind: 'preview-insert',
      table: request.table,
      values: [{ column: 'score', value: 5 }],
    }),
  ).rejects.toThrow()
  await expect(
    service.request({
      kind: 'preview-insert',
      table: { schema: 'main', name: 'view_items' },
      values: [],
    }),
  ).rejects.toThrow()
  const preview = await service.request({
    kind: 'preview-insert',
    table: request.table,
    values: [{ column: 'title', value: 'safe' }],
  })
  if (preview.kind !== 'mutation-preview') throw Error()
  db.exec('ALTER TABLE items ADD COLUMN other TEXT')
  await expect(service.request({ kind: 'commit', token: preview.token })).rejects.toThrow('结构')
  expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()?.n).toBe(0)
})

it('combines typed comparisons and literal patterns with AND/OR', async () => {
  const { service } = setup()
  const get = async (filters: unknown[], match = 'all') => {
    const r = await service.request({ ...request, filters, match } as never)
    if (r.kind !== 'page') throw Error()
    return r.result.rows.map((r) => r[0])
  }
  expect(
    await get([
      { column: 'score', operator: 'gte', value: 20 },
      { column: 'title', operator: 'starts-with', value: 't' },
    ]),
  ).toEqual([2, 3])
  expect(
    await get(
      [
        { column: 'score', operator: 'lt', value: 20 },
        { column: 'title', operator: 'ends-with', value: 'ree' },
      ],
      'any',
    ),
  ).toEqual([1, 3])
  expect(await get([{ column: 'title', operator: 'not-contains', value: 'o' }])).toEqual([3])
  await expect(
    get(Array.from({ length: 21 }, () => ({ column: 'id', operator: 'eq', value: 1 }))),
  ).rejects.toThrow()
  await expect(get([{ column: 'id', operator: 'eq', value: {} }])).rejects.toThrow()
})

it('previews bounded batch deletion and reports rows changed since selection accurately', async () => {
  const { db, service } = setup()
  const page = await service.request(request)
  if (page.kind !== 'page') throw Error()
  const preview = await service.request({
    kind: 'preview-delete-many',
    snapshotId: page.snapshotId!,
    rowIndices: [0, 1],
  } as never)
  if (preview.kind !== 'mutation-preview') throw Error()
  expect(preview.parameters).toEqual([1, 'one', 10, 2, 'two', 20])
  expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()!.n).toBe(3)
  db.exec("UPDATE items SET title='changed' WHERE id=2")
  expect(await service.request({ kind: 'commit', token: preview.token })).toEqual({
    kind: 'edited',
    affectedRows: 1,
    requestedRows: 2,
  })
  expect(
    db
      .prepare('SELECT id FROM items ORDER BY id')
      .all()
      .map((row) => row.id),
  ).toEqual([2, 3])
  await expect(service.request({ kind: 'commit', token: preview.token })).rejects.toThrow()
  const next = await service.request(request)
  if (next.kind !== 'page') throw Error()
  for (const rowIndices of [[], [0, 0], [-1], [99]])
    await expect(
      service.request({
        kind: 'preview-delete-many',
        snapshotId: next.snapshotId!,
        rowIndices,
      } as never),
    ).rejects.toThrow()
})

it('previews batch updates, protects keys and skips concurrently changed rows', async () => {
  const { db, service } = setup()
  const page = await service.request(request)
  if (page.kind !== 'page') throw Error()
  const input = {
    kind: 'preview-update-many',
    snapshotId: page.snapshotId!,
    rowIndices: [0, 1],
    column: 'score',
    value: 99,
  } as const
  const plan = await service.request(input as never)
  if (plan.kind !== 'mutation-preview') throw Error()
  expect(plan.sql).toMatch(/^UPDATE/)
  expect(plan.parameters[0]).toBe(99)
  expect(db.prepare('SELECT score FROM items WHERE id=1').get()!.score).toBe(10)
  db.exec("UPDATE items SET title='changed' WHERE id=2")
  expect(await service.request({ kind: 'commit', token: plan.token })).toEqual({
    kind: 'edited',
    affectedRows: 1,
    requestedRows: 2,
  })
  expect(
    db
      .prepare('SELECT score FROM items ORDER BY id')
      .all()
      .map((row) => row.score),
  ).toEqual([99, 20, 30])
  const fresh = await service.request(request)
  if (fresh.kind !== 'page') throw Error()
  await expect(
    service.request({ ...input, snapshotId: fresh.snapshotId!, column: 'id' } as never),
  ).rejects.toThrow()
  const nullPlan = await service.request({
    ...input,
    snapshotId: fresh.snapshotId!,
    rowIndices: [0, 2],
    value: null,
  } as never)
  if (nullPlan.kind !== 'mutation-preview') throw Error()
  await service.request({ kind: 'commit', token: nullPlan.token })
  expect(
    db
      .prepare('SELECT score FROM items ORDER BY id')
      .all()
      .map((row) => row.score),
  ).toEqual([null, 20, null])
})
