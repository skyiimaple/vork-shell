import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDatabase } from '../src/main/adapters'
import { explainQuery } from '../src/main/query-plan'
for (const type of ['mysql', 'postgresql'] as const) {
  const port = process.env[type === 'mysql' ? 'VORK_MYSQL_PORT' : 'VORK_POSTGRES_PORT']
  it.runIf(Boolean(port))(
    `${type}: reads real JSON query plans and does not execute INSERT`,
    async () => {
      const adapter = await openDatabase(
        {
          type,
          name: 'plan fixture',
          host: '127.0.0.1',
          port: Number(port),
          username: 'vork',
          password: 'vork_test_only',
          database: 'vork_test',
        },
        () => {},
      )
      const name = 'plan_' + randomUUID().replaceAll('-', ''),
        q = type === 'mysql' ? '`' : '"',
        table = q + name + q
      try {
        await adapter.execute(
          `CREATE TEMPORARY TABLE ${table}(id INTEGER PRIMARY KEY,title VARCHAR(100))`,
        )
        await adapter.execute(`INSERT INTO ${table} VALUES(1,'one'),(2,'two')`)
        const plan = await explainQuery(type, `SELECT * FROM ${table} WHERE id=1`, (sql) =>
          adapter.execute(sql),
        )
        expect(plan.nodes.length).toBeGreaterThan(0)
        expect(plan.warnings).toEqual([])
        expect(JSON.stringify(plan.nodes)).toContain(name)
        await explainQuery(type, `INSERT INTO ${table} VALUES(3,'not executed')`, (sql) =>
          adapter.execute(sql),
        )
        expect(Number((await adapter.execute(`SELECT COUNT(*) FROM ${table}`)).rows[0]?.[0])).toBe(
          2,
        )
        await expect(
          explainQuery(type, `SELECT 1; DELETE FROM ${table}`, (sql) => adapter.execute(sql)),
        ).rejects.toThrow('一条')
        expect(Number((await adapter.execute(`SELECT COUNT(*) FROM ${table}`)).rows[0]?.[0])).toBe(
          2,
        )
      } finally {
        await adapter.close()
      }
    },
  )
}
