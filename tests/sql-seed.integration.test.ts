import { expect, it } from 'vitest'
import { openDatabase } from '../src/main/adapters'
import { TableDataService } from '../src/main/table-data'

const password = 'vork_test_only'

it.runIf(Boolean(process.env.VORK_MYSQL_PORT))(
  'seeds MySQL users and reads them back through the app driver',
  async () => {
    const adapter = await openDatabase(
      {
        type: 'mysql',
        name: 'seed',
        host: '127.0.0.1',
        port: Number(process.env.VORK_MYSQL_PORT),
        username: 'vork',
        password: process.env.VORK_MYSQL_PASSWORD || password,
        database: 'vork_test',
      },
      () => {},
    )
    try {
      await adapter.execute('TRUNCATE TABLE users')
      await adapter.execute(
        `INSERT INTO users (username, email, created_at) VALUES
          ('ada','ada@example.com','2026-10-01 09:00:00'),
          ('grace','grace@example.com','2026-10-02 09:00:00'),
          ('linfeng','林枫@example.com','2026-10-03 09:00:00'),
          ('quote','o''brien@example.com','2026-10-04 09:00:00'),
          ('semi','a;b@example.com','2026-10-05 09:00:00')`,
      )
      const rows = await adapter.execute('SELECT id, username, email FROM users ORDER BY id')
      expect(rows.rows.map((row) => [row[1], row[2]])).toEqual([
        ['ada', 'ada@example.com'],
        ['grace', 'grace@example.com'],
        ['linfeng', '林枫@example.com'],
        ['quote', "o'brien@example.com"],
        ['semi', 'a;b@example.com'],
      ])
      const service = new TableDataService('mysql', (sql, parameters) =>
        adapter.execute(sql, parameters),
      )
      const page = await service.request({
        kind: 'browse',
        table: { schema: 'vork_test', name: 'users' },
        page: 0,
        pageSize: 2,
        sort: { column: 'id', descending: true },
      })
      if (page.kind !== 'page') throw new Error('MySQL 分页没有返回数据页')
      expect(page.hasNext).toBe(true)
      expect(page.result.rows.map((row) => row[1])).toEqual(['semi', 'quote'])
      const filtered = await service.request({
        kind: 'browse',
        table: { schema: 'vork_test', name: 'users' },
        page: 0,
        pageSize: 20,
        filter: { column: 'email', operator: 'contains', value: '林枫' },
      })
      if (filtered.kind !== 'page') throw new Error('MySQL 筛选没有返回数据页')
      expect(filtered.result.rows.map((row) => row[1])).toEqual(['linfeng'])
    } finally {
      await adapter.close()
    }
  },
)

it.runIf(Boolean(process.env.VORK_POSTGRES_PORT))(
  'seeds PostgreSQL users and reads them back through the app driver',
  async () => {
    const adapter = await openDatabase(
      {
        type: 'postgresql',
        name: 'seed',
        host: '127.0.0.1',
        port: Number(process.env.VORK_POSTGRES_PORT),
        username: 'vork',
        password: process.env.VORK_POSTGRES_PASSWORD || password,
        database: 'vork_test',
      },
      () => {},
    )
    try {
      await adapter.execute('TRUNCATE TABLE users')
      await adapter.execute(
        `INSERT INTO users (id, name) VALUES
          (1,'ada'),
          (2,'grace'),
          (3,'林枫'),
          (4,'quote '' ; --'),
          (5,NULL)`,
      )
      const rows = await adapter.execute('SELECT id, name FROM users ORDER BY id')
      expect(rows.rows).toEqual([
        [1, 'ada'],
        [2, 'grace'],
        [3, '林枫'],
        [4, "quote ' ; --"],
        [5, null],
      ])
      const service = new TableDataService('postgresql', (sql, parameters) =>
        adapter.execute(sql, parameters),
      )
      const page = await service.request({
        kind: 'browse',
        table: { schema: 'public', name: 'users' },
        page: 0,
        pageSize: 2,
        sort: { column: 'id', descending: true },
      })
      if (page.kind !== 'page') throw new Error('PostgreSQL 分页没有返回数据页')
      expect(page.hasNext).toBe(true)
      expect(page.result.rows).toEqual([
        [5, null],
        [4, "quote ' ; --"],
      ])
      const filtered = await service.request({
        kind: 'browse',
        table: { schema: 'public', name: 'users' },
        page: 0,
        pageSize: 20,
        filter: { column: 'name', operator: 'contains', value: '林' },
      })
      if (filtered.kind !== 'page') throw new Error('PostgreSQL 筛选没有返回数据页')
      expect(filtered.result.rows).toEqual([[3, '林枫']])
      await service.request({
        kind: 'edit',
        snapshotId: filtered.snapshotId!,
        rowIndex: 0,
        column: 'name',
        value: '林枫-已核对',
      })
      expect((await adapter.execute('SELECT name FROM users WHERE id=3')).rows).toEqual([
        ['林枫-已核对'],
      ])
      await adapter.execute("UPDATE users SET name='林枫' WHERE id=3")
    } finally {
      await adapter.close()
    }
  },
)
