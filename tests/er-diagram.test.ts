import { it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { runSqlite } from '../src/main/sqlite'
import { ErDiagramService } from '../src/main/er-diagram'
import { diagramSvg, entityKey, layoutDiagram } from '../src/shared/er-layout'
it('reads ordered composite keys and implicit target primary keys; pages and searches tables', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE parent(a INTEGER,b TEXT,PRIMARY KEY(a,b));CREATE TABLE child(id INTEGER PRIMARY KEY,x INTEGER,y TEXT,FOREIGN KEY(x,y) REFERENCES parent);CREATE TABLE other(id INTEGER)',
  )
  const service = new ErDiagramService('sqlite', async (sql, parameters = []) =>
    runSqlite(db, sql, 1000, parameters),
  )
  try {
    const tables = await service.request({ kind: 'tables', schema: 'main', search: 'child' })
    if (tables.kind !== 'er-tables') throw Error()
    expect(tables.tables).toEqual(['child'])
    const graph = await service.request({
      kind: 'diagram',
      tables: [
        { schema: 'main', name: 'child' },
        { schema: 'main', name: 'parent' },
      ],
    })
    if (graph.kind !== 'er-diagram') throw Error()
    expect(graph.relations[0]?.fromColumns).toEqual(['x', 'y'])
    expect(graph.relations[0]?.toColumns).toEqual(['a', 'b'])
    expect(
      graph.tables[1]?.columns.filter((column) => column.primaryKey).map((column) => column.name),
    ).toEqual(['a', 'b'])
    const svg = service.svg(graph.snapshotId, {}, false)
    expect(svg).toContain('<svg')
    expect(svg).toContain('main.child')
    await expect(
      service.request({ kind: 'diagram', tables: [{ schema: 'main', name: 'missing' }] }),
    ).rejects.toThrow('不存在')
    expect(() => service.svg('missing', {}, false)).toThrow('过期')
  } finally {
    db.close()
  }
})
it('lays out external references and escapes text when exporting SVG', () => {
  const graph = {
    kind: 'er-diagram' as const,
    snapshotId: 's',
    tables: [
      {
        table: { schema: 'main', name: 'a<script>' },
        columns: [{ name: '"<id>', type: 'TEXT', primaryKey: true, nullable: false }],
      },
    ],
    relations: [
      {
        id: 'r',
        name: 'fk<script>',
        from: { schema: 'main', name: 'a<script>' },
        to: { schema: 'main', name: 'external' },
        fromColumns: ['"<id>'],
        toColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
      },
    ],
    warnings: [],
  }
  const layout = layoutDiagram(graph, {}, false)
  expect(layout.nodes).toHaveLength(2)
  expect(layout.nodes.find((node) => node.external)?.table.name).toBe('external')
  const svg = diagramSvg(graph, { [entityKey(graph.tables[0]!.table)]: { x: 40, y: 60 } }, false)
  expect(svg).toContain('&lt;script&gt;')
  expect(svg).not.toContain('<script>')
  expect(svg).toContain('<path')
})
it('pages complete table lists, treats wildcard search literally and validates export coordinates', async () => {
  const db = new DatabaseSync(':memory:')
  for (let i = 0; i < 110; i++) db.exec(`CREATE TABLE t${String(i).padStart(3, '0')}(id INTEGER)`)
  db.exec('CREATE TABLE "percent%name"(id INTEGER)')
  const service = new ErDiagramService('sqlite', async (sql, parameters = []) =>
    runSqlite(db, sql, 1000, parameters),
  )
  try {
    const first = await service.request({ kind: 'tables', schema: 'main' })
    if (first.kind !== 'er-tables') throw Error()
    expect(first.tables).toHaveLength(100)
    const second = await service.request({ kind: 'tables', schema: 'main', after: first.after })
    if (second.kind !== 'er-tables') throw Error()
    expect(new Set([...first.tables, ...second.tables]).size).toBe(111)
    expect(second.after).toBeUndefined()
    const literal = await service.request({ kind: 'tables', schema: 'main', search: '%' })
    if (literal.kind !== 'er-tables') throw Error()
    expect(literal.tables).toEqual(['percent%name'])
    const graph = await service.request({
      kind: 'diagram',
      tables: [{ schema: 'main', name: 't000' }],
    })
    if (graph.kind !== 'er-diagram') throw Error()
    expect(() => service.svg(graph.snapshotId, { x: { x: NaN, y: 0 } }, false)).toThrow('坐标')
  } finally {
    db.close()
  }
})
it('keeps same-column relationship routing inside the exported canvas', () => {
  const child = { schema: 'main', name: 'child' },
    parent = { schema: 'main', name: 'parent' },
    orphan = { schema: 'main', name: 'orphan' }
  const graph = {
    kind: 'er-diagram' as const,
    snapshotId: 's',
    tables: [child, orphan, parent].map((table) => ({
      table,
      columns: [{ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }],
    })),
    relations: [
      {
        id: 'fk',
        name: 'fk',
        from: child,
        to: parent,
        fromColumns: ['id'],
        toColumns: ['id'],
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
      },
    ],
    warnings: [],
  }
  const edge = layoutDiagram(graph, {}, false).edges[0]!
  expect(edge.path).not.toMatch(/[-]\d/)
})
it('resolves implicit composite references in primary-key order, not physical field order', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE parent(a INTEGER,b TEXT,PRIMARY KEY(b,a));CREATE TABLE child(x TEXT,y INTEGER,FOREIGN KEY(x,y) REFERENCES parent)',
  )
  try {
    const service = new ErDiagramService('sqlite', async (sql, parameters = []) =>
      runSqlite(db, sql, 1000, parameters),
    )
    const graph = await service.request({
      kind: 'diagram',
      tables: [{ schema: 'main', name: 'child' }],
    })
    if (graph.kind !== 'er-diagram') throw Error()
    expect(graph.relations[0]?.toColumns).toEqual(['b', 'a'])
  } finally {
    db.close()
  }
})
