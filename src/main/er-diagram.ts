import { randomUUID } from 'node:crypto'
import type {
  Cell,
  DataTable,
  ErEntity,
  ErRelation,
  ErDiagram,
  ErRequest,
  ErResponse,
  ErPositions,
  QueryResult,
} from '../shared/contracts'
import { diagramSvg, entityKey } from '../shared/er-layout'
type Dialect = 'sqlite' | 'mysql' | 'postgresql'
type Query = (sql: string, parameters?: Cell[]) => Promise<QueryResult>
export class ErDiagramService {
  private snapshot?: ErDiagram
  constructor(
    private type: Dialect,
    private query: Query,
  ) {}
  private quote(name: string) {
    if (typeof name !== 'string' || !name || name.length > 256 || name.includes('\0'))
      throw new Error('数据库对象名称无效')
    const q = this.type === 'mysql' ? '`' : '"'
    return q + name.replaceAll(q, q + q) + q
  }
  async request(input: ErRequest): Promise<ErResponse> {
    if (!input || typeof input !== 'object') throw new Error('关系图请求无效')
    if (input.kind === 'tables') return this.tables(input)
    if (
      input.kind !== 'diagram' ||
      !Array.isArray(input.tables) ||
      !input.tables.length ||
      input.tables.length > 100
    )
      throw new Error('请选择1至100张表，每次可调整选表范围')
    const tables: ErEntity[] = [],
      relations: ErRelation[] = [],
      warnings: string[] = [],
      seen = new Set<string>()
    let bytes = 0
    for (const value of input.tables) {
      const table = { schema: value?.schema, name: value?.name }
      this.quote(table.schema)
      this.quote(table.name)
      const key = entityKey(table)
      if (seen.has(key)) continue
      seen.add(key)
      const result = await this.entity(table)
      bytes += Buffer.byteLength(JSON.stringify(result))
      if (bytes > 4 * 1024 * 1024) throw new Error('关系图超过4 MiB，请减少选中的表')
      tables.push(result.entity)
      relations.push(...result.relations)
      warnings.push(...result.warnings)
    }
    const graph: ErDiagram = {
      kind: 'er-diagram',
      snapshotId: randomUUID(),
      tables,
      relations,
      warnings,
    }
    if (Buffer.byteLength(JSON.stringify(graph)) > 4 * 1024 * 1024)
      throw new Error('关系图超过4 MiB，请减少选中的表')
    this.snapshot = graph
    return graph
  }
  private async tables(input: Extract<ErRequest, { kind: 'tables' }>): Promise<ErResponse> {
    this.quote(input.schema)
    if (
      (input.search !== undefined &&
        (typeof input.search !== 'string' || input.search.length > 256)) ||
      (input.after !== undefined && (typeof input.after !== 'string' || input.after.length > 256))
    )
      throw new Error('选表搜索或分页参数无效')
    if (this.type !== 'sqlite') {
      const schema = await this.query(
        this.type === 'mysql'
          ? 'SELECT schema_name FROM information_schema.schemata WHERE schema_name=?'
          : 'SELECT nspname FROM pg_namespace WHERE nspname=$1',
        [input.schema],
      )
      if (!schema.rows.length) throw new Error('Schema/数据库不存在或不可见：' + input.schema)
    }
    const search = '%' + (input.search || '').replace(/[!%_]/g, (char) => '!' + char) + '%',
      after = input.after || ''
    if (input.names !== undefined && (!Array.isArray(input.names) || input.names.length > 500))
      throw new Error('表名范围无效')
    const names = input.names || []
    for (const name of names) this.quote(name)
    const scope = (column: string, offset: number) =>
      names.length
        ? ' AND ' +
          column +
          ' IN (' +
          names.map((_, i) => (this.type === 'postgresql' ? '$' + (offset + i) : '?')).join(',') +
          ')'
        : ''
    let result: QueryResult
    if (this.type === 'sqlite')
      result = await this.query(
        `SELECT name FROM ${this.quote(input.schema)}.sqlite_schema WHERE type IN ('table','view') AND name NOT GLOB 'sqlite_*' AND name LIKE ? ESCAPE '!' AND name COLLATE BINARY > ? ${scope('name', 3)} ORDER BY name COLLATE BINARY LIMIT 101`,
        [search, after, ...names],
      )
    else if (this.type === 'mysql')
      result = await this.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_name LIKE ? ESCAPE '!' AND BINARY table_name > BINARY ? ${scope('table_name', 4)} ORDER BY BINARY table_name LIMIT 101`,
        [input.schema, search, after, ...names],
      )
    else
      result = await this.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') AND c.relname LIKE $2 ESCAPE '!' AND c.relname COLLATE "C" > $3 COLLATE "C" ${scope('c.relname', 4)} ORDER BY c.relname COLLATE "C" LIMIT 101`,
        [input.schema, search, after, ...names],
      )
    const tables = result.rows.slice(0, 100).map((row) => String(row[0]))
    return {
      kind: 'er-tables',
      tables,
      after: result.rows.length > 100 ? tables.at(-1) : undefined,
    }
  }
  private async entity(table: DataTable) {
    const warnings: string[] = [],
      parameters = [table.schema, table.name]
    let columns: QueryResult, keys: QueryResult
    if (this.type === 'sqlite') {
      const literal = (name: string) => "'" + name.replaceAll("'", "''") + "'",
        schema = this.quote(table.schema)
      columns = await this.query(`PRAGMA ${schema}.table_xinfo(${literal(table.name)})`)
      keys = await this.query(`PRAGMA ${schema}.foreign_key_list(${literal(table.name)})`)
    } else if (this.type === 'mysql') {
      columns = await this.query(
        'SELECT column_name,column_type,is_nullable,column_key FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position',
        parameters,
      )
      keys = await this.query(
        `SELECT k.constraint_name,k.referenced_table_schema,k.referenced_table_name,k.column_name,k.referenced_column_name,k.ordinal_position,r.update_rule,r.delete_rule FROM information_schema.key_column_usage k JOIN information_schema.referential_constraints r ON r.constraint_schema=k.table_schema AND r.table_name=k.table_name AND r.constraint_name=k.constraint_name WHERE k.table_schema=? AND k.table_name=? AND k.referenced_table_name IS NOT NULL ORDER BY k.constraint_name,k.ordinal_position`,
        parameters,
      )
    } else {
      columns = await this.query(
        `SELECT a.attname,format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        parameters,
      )
      keys = await this.query(
        `SELECT con.conname,target_ns.nspname,target.relname,source_col.attname,target_col.attname,k.pos,con.confupdtype,con.confdeltype FROM pg_constraint con JOIN pg_class source ON source.oid=con.conrelid JOIN pg_namespace source_ns ON source_ns.oid=source.relnamespace JOIN pg_class target ON target.oid=con.confrelid JOIN pg_namespace target_ns ON target_ns.oid=target.relnamespace JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY k(src,dst,pos) ON true JOIN pg_attribute source_col ON source_col.attrelid=source.oid AND source_col.attnum=k.src JOIN pg_attribute target_col ON target_col.attrelid=target.oid AND target_col.attnum=k.dst WHERE con.contype='f' AND source_ns.nspname=$1 AND source.relname=$2 ORDER BY con.conname,k.pos`,
        parameters,
      )
    }
    if (!columns.rows.length)
      throw new Error('表不存在或无法读取字段：' + table.schema + '.' + table.name)
    if (columns.truncated || keys.truncated)
      warnings.push(table.schema + '.' + table.name + ' 元数据超过读取上限，可能不完整')
    const entity: ErEntity = {
      table,
      columns: columns.rows
        .filter((row) => this.type !== 'sqlite' || row[6] !== 1)
        .map((row) =>
          this.type === 'sqlite'
            ? {
                name: String(row[1]),
                type: String(row[2]),
                primaryKey: Number(row[5]) > 0,
                nullable:
                  !row[3] && !(Number(row[5]) > 0 && String(row[2]).toUpperCase() === 'INTEGER'),
              }
            : {
                name: String(row[0]),
                type: String(row[1]),
                primaryKey: this.type === 'mysql' ? row[3] === 'PRI' : Boolean(row[3]),
                nullable: this.type === 'mysql' ? row[2] === 'YES' : Boolean(row[2]),
              },
        ),
    }
    const relations: ErRelation[] = [],
      byId = new Map<string, ErRelation>(),
      targetKeys = new Map<string, string[]>()
    for (const row of keys.rows) {
      if (this.type === 'sqlite') {
        const id = String(row[0]),
          target = String(row[2])
        let relation = byId.get(id)
        if (!relation) {
          relation = {
            id: entityKey(table) + ':' + id,
            name: '外键 #' + id,
            from: table,
            to: { schema: table.schema, name: target },
            fromColumns: [],
            toColumns: [],
            onUpdate: String(row[5]),
            onDelete: String(row[6]),
          }
          byId.set(id, relation)
          relations.push(relation)
        }
        let targetColumn = row[4]
        if (targetColumn === null) {
          if (!targetKeys.has(target)) {
            const result = await this.query(
              `PRAGMA ${this.quote(table.schema)}.table_xinfo('${target.replaceAll("'", "''")}')`,
            )
            targetKeys.set(
              target,
              result.rows
                .filter((row) => Number(row[5]) > 0)
                .sort((a, b) => Number(a[5]) - Number(b[5]))
                .map((row) => String(row[1])),
            )
          }
          targetColumn = targetKeys.get(target)?.[Number(row[1])] || '(未解析的主键)'
        }
        relation.fromColumns[Number(row[1])] = String(row[3])
        relation.toColumns[Number(row[1])] = String(targetColumn)
      } else {
        const name = String(row[0])
        let relation = byId.get(name)
        const actions: Record<string, string> = {
          a: 'NO ACTION',
          r: 'RESTRICT',
          c: 'CASCADE',
          n: 'SET NULL',
          d: 'SET DEFAULT',
        }
        if (!relation) {
          relation = {
            id: entityKey(table) + ':' + name,
            name,
            from: table,
            to: { schema: String(row[1]), name: String(row[2]) },
            fromColumns: [],
            toColumns: [],
            onUpdate:
              this.type === 'postgresql'
                ? actions[String(row[6])] || String(row[6])
                : String(row[6]),
            onDelete:
              this.type === 'postgresql'
                ? actions[String(row[7])] || String(row[7])
                : String(row[7]),
          }
          byId.set(name, relation)
          relations.push(relation)
        }
        relation.fromColumns.push(String(row[3]))
        relation.toColumns.push(String(row[4]))
      }
    }
    return { entity, relations, warnings }
  }
  svg(snapshotId: string, positions: ErPositions, full: boolean) {
    if (!this.snapshot || this.snapshot.snapshotId !== snapshotId)
      throw new Error('关系图快照已过期，请刷新后导出')
    return diagramSvg(this.snapshot, positions, full)
  }
}
