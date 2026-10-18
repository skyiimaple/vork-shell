import { randomUUID } from 'node:crypto'
import { it, expect } from 'vitest'
import { SchemaTools } from '../src/main/schema-tools'
import { openDatabase } from '../src/main/adapters'
for (const dialect of ['mysql', 'postgresql'] as const) {
  const port = process.env[dialect === 'mysql' ? 'VORK_MYSQL_PORT' : 'VORK_POSTGRES_PORT']
  it.runIf(Boolean(port))(
    `${dialect}: inspects indexes/foreign keys/triggers and creates/drops indexes`,
    async () => {
      const adapter = await openDatabase(
        {
          type: dialect,
          name: 'schema test',
          host: '127.0.0.1',
          port: Number(port),
          username: 'vork',
          password: 'vork_test_only',
          database: 'vork_test',
        },
        () => {},
      )
      const prefix = 'schema_' + randomUUID().replaceAll('-', ''),
        schema = dialect === 'mysql' ? 'vork_test' : 'public',
        parent = prefix + '_p',
        name = prefix + '_t',
        index = prefix + '_i',
        trigger = prefix + '_tr',
        fn = prefix + '_fn'
      const q = (value: string) => (dialect === 'mysql' ? '`' + value + '`' : '"' + value + '"'),
        qualified = (value: string) => q(schema) + '.' + q(value)
      const table = { schema, name }
      const service = new SchemaTools(dialect, (sql, params) => adapter.execute(sql, params))
      try {
        await adapter.execute(`CREATE TABLE ${qualified(parent)}(id INTEGER PRIMARY KEY)`)
        await adapter.execute(
          `CREATE TABLE ${qualified(name)}(id INTEGER PRIMARY KEY,title VARCHAR(100) UNIQUE,parent_id INTEGER,FOREIGN KEY(parent_id) REFERENCES ${qualified(parent)}(id))`,
        )
        if (dialect === 'mysql') {
          const sql = `CREATE TRIGGER ${qualified(trigger)} BEFORE INSERT ON ${qualified(name)} FOR EACH ROW SET NEW.title=NEW.title`
          if (process.env.VORK_MYSQL_TRIGGER_SETUP_CONTAINER) {
            const { execFileSync } = await import('node:child_process')
            execFileSync(
              'docker',
              [
                'exec',
                process.env.VORK_MYSQL_TRIGGER_SETUP_CONTAINER,
                'mysql',
                '-uroot',
                '-p' + (process.env.VORK_MYSQL_ADMIN_PASSWORD || 'vork_local_root'),
                '-e',
                sql,
              ],
              { stdio: 'pipe' },
            )
          } else await adapter.execute(sql)
        } else {
          await adapter.execute(
            `CREATE FUNCTION ${qualified(fn)}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
          )
          await adapter.execute(
            `CREATE TRIGGER ${q(trigger)} BEFORE INSERT ON ${qualified(name)} FOR EACH ROW EXECUTE FUNCTION ${qualified(fn)}()`,
          )
        }
        const info = await service.request({ kind: 'inspect', table })
        if (info.kind !== 'schema') throw Error()
        expect(info.indexes.some((index) => index.protected)).toBe(true)
        expect(info.foreignKeys.rows.length).toBeGreaterThan(0)
        expect(info.triggers.rows.length).toBeGreaterThan(0)
        const preview = await service.request({
          kind: 'preview-create-index',
          table,
          name: index,
          columns: [
            { name: 'parent_id', descending: true },
            { name: 'title', descending: false },
          ],
          unique: false,
        })
        if (preview.kind !== 'schema-preview') throw Error()
        await service.request({ kind: 'commit', token: preview.token })
        const changed = await service.request({ kind: 'inspect', table })
        if (changed.kind !== 'schema') throw Error()
        expect(changed.indexes.some((item) => item.name === index)).toBe(true)
        const drop = await service.request({ kind: 'preview-drop-index', table, name: index })
        if (drop.kind !== 'schema-preview') throw Error()
        await service.request({ kind: 'commit', token: drop.token })
        const after = await service.request({ kind: 'inspect', table })
        if (after.kind !== 'schema') throw Error()
        expect(after.indexes.some((item) => item.name === index)).toBe(false)
      } finally {
        try {
          await adapter.execute(`DROP TABLE IF EXISTS ${qualified(name)}`)
          await adapter.execute(`DROP TABLE IF EXISTS ${qualified(parent)}`)
          if (dialect === 'postgresql')
            await adapter.execute(`DROP FUNCTION IF EXISTS ${qualified(fn)}()`)
        } finally {
          await adapter.close()
        }
      }
    },
  )
}
