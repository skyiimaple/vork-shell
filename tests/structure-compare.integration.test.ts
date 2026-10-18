import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDatabase } from '../src/main/adapters'
import { SchemaTools } from '../src/main/schema-tools'
import { readStructureTable, compareStructures } from '../src/main/structure-compare'
for (const type of ['mysql', 'postgresql'] as const) {
  const port = process.env[type === 'mysql' ? 'VORK_MYSQL_PORT' : 'VORK_POSTGRES_PORT']
  it.runIf(Boolean(port))(
    `${type}: compares complete types, defaults, generated columns, checks and metadata changes`,
    async () => {
      const config = {
        type,
        name: 'compare fixture',
        host: '127.0.0.1',
        port: Number(port),
        username: 'vork',
        password: 'vork_test_only',
        database: 'vork_test',
      }
      const adapter = await openDatabase(config, () => {}),
        other = await openDatabase(config, () => {})
      const name = 'cmp_' + randomUUID().replaceAll('-', ''),
        schema = type === 'mysql' ? 'vork_test' : 'public',
        q = (value: string) => (type === 'mysql' ? '`' + value + '`' : '"' + value + '"'),
        table = q(schema) + '.' + q(name)
      try {
        await adapter.execute(
          `CREATE TABLE ${table}(id INTEGER PRIMARY KEY ${type === 'mysql' ? 'AUTO_INCREMENT' : ''},title VARCHAR(40) NOT NULL DEFAULT 'old',score INTEGER CHECK(score>0),computed INTEGER GENERATED ALWAYS AS (LENGTH(title)) STORED)`,
        )
        await adapter.execute(`CREATE INDEX ${q(name + '_idx')} ON ${table}(title)`)
        const snapshot = await readStructureTable(type, { schema, name }, (sql, parameters) =>
          adapter.execute(sql, parameters),
        )
        expect(snapshot.columns.find((column) => column.name === 'title')?.type).toMatch(/40/)
        expect(
          snapshot.columns.find((column) => column.name === 'computed')?.generated,
        ).toBeTruthy()
        expect(snapshot.checks.rows.length).toBeGreaterThan(0)
        const identical = await readStructureTable(type, { schema, name }, (sql, parameters) =>
          other.execute(sql, parameters),
        )
        expect(compareStructures([snapshot], [identical], schema, schema)).toEqual([])
        if (type === 'mysql') {
          const tools = new SchemaTools(type, (sql, parameters) => adapter.execute(sql, parameters))
          const preview = await tools.request({
            kind: 'preview-create-index',
            table: { schema, name },
            name: name + '_score',
            columns: [{ name: 'score', descending: false }],
            unique: false,
          })
          if (preview.kind !== 'schema-preview') throw Error()
          await other.execute(`INSERT INTO ${table}(title,score) VALUES('row',1)`)
          await tools.request({ kind: 'commit', token: preview.token })
        }
        await other.execute(`ALTER TABLE ${table} ADD COLUMN extra INTEGER`)
        const changed = await readStructureTable(type, { schema, name }, (sql, parameters) =>
          adapter.execute(sql, parameters),
        )
        expect(
          compareStructures([snapshot], [changed], schema, schema).some(
            (row) => row.kind === 'column' && row.name === 'extra' && row.change === 'target-only',
          ),
        ).toBe(true)
      } finally {
        try {
          await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        } finally {
          await Promise.all([adapter.close(), other.close()])
        }
      }
    },
  )
}
