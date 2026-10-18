import { randomUUID } from 'node:crypto'
import { SchemaTools } from './schema-tools'
import { ErDiagramService } from './er-diagram'
import type {
  Cell,
  DataTable,
  QueryResult,
  StructureTable,
  StructureColumn,
  StructureDifference,
  StructureSource,
  StructureRef,
  StructureCompareRequest,
  StructureReport,
  StructureProgress,
} from '../shared/contracts'
type Dialect = 'sqlite' | 'mysql' | 'postgresql'
type Query = (sql: string, parameters?: Cell[]) => Promise<QueryResult>
export async function readStructureTable(
  type: Dialect,
  table: DataTable,
  query: Query,
): Promise<StructureTable> {
  const info = await new SchemaTools(type, query).request({ kind: 'inspect', table }),
    graph = await new ErDiagramService(type, query).request({ kind: 'diagram', tables: [table] })
  if (info.kind !== 'schema' || graph.kind !== 'er-diagram') throw new Error('结构读取失败')
  if (graph.warnings.length) throw new Error('结构读取不完整：' + graph.warnings.join('；'))
  const entity = graph.tables[0]!,
    raw = info.columnInfo
  const columns: StructureColumn[] = raw.rows
    .filter((row) => type !== 'sqlite' || row[6] !== 1)
    .map((row, index) => {
      const name = String(row[type === 'sqlite' ? 1 : 0]),
        field = entity.columns.find((field) => field.name === name)
      if (!field) throw new Error('字段结构在读取时发生变化，请重试')
      return {
        name,
        type: field.type,
        nullable: field.nullable,
        primaryKey: field.primaryKey,
        position: index + 1,
        defaultValue: type === 'sqlite' ? row[4]! : row[3]!,
        extra:
          type === 'sqlite'
            ? String(row[6])
            : String(row[4] || '') + (type === 'postgresql' ? ':' + String(row[7] || '') : ''),
        collation: type === 'sqlite' ? null : row[5] === null ? null : String(row[5]),
        generated: type === 'sqlite' ? null : row[8] === null ? null : String(row[8] || ''),
        comment: type === 'sqlite' ? '' : String(row[9] || ''),
      }
    })
  return {
    table,
    kind: info.objectKind,
    columns,
    indexes: info.indexes,
    foreignKeys: graph.relations,
    triggers: info.triggers,
    checks: info.checks,
    definition: info.objectDefinition,
  }
}
function json(value: unknown) {
  return JSON.stringify(value)
}
export function compareStructures(
  source: StructureTable[],
  target: StructureTable[],
  sourceSchema: string,
  targetSchema: string,
): StructureDifference[] {
  const differences: StructureDifference[] = [],
    a = new Map(source.map((table) => [table.table.name, table])),
    b = new Map(target.map((table) => [table.table.name, table]))
  for (const table of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const left = a.get(table),
      right = b.get(table)
    if (!left || !right) {
      differences.push({
        table,
        kind: 'object',
        name: table,
        change: left ? 'source-only' : 'target-only',
        source: left,
        target: right,
      })
      continue
    }
    if (left.kind !== right.kind)
      differences.push({
        table,
        kind: 'object',
        name: table,
        change: 'changed',
        source: left.kind,
        target: right.kind,
      })
    const compare = (
      kind: StructureDifference['kind'],
      x: { name: string; value: unknown }[],
      y: { name: string; value: unknown }[],
    ) => {
      const one = new Map(x.map((item) => [item.name, item.value])),
        two = new Map(y.map((item) => [item.name, item.value]))
      for (const name of [...new Set([...one.keys(), ...two.keys()])].sort()) {
        if (!one.has(name) || !two.has(name) || json(one.get(name)) !== json(two.get(name)))
          differences.push({
            table,
            kind,
            name,
            change: !one.has(name) ? 'target-only' : !two.has(name) ? 'source-only' : 'changed',
            source: one.get(name),
            target: two.get(name),
          })
      }
    }
    compare(
      'column',
      left.columns.map((value) => ({ name: value.name, value })),
      right.columns.map((value) => ({ name: value.name, value })),
    )
    const indexes = (value: StructureTable) =>
      value.indexes.map((index) => ({
        name: index.name,
        value: {
          definition: index.definition,
          unique: index.unique,
          protected: index.protected,
          columns: index.columns,
          method: index.method || '',
          predicate: index.predicate || null,
          included: index.included || [],
        },
      }))
    compare('index', indexes(left), indexes(right))
    const foreign = (value: StructureTable, schema: string) =>
      value.foreignKeys.map((key) => ({
        name: key.name,
        value: {
          toSchema: key.to.schema === schema ? '(当前 Schema)' : key.to.schema,
          toTable: key.to.name,
          fromColumns: key.fromColumns,
          toColumns: key.toColumns,
          onUpdate: key.onUpdate,
          onDelete: key.onDelete,
        },
      }))
    compare('foreign-key', foreign(left, sourceSchema), foreign(right, targetSchema))
    compare(
      'trigger',
      left.triggers.rows.map((row) => ({ name: String(row[0]), value: row.slice(1) })),
      right.triggers.rows.map((row) => ({ name: String(row[0]), value: row.slice(1) })),
    )
    compare(
      'check',
      left.checks.rows.map((row) => ({ name: String(row[0]), value: row.slice(1) })),
      right.checks.rows.map((row) => ({ name: String(row[0]), value: row.slice(1) })),
    )
    if (left.definition !== right.definition)
      differences.push({
        table,
        kind: 'definition',
        name: '定义原文',
        change: 'changed',
        source: left.definition,
        target: right.definition,
      })
  }
  return differences
}
interface Access {
  open(
    owner: number,
    ref: StructureRef,
  ): Promise<{ id: string; source: StructureSource; temporary: boolean }>
  close(owner: number, id: string): Promise<unknown>
  tables(
    owner: number,
    id: string,
    schema: string,
    after: string | undefined,
    signal: AbortSignal,
    names?: string[],
  ): Promise<{ tables: string[]; after?: string }>
  table(owner: number, id: string, table: DataTable, signal: AbortSignal): Promise<StructureTable>
}
export class StructureCompareService {
  private jobs = new Map<string, AbortController>()
  private reports = new Map<number, StructureReport>()
  constructor(
    private access: Access,
    private progress: (owner: number, progress: StructureProgress) => void = () => {},
  ) {}
  cancel(owner: number, id: string) {
    const job = this.jobs.get(owner + ':' + id)
    if (!job) return false
    job.abort()
    return true
  }
  closeOwner(owner: number) {
    for (const [key, job] of this.jobs) if (key.startsWith(owner + ':')) job.abort()
    this.reports.delete(owner)
  }
  report(owner: number, id: string) {
    const report = this.reports.get(owner)
    if (!report || report.id !== id) throw new Error('对比报告已过期，请重新对比')
    return report
  }
  async compare(owner: number, input: StructureCompareRequest): Promise<StructureReport> {
    if (!input || typeof input.id !== 'string' || !/^[\w-]{1,100}$/.test(input.id))
      throw new Error('对比请求无效')
    for (const ref of [input.source, input.target])
      if (
        !ref ||
        !['profile', 'session'].includes(ref.kind) ||
        typeof ref.id !== 'string' ||
        !ref.id ||
        ref.id.length > 200
      )
        throw new Error('请选择有效的对比连接')
    for (const schema of [input.sourceSchema, input.targetSchema])
      if (typeof schema !== 'string' || !schema || schema.length > 256 || schema.includes('\0'))
        throw new Error('Schema 名称无效')
    if (
      input.tables !== undefined &&
      (!Array.isArray(input.tables) ||
        input.tables.length > 500 ||
        input.tables.some(
          (name) => typeof name !== 'string' || !name || name.length > 256 || name.includes('\0'),
        ))
    )
      throw new Error('表名范围无效或超过500张表')
    if ([...this.jobs.keys()].some((key) => key.startsWith(owner + ':')))
      throw new Error('已有结构对比进行中，请等待或取消')
    const key = owner + ':' + input.id,
      controller = new AbortController()
    this.jobs.set(key, controller)
    const check = () => {
      if (controller.signal.aborted) throw new Error('结构对比已取消')
    }
    const timer = setTimeout(() => controller.abort(), 300000)
    try {
      const capture = async (ref: StructureRef, schema: string, side: 'source' | 'target') => {
        check()
        const opened = await this.access.open(owner, ref)
        try {
          check()
          const names: string[] = []
          let after: string | undefined
          do {
            const page = await this.access.tables(
              owner,
              opened.id,
              schema,
              after,
              controller.signal,
              input.tables?.length ? input.tables : undefined,
            )
            check()
            names.push(...page.tables)
            after = page.after
            if (names.length > 500) throw new Error('Schema 超过500张表，请指定要对比的表名范围')
          } while (after)
          const selected = input.tables?.length
              ? names.filter((name) => input.tables!.includes(name))
              : names,
            objects: StructureTable[] = []
          let bytes = 0
          for (const name of selected) {
            check()
            this.progress(owner, {
              id: input.id,
              side,
              completed: objects.length,
              total: selected.length,
              table: name,
            })
            const object = await this.access.table(
              owner,
              opened.id,
              { schema, name },
              controller.signal,
            )
            check()
            bytes += Buffer.byteLength(json(object))
            if (bytes > 4 * 1024 * 1024) throw new Error('结构快照超过4 MiB，请缩小对比范围')
            objects.push(object)
          }
          this.progress(owner, {
            id: input.id,
            side,
            completed: objects.length,
            total: selected.length,
            table: '',
          })
          return { source: opened.source, objects }
        } finally {
          if (opened.temporary) await this.access.close(owner, opened.id)
        }
      }
      const source = await capture(input.source, input.sourceSchema, 'source'),
        target = await capture(input.target, input.targetSchema, 'target')
      check()
      if (input.tables?.length && !source.objects.length && !target.objects.length)
        throw new Error('指定的表在两侧均不存在，请检查表名范围')
      const report: StructureReport = {
        id: randomUUID(),
        requestedTables: [...new Set(input.tables || [])],
        createdAt: new Date().toISOString(),
        source: { ...source.source, schema: input.sourceSchema },
        target: { ...target.source, schema: input.targetSchema },
        sourceTables: source.objects.length,
        targetTables: target.objects.length,
        differences: compareStructures(
          source.objects,
          target.objects,
          input.sourceSchema,
          input.targetSchema,
        ),
        warnings: [
          '两侧按顺序读取，不构成跨数据库一致性事务快照。定义、类型和默认值按元数据原文比较，可能包含格式差异。',
        ],
      }
      if (source.source.type !== target.source.type)
        report.warnings.push(
          '不同数据库方言：不推断类型、索引和默认值的语义等价，也不自动执行同步。',
        )
      this.reports.set(owner, report)
      return report
    } catch (e) {
      if (controller.signal.aborted) throw new Error('结构对比已取消或达到5分钟上限')
      throw e
    } finally {
      clearTimeout(timer)
      this.jobs.delete(key)
    }
  }
}
