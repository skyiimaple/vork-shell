import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { openDatabase } from '../src/main/adapters'
import { TableDataService } from '../src/main/table-data'
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
    } finally {
      try {
        await adapter.execute(`DROP TABLE IF EXISTS \`${name}\``)
      } finally {
        await adapter.close()
      }
    }
  },
)
