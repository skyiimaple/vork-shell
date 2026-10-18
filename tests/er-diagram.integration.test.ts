import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { openDatabase } from '../src/main/adapters'
import { ErDiagramService } from '../src/main/er-diagram'
for (const type of ['mysql', 'postgresql'] as const) {
  const port = process.env[type === 'mysql' ? 'VORK_MYSQL_PORT' : 'VORK_POSTGRES_PORT']
  it.runIf(Boolean(port))(
    `${type}: reads composite/self foreign keys, columns, primary keys and filtered tables`,
    async () => {
      const adapter = await openDatabase(
        {
          type,
          name: 'ER fixture',
          host: '127.0.0.1',
          port: Number(port),
          username: 'vork',
          password: 'vork_test_only',
          database: 'vork_test',
        },
        () => {},
      )
      const prefix = 'er_' + randomUUID().replaceAll('-', ''),
        parent = prefix + '_p',
        child = prefix + '_c',
        schema = type === 'mysql' ? 'vork_test' : 'public',
        quote = type === 'mysql' ? '`' : '"',
        q = (name: string) => quote + name + quote,
        qualified = (name: string) => q(schema) + '.' + q(name)
      try {
        await adapter.execute(
          `CREATE TABLE ${qualified(parent)}(a INTEGER,b VARCHAR(40),PRIMARY KEY(a,b))`,
        )
        await adapter.execute(
          `CREATE TABLE ${qualified(child)}(id INTEGER PRIMARY KEY,x INTEGER,y VARCHAR(40),self_id INTEGER,FOREIGN KEY(x,y) REFERENCES ${qualified(parent)}(a,b) ON DELETE CASCADE ON UPDATE RESTRICT,FOREIGN KEY(self_id) REFERENCES ${qualified(child)}(id))`,
        )
        const service = new ErDiagramService(type, (sql, parameters) =>
          adapter.execute(sql, parameters),
        )
        const list = await service.request({ kind: 'tables', schema, search: prefix })
        if (list.kind !== 'er-tables') throw Error()
        expect(list.tables).toEqual([child, parent])
        const graph = await service.request({
          kind: 'diagram',
          tables: [
            { schema, name: child },
            { schema, name: parent },
          ],
        })
        if (graph.kind !== 'er-diagram') throw Error()
        expect(graph.warnings).toEqual([])
        expect(graph.relations).toHaveLength(2)
        const composite = graph.relations.find((relation) => relation.to.name === parent)!
        expect(composite.fromColumns).toEqual(['x', 'y'])
        expect(composite.toColumns).toEqual(['a', 'b'])
        expect(composite.onDelete).toBe('CASCADE')
        expect(composite.onUpdate).toBe('RESTRICT')
        expect(
          graph.tables[1]?.columns
            .filter((column) => column.primaryKey)
            .map((column) => column.name),
        ).toEqual(['a', 'b'])
        expect(service.svg(graph.snapshotId, {}, false)).toContain('<path')
      } finally {
        try {
          await adapter.execute(`DROP TABLE IF EXISTS ${qualified(child)}`)
          await adapter.execute(`DROP TABLE IF EXISTS ${qualified(parent)}`)
        } finally {
          await adapter.close()
        }
      }
    },
  )
}
