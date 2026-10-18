import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDatabase } from '../src/main/adapters'
import { SchemaTools } from '../src/main/schema-tools'
for (const type of ['mysql', 'postgresql'] as const) {
  const port = process.env[type === 'mysql' ? 'VORK_MYSQL_PORT' : 'VORK_POSTGRES_PORT']
  it.runIf(Boolean(port))(
    `${type}: composite foreign-key add/drop, cascade, rejected data and parent schema conflict`,
    async () => {
      const adapter = await openDatabase(
        {
          type,
          name: 'fk fixture',
          host: '127.0.0.1',
          port: Number(port),
          username: 'vork',
          password: 'vork_test_only',
          database: 'vork_test',
        },
        () => {},
      )
      const schema = type === 'mysql' ? 'vork_test' : 'public',
        prefix = 'fk_' + randomUUID().replaceAll('-', ''),
        parent = { schema, name: prefix + '_p' },
        table = { schema, name: prefix + '_c' }
      const q = (name: string) => (type === 'mysql' ? '`' + name + '`' : '"' + name + '"'),
        qualified = (name: string) => q(schema) + '.' + q(name)
      const service = new SchemaTools(type, (sql, params) => adapter.execute(sql, params))
      const input = {
        kind: 'preview-create-foreign-key' as const,
        table,
        name: prefix,
        columns: ['pa', 'pb'],
        reference: parent,
        referenceColumns: ['a', 'b'],
        onUpdate: 'CASCADE' as const,
        onDelete: 'RESTRICT' as const,
      }
      try {
        await adapter.execute(
          `CREATE TABLE ${qualified(parent.name)}(a INTEGER,b VARCHAR(40),PRIMARY KEY(a,b))`,
        )
        await adapter.execute(
          `CREATE TABLE ${qualified(table.name)}(id INTEGER PRIMARY KEY,pa INTEGER,pb VARCHAR(40))`,
        )
        await adapter.execute(`INSERT INTO ${qualified(parent.name)} VALUES(1,'one')`)
        await adapter.execute(`INSERT INTO ${qualified(table.name)} VALUES(1,1,'one')`)
        let plan = await service.request(input)
        if (plan.kind !== 'schema-preview') throw Error()
        await service.request({ kind: 'commit', token: plan.token })
        const list = await service.request({ kind: 'foreign-keys', table })
        if (list.kind !== 'foreign-keys') throw Error()
        expect(list.keys[0]).toMatchObject({
          name: prefix,
          fromColumns: ['pa', 'pb'],
          toColumns: ['a', 'b'],
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
          droppable: true,
        })
        await expect(
          adapter.execute(`INSERT INTO ${qualified(table.name)} VALUES(2,99,'bad')`),
        ).rejects.toThrow()
        await adapter.execute(`UPDATE ${qualified(parent.name)} SET a=2`)
        expect((await adapter.execute(`SELECT pa FROM ${qualified(table.name)}`)).rows).toEqual([
          [2],
        ])
        const drop = await service.request({
          kind: 'preview-drop-foreign-key',
          table,
          key: list.keys[0]!.key,
        })
        if (drop.kind !== 'schema-preview') throw Error()
        await service.request({ kind: 'commit', token: drop.token })
        await adapter.execute(`UPDATE ${qualified(table.name)} SET pa=99`)
        plan = await service.request(input)
        if (plan.kind !== 'schema-preview') throw Error()
        await expect(service.request({ kind: 'commit', token: plan.token })).rejects.toThrow()
        expect((await adapter.execute(`SELECT pa FROM ${qualified(table.name)}`)).rows).toEqual([
          [99],
        ])
        await adapter.execute(`UPDATE ${qualified(table.name)} SET pa=2`)
        plan = await service.request(input)
        if (plan.kind !== 'schema-preview') throw Error()
        await adapter.execute(`ALTER TABLE ${qualified(parent.name)} ADD COLUMN changed INTEGER`)
        await expect(service.request({ kind: 'commit', token: plan.token })).rejects.toThrow(
          '目标表结构',
        )
        if (type === 'mysql') {
          await adapter.execute('SET SESSION foreign_key_checks=0')
          await expect(service.request(input)).rejects.toThrow('foreign_key_checks')
          await adapter.execute('SET SESSION foreign_key_checks=1')
          const mode = await service.request(input)
          if (mode.kind !== 'schema-preview') throw Error()
          await adapter.execute('SET SESSION foreign_key_checks=0')
          await expect(service.request({ kind: 'commit', token: mode.token })).rejects.toThrow(
            'foreign_key_checks',
          )
          await adapter.execute('SET SESSION foreign_key_checks=1')
          await adapter.execute(`ALTER TABLE ${qualified(table.name)} ENGINE=MyISAM`)
          await expect(service.request(input)).rejects.toThrow('InnoDB')
        }
      } finally {
        try {
          await adapter.execute(`DROP TABLE IF EXISTS ${qualified(table.name)}`)
          await adapter.execute(`DROP TABLE IF EXISTS ${qualified(parent.name)}`)
        } finally {
          await adapter.close()
        }
      }
    },
  )
}
