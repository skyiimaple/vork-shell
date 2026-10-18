import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { openDatabase } from '../src/main/adapters'
import type { DataTable } from '../src/shared/contracts'
import { TableDataService } from '../src/main/table-data'
async function exerciseRows(service: TableDataService, table: DataTable) {
  const preview = await service.request({
    kind: 'preview-insert',
    table,
    values: [
      { column: 'id', value: 3 },
      { column: 'title', value: "insert ' ; --" },
    ],
  })
  if (preview.kind !== 'mutation-preview') throw Error()
  await service.request({ kind: 'commit', token: preview.token })
  let page = await service.request({ kind: 'browse', table, page: 0, pageSize: 20 })
  if (page.kind !== 'page') throw Error()
  const filtered = await service.request({
    kind: 'browse',
    table,
    page: 0,
    pageSize: 20,
    match: 'all',
    filters: [
      { column: 'id', operator: 'gte', value: 3 },
      { column: 'title', operator: 'starts-with', value: 'insert' },
    ],
  })
  if (filtered.kind !== 'page') throw Error()
  expect(filtered.result.rows.map((row) => row[0])).toEqual([3])
  const either = await service.request({
    kind: 'browse',
    table,
    page: 0,
    pageSize: 20,
    match: 'any',
    filters: [
      { column: 'id', operator: 'eq', value: 1 },
      { column: 'id', operator: 'eq', value: 3 },
    ],
  })
  if (either.kind !== 'page') throw Error()
  expect(either.result.rows.map((row) => row[0])).toEqual([1, 3])
  page = await service.request({ kind: 'browse', table, page: 0, pageSize: 20 })
  if (page.kind !== 'page') throw Error()
  const index = page.result.rows.findIndex((row) => row[0] === 3)
  expect(page.result.rows[index]?.[1]).toBe("insert ' ; --")
  const removal = await service.request({
    kind: 'preview-delete',
    snapshotId: page.snapshotId!,
    rowIndex: index,
  })
  if (removal.kind !== 'mutation-preview') throw Error()
  await service.request({ kind: 'commit', token: removal.token })
  let remaining = await service.request({ kind: 'browse', table, page: 0, pageSize: 20 })
  if (remaining.kind !== 'page') throw Error()
  expect(remaining.result.rows.some((row) => row[0] === 3)).toBe(false)
  const update = await service.request({
    kind: 'preview-update-many',
    snapshotId: remaining.snapshotId!,
    rowIndices: [0, 1],
    column: 'title',
    value: "batch quote ' ; --",
  })
  if (update.kind !== 'mutation-preview') throw Error()
  expect(await service.request({ kind: 'commit', token: update.token })).toEqual({
    kind: 'edited',
    affectedRows: 2,
    requestedRows: 2,
  })
  for (const value of ["batch quote ' ; --", null]) {
    remaining = await service.request({ kind: 'browse', table, page: 0, pageSize: 20 })
    if (remaining.kind !== 'page') throw Error()
    expect(remaining.result.rows.map((row) => row[1])).toEqual([
      "batch quote ' ; --",
      "batch quote ' ; --",
    ])
    const repeat = await service.request({
      kind: 'preview-update-many',
      snapshotId: remaining.snapshotId!,
      rowIndices: [0, 1],
      column: 'title',
      value,
    })
    if (repeat.kind !== 'mutation-preview') throw Error()
    expect(await service.request({ kind: 'commit', token: repeat.token })).toEqual({
      kind: 'edited',
      affectedRows: 2,
      requestedRows: 2,
    })
  }
  remaining = await service.request({ kind: 'browse', table, page: 0, pageSize: 20 })
  if (remaining.kind !== 'page') throw Error()
  expect(remaining.result.rows.map((row) => row[1])).toEqual([null, null])
  const batch = await service.request({
    kind: 'preview-delete-many',
    snapshotId: remaining.snapshotId!,
    rowIndices: remaining.result.rows.map((_, index) => index),
  })
  if (batch.kind !== 'mutation-preview') throw Error()
  const deleted = await service.request({ kind: 'commit', token: batch.token })
  expect(deleted).toEqual({
    kind: 'edited',
    affectedRows: remaining.result.rows.length,
    requestedRows: remaining.result.rows.length,
  })
  const empty = await service.request({ kind: 'browse', table, page: 0, pageSize: 20 })
  if (empty.kind !== 'page') throw Error()
  expect(empty.result.rows).toEqual([])
}
// These variables refer to dedicated disposable test databases, never saved user profiles.
it.runIf(Boolean(process.env.VORK_POSTGRES_PORT))(
  'manages PostgreSQL table data and rejects inherited parent edits on a real service',
  async () => {
    const adapter = await openDatabase(
      {
        type: 'postgresql',
        name: 'table test',
        host: '127.0.0.1',
        port: Number(process.env.VORK_POSTGRES_PORT),
        username: 'vork',
        password: process.env.VORK_POSTGRES_PASSWORD || 'vork_test_only',
        database: 'vork_test',
      },
      () => {},
    )
    const schema = 'vork_' + randomUUID().replaceAll('-', '')
    try {
      await adapter.execute(`CREATE SCHEMA "${schema}"`)
      await adapter.execute(
        `CREATE TABLE "${schema}".items(id integer PRIMARY KEY,title text); INSERT INTO "${schema}".items VALUES(1,'one'),(2,'two')`,
      )
      const service = new TableDataService('postgresql', (sql, parameters) =>
        adapter.execute(sql, parameters),
      )
      const page = await service.request({
        kind: 'browse',
        table: { schema, name: 'items' },
        page: 0,
        pageSize: 1,
        sort: { column: 'id', descending: true },
      })
      if (page.kind !== 'page') throw Error()
      expect(page.hasNext).toBe(true)
      expect(page.result.rows).toEqual([[2, 'two']])
      await service.request({
        kind: 'edit',
        snapshotId: page.snapshotId!,
        rowIndex: 0,
        column: 'title',
        value: "quote ' ; --",
      })
      expect(
        (await adapter.execute(`SELECT title FROM "${schema}".items WHERE id=2`)).rows,
      ).toEqual([["quote ' ; --"]])
      await exerciseRows(service, { schema, name: 'items' })
      await adapter.execute(
        `CREATE TABLE "${schema}".parent(id integer PRIMARY KEY,title text); CREATE TABLE "${schema}".child() INHERITS("${schema}".parent); INSERT INTO "${schema}".parent VALUES(1,'same'); INSERT INTO "${schema}".child VALUES(1,'same')`,
      )
      const inherited = await service.request({
        kind: 'browse',
        table: { schema, name: 'parent' },
        page: 0,
        pageSize: 20,
      })
      if (inherited.kind !== 'page') throw Error()
      expect(inherited.result.rows).toHaveLength(2)
      expect(inherited.snapshotId).toBeUndefined()
    } finally {
      try {
        await adapter.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      } finally {
        await adapter.close()
      }
    }
  },
)
it.runIf(Boolean(process.env.VORK_MYSQL_PORT))(
  'manages MySQL data with parameter bindings and case-sensitive conflict checking on a real service',
  async () => {
    const adapter = await openDatabase(
      {
        type: 'mysql',
        name: 'table test',
        host: '127.0.0.1',
        port: Number(process.env.VORK_MYSQL_PORT),
        username: 'vork',
        password: process.env.VORK_MYSQL_PASSWORD || 'vork_test_only',
        database: 'vork_test',
      },
      () => {},
    )
    const name = 'vork_' + randomUUID().replaceAll('-', ''),
      table = { schema: 'vork_test', name }
    try {
      await adapter.execute(
        `CREATE TABLE \`${name}\`(id integer PRIMARY KEY,title varchar(100) COLLATE utf8mb4_general_ci) DEFAULT CHARSET=utf8mb4`,
      )
      await adapter.execute(`INSERT INTO \`${name}\` VALUES(1,'hello'),(2,'other')`)
      const service = new TableDataService('mysql', (sql, parameters) =>
        adapter.execute(sql, parameters),
      )
      const page = await service.request({ kind: 'browse', table, page: 0, pageSize: 20 })
      if (page.kind !== 'page') throw Error()
      await adapter.execute(`UPDATE \`${name}\` SET title='HELLO' WHERE id=1`)
      await expect(
        service.request({
          kind: 'edit',
          snapshotId: page.snapshotId!,
          rowIndex: 0,
          column: 'title',
          value: 'wrong',
        }),
      ).rejects.toThrow(/冲突/)
      const fresh = await service.request({
        kind: 'browse',
        table,
        page: 0,
        pageSize: 1,
        filter: { column: 'title', operator: 'contains', value: 'other' },
      })
      if (fresh.kind !== 'page') throw Error()
      expect(fresh.result.rows).toEqual([[2, 'other']])
      await service.request({
        kind: 'edit',
        snapshotId: fresh.snapshotId!,
        rowIndex: 0,
        column: 'title',
        value: "quote ' ; --",
      })
      expect((await adapter.execute(`SELECT title FROM \`${name}\` WHERE id=2`)).rows).toEqual([
        ["quote ' ; --"],
      ])
      await exerciseRows(service, table)
    } finally {
      try {
        await adapter.execute(`DROP TABLE IF EXISTS \`${name}\``)
      } finally {
        await adapter.close()
      }
    }
  },
)
