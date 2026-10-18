import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDatabase } from '../src/main/adapters'
import { SchemaTools } from '../src/main/schema-tools'
import type { SchemaRequest } from '../src/shared/contracts'
for (const type of ['mysql', 'postgresql'] as const) {
  const port = process.env[type === 'mysql' ? 'VORK_MYSQL_PORT' : 'VORK_POSTGRES_PORT']
  it.runIf(Boolean(port))(
    `${type}: adds, renames and drops fields, preserves defaults and detects stale previews`,
    async () => {
      const adapter = await openDatabase(
        {
          type,
          name: 'column test',
          host: '127.0.0.1',
          port: Number(port),
          username: 'vork',
          password: 'vork_test_only',
          database: 'vork_test',
        },
        () => {},
      )
      const name = 'col_' + randomUUID().replaceAll('-', ''),
        schema = type === 'mysql' ? 'vork_test' : 'public',
        table = { schema, name },
        q = (name: string) =>
          type === 'mysql'
            ? '`' + name.replaceAll('`', '``') + '`'
            : '"' + name.replaceAll('"', '""') + '"',
        qualified = q(schema) + '.' + q(name)
      const service = new SchemaTools(type, (sql, params) => adapter.execute(sql, params))
      const apply = async (request: SchemaRequest) => {
        const originalMode =
          type === 'mysql' ? (await adapter.execute('SELECT @@sql_mode')).rows : undefined
        const plan = await service.request(request)
        if (plan.kind !== 'schema-preview') throw Error()
        if (
          type === 'mysql' &&
          ['preview-column-type', 'preview-column-nullable'].includes(request.kind) &&
          !String(originalMode![0]![0]).includes('STRICT_ALL_TABLES')
        )
          expect(plan.sql).toContain("SET SESSION sql_mode='")
        await service.request({ kind: 'commit', token: plan.token })
        if (type === 'mysql')
          expect((await adapter.execute('SELECT @@sql_mode')).rows).toEqual(originalMode)
      }
      try {
        await adapter.execute(
          `CREATE TABLE ${qualified}(id INTEGER PRIMARY KEY ${type === 'mysql' ? 'AUTO_INCREMENT' : ''})`,
        )
        await adapter.execute(`INSERT INTO ${qualified} VALUES(1)`)
        for (const [index, mode] of (type === 'mysql'
          ? ['', 'NO_BACKSLASH_ESCAPES']
          : ['']
        ).entries()) {
          if (type === 'mysql') await adapter.execute('SET SESSION sql_mode=?', [mode])
          const field = 'literal_' + index
          await apply({
            kind: 'preview-add-column',
            table,
            name: field,
            type: 'VARCHAR(100)',
            nullable: false,
            default: { kind: 'value', value: "O'Reilly\\path; --" },
          })
          expect((await adapter.execute(`SELECT ${q(field)} FROM ${qualified}`)).rows).toEqual([
            ["O'Reilly\\path; --"],
          ])
          await apply({ kind: 'preview-rename-column', table, column: field, name: field + '_new' })
          expect(
            (await adapter.execute(`SELECT ${q(field + '_new')} FROM ${qualified}`)).rows,
          ).toEqual([["O'Reilly\\path; --"]])
          await apply({ kind: 'preview-drop-column', table, name: field + '_new' })
        }
        if (type === 'mysql') {
          await apply({
            kind: 'preview-add-column',
            table,
            name: 'long_text',
            type: 'TEXT',
            nullable: true,
            default: { kind: 'value', value: 'text default' },
          })
          expect((await adapter.execute(`SELECT long_text FROM ${qualified}`)).rows).toEqual([
            ['text default'],
          ])
          const plan = await service.request({
            kind: 'preview-add-column',
            table,
            name: 'stale_mode',
            type: 'VARCHAR(50)',
            nullable: true,
            default: { kind: 'value', value: 'back\\slash' },
          })
          if (plan.kind !== 'schema-preview') throw Error()
          await adapter.execute("SET SESSION sql_mode=''")
          await expect(service.request({ kind: 'commit', token: plan.token })).rejects.toThrow(
            '模式',
          )
        }
        await apply({
          kind: 'preview-add-column',
          table,
          name: 'stamp',
          type: 'TIMESTAMP',
          nullable: true,
          default: { kind: 'expression', expression: 'CURRENT_TIMESTAMP' },
        })
        expect((await adapter.execute(`SELECT stamp FROM ${qualified}`)).rows[0]?.[0]).toBeTruthy()
        const plan = await service.request({ kind: 'preview-drop-column', table, name: 'stamp' })
        if (plan.kind !== 'schema-preview') throw Error()
        await adapter.execute(`ALTER TABLE ${qualified} ADD COLUMN concurrent INTEGER`)
        await expect(service.request({ kind: 'commit', token: plan.token })).rejects.toThrow(
          '结构已变化',
        )
        expect((await service.request({ kind: 'inspect', table })).kind).toBe('schema')
        await adapter.execute(
          `ALTER TABLE ${qualified} ADD COLUMN editable VARCHAR(40) ${type === 'mysql' ? "CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'before' COMMENT 'keep NOT NULL, comment'" : "NOT NULL DEFAULT 'before'"}`,
        )
        if (type === 'postgresql')
          await adapter.execute(
            `COMMENT ON COLUMN ${qualified}.editable IS 'keep NOT NULL, comment'`,
          )
        await apply({
          kind: 'preview-column-type',
          table,
          name: 'editable',
          type: 'VARCHAR(80)',
          convert: false,
        })
        await apply({ kind: 'preview-column-nullable', table, name: 'editable', nullable: true })
        let info = await service.request({ kind: 'inspect', table })
        if (info.kind !== 'schema') throw Error()
        const field = info.columnInfo.rows.find((row) => row[0] === 'editable')!
        expect(field[1]).toMatch(/80/)
        expect(field[2]).toBe('YES')
        expect(field[9]).toBe('keep NOT NULL, comment')
        if (type === 'mysql') expect(field[5]).toBe('utf8mb4_bin')
        expect((await adapter.execute(`SELECT editable FROM ${qualified}`)).rows).toEqual([
          ['before'],
        ])
        await apply({
          kind: 'preview-column-default',
          table,
          name: 'editable',
          default: { kind: 'value', value: "next ' \\value" },
        })
        await adapter.execute(`INSERT INTO ${qualified}(id) VALUES(2)`)
        expect(
          (await adapter.execute(`SELECT editable FROM ${qualified} WHERE id=2`)).rows,
        ).toEqual([["next ' \\value"]])
        await apply({ kind: 'preview-column-default', table, name: 'editable' })
        info = await service.request({ kind: 'inspect', table })
        if (info.kind !== 'schema') throw Error()
        expect(info.columnInfo.rows.find((row) => row[0] === 'editable')![3]).toBeNull()
        await apply({ kind: 'preview-column-nullable', table, name: 'editable', nullable: false })
        const noNull = await service.request({ kind: 'inspect', table })
        if (noNull.kind !== 'schema') throw Error()
        expect(noNull.columnInfo.rows.find((row) => row[0] === 'editable')![2]).toBe('NO')
        await apply({ kind: 'preview-column-nullable', table, name: 'editable', nullable: true })
        await adapter.execute(`UPDATE ${qualified} SET editable=NULL WHERE id=2`)
        await apply({ kind: 'preview-column-default', table, name: 'editable' })
        const notNull = await service.request({
          kind: 'preview-column-nullable',
          table,
          name: 'editable',
          nullable: false,
        })
        if (notNull.kind !== 'schema-preview') throw Error()
        const failedMode =
          type === 'mysql' ? (await adapter.execute('SELECT @@sql_mode')).rows : undefined
        await expect(service.request({ kind: 'commit', token: notNull.token })).rejects.toThrow(
          /NULL value|contains null values/i,
        )
        expect(
          (await adapter.execute(`SELECT editable FROM ${qualified} WHERE id=2`)).rows,
        ).toEqual([[null]])
        if (type === 'mysql') {
          expect((await adapter.execute('SELECT @@sql_mode')).rows).toEqual(failedMode)
          const shrink = await service.request({
            kind: 'preview-column-type',
            table,
            name: 'editable',
            type: 'VARCHAR(2)',
            convert: false,
          })
          if (shrink.kind !== 'schema-preview') throw Error()
          await expect(service.request({ kind: 'commit', token: shrink.token })).rejects.toThrow(
            /too long|truncated/i,
          )
          expect((await adapter.execute('SELECT @@sql_mode')).rows).toEqual(failedMode)
          expect(
            (await adapter.execute(`SELECT editable FROM ${qualified} WHERE id=1`)).rows,
          ).toEqual([['before']])
          await apply({
            kind: 'preview-column-type',
            table,
            name: 'id',
            type: 'BIGINT',
            convert: false,
          })
          const auto = await service.request({ kind: 'inspect', table })
          if (auto.kind !== 'schema') throw Error()
          const id = auto.columnInfo.rows.find((row) => row[0] === 'id')!
          expect(id[4]).toContain('auto_increment')
          expect(id[7]).toBe('PRI')
          expect(id[1]).toContain('bigint')
        }
        if (type === 'postgresql') {
          await adapter.execute(
            `ALTER TABLE ${qualified} ADD COLUMN numeric_text TEXT; UPDATE ${qualified} SET numeric_text='42'`,
          )
          await apply({
            kind: 'preview-column-type',
            table,
            name: 'numeric_text',
            type: 'INTEGER',
            convert: true,
          })
          expect(
            (await adapter.execute(`SELECT numeric_text FROM ${qualified} ORDER BY id`)).rows,
          ).toEqual([[42], [42]])
        }
      } finally {
        try {
          await adapter.execute(`DROP TABLE IF EXISTS ${qualified}`)
        } finally {
          await adapter.close()
        }
      }
    },
  )
}
