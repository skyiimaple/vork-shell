import { it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { runSqlite } from '../src/main/sqlite'
import { readStructureTable, compareStructures } from '../src/main/structure-compare'
it('detects column/index/foreign-key and table differences without modifying either SQLite database', async () => {
  const left = new DatabaseSync(':memory:'),
    right = new DatabaseSync(':memory:')
  left.exec(
    "CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE items(id INTEGER PRIMARY KEY,title VARCHAR(40) NOT NULL DEFAULT 'old',parent_id INTEGER REFERENCES parent(id));CREATE INDEX title_idx ON items(title);CREATE TABLE only_left(id INTEGER)",
  )
  right.exec(
    'CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT,parent_id INTEGER,extra INTEGER);CREATE TABLE only_right(id INTEGER)',
  )
  try {
    const capture = async (db: DatabaseSync, names: string[]) =>
      Promise.all(
        names.map((name) =>
          readStructureTable('sqlite', { schema: 'main', name }, async (sql, parameters = []) =>
            runSqlite(db, sql, 1000, parameters),
          ),
        ),
      )
    const a = await capture(left, ['items', 'only_left']),
      b = await capture(right, ['items', 'only_right'])
    const diff = compareStructures(a, b, 'main', 'main')
    expect(
      diff.some((row) => row.kind === 'column' && row.name === 'title' && row.change === 'changed'),
    ).toBe(true)
    expect(
      diff.some(
        (row) => row.kind === 'column' && row.name === 'extra' && row.change === 'target-only',
      ),
    ).toBe(true)
    expect(
      diff.some(
        (row) => row.kind === 'index' && row.name === 'title_idx' && row.change === 'source-only',
      ),
    ).toBe(true)
    expect(diff.some((row) => row.kind === 'foreign-key')).toBe(true)
    expect(diff.some((row) => row.table === 'only_left' && row.change === 'source-only')).toBe(true)
    expect(diff.some((row) => row.table === 'only_right' && row.change === 'target-only')).toBe(
      true,
    )
    expect(compareStructures(a, a, 'main', 'main')).toEqual([])
    expect(left.prepare('SELECT COUNT(*) AS n FROM items').get()?.n).toBe(0)
  } finally {
    left.close()
    right.close()
  }
})
it('detects index collation differences retained only in the native index definition', async () => {
  const left = new DatabaseSync(':memory:'),
    right = new DatabaseSync(':memory:')
  try {
    for (const db of [left, right]) db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT)')
    left.exec('CREATE INDEX title_idx ON items(title COLLATE NOCASE)')
    right.exec('CREATE INDEX title_idx ON items(title COLLATE BINARY)')
    const capture = (db: DatabaseSync) =>
      readStructureTable(
        'sqlite',
        { schema: 'main', name: 'items' },
        async (sql, parameters = []) => runSqlite(db, sql, 1000, parameters),
      )
    const differences = compareStructures(
      [await capture(left)],
      [await capture(right)],
      'main',
      'main',
    )
    expect(differences.some((row) => row.kind === 'index' && row.name === 'title_idx')).toBe(true)
  } finally {
    left.close()
    right.close()
  }
})
it('cancels only the owning window job and closes temporary sessions on failure', async () => {
  const { StructureCompareService } = await import('../src/main/structure-compare')
  let started!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
      started = resolve
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve
    }),
    closed: string[] = []
  const service = new StructureCompareService({
    open: async (_owner, ref) => ({
      id: ref.id,
      source: { ...ref, name: 'fixture', type: 'sqlite' },
      temporary: true,
    }),
    close: async (_owner, id) => {
      closed.push(id)
    },
    tables: async () => ({ tables: ['items'] }),
    table: async () => {
      started()
      await blocked
      throw new Error('read interrupted')
    },
  })
  const request = {
    id: 'cancel-job',
    source: { kind: 'profile' as const, id: 'left' },
    target: { kind: 'profile' as const, id: 'right' },
    sourceSchema: 'main',
    targetSchema: 'main',
  }
  const job = service.compare(1, request)
  await entered
  expect(service.cancel(2, request.id)).toBe(false)
  expect(service.cancel(1, request.id)).toBe(true)
  release()
  await expect(job).rejects.toThrow('取消')
  expect(closed).toEqual(['left'])
  expect(() => service.report(2, 'unknown')).toThrow('过期')
})
