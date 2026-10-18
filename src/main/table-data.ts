import { randomUUID } from 'node:crypto'
import type {
  Cell,
  DataColumn,
  DataTable,
  QueryResult,
  TablePage,
  TableRequest,
  TableResponse,
} from '../shared/contracts'
type Dialect = 'sqlite' | 'mysql' | 'postgresql'
type Query = (sql: string, parameters?: Cell[]) => Promise<QueryResult>
interface Metadata {
  columns: DataColumn[]
  regular: boolean
}
interface Snapshot {
  table: DataTable
  columns: DataColumn[]
  rows: Cell[][]
  created: number
}
function quote(value: string, type: Dialect): string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
    throw new Error('数据库对象名称无效')
  const q = type === 'mysql' ? '`' : '"'
  return q + value.replaceAll(q, q + q) + q
}
function simple(type: string): boolean {
  return /^(?:(?:tiny|small|medium|big)?int(?:eger)?|int[248]|float[48]?|real|double(?: precision)?|decimal|numeric|text|tinytext|mediumtext|longtext|char(?:acter)?(?: varying)?|varchar|nchar|nvarchar|clob|uuid|bool(?:ean)?)(?:\([^)]*\))?$/i.test(
    type.trim(),
  )
}
export class TableDataService {
  private snapshots = new Map<string, Snapshot>()
  private plans = new Map<
    string,
    {
      table: DataTable
      columns: DataColumn[]
      sql: string
      parameters: Cell[]
      created: number
      requestedRows?: number
    }
  >()
  private validCell(value: unknown) {
    if (
      (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      (typeof value === 'string' && Buffer.byteLength(value) > 65536)
    )
      throw new Error('字段值无效或超过64 KiB')
  }
  private signature(columns: DataColumn[]) {
    return JSON.stringify(columns.map(({ editable: _editable, ...column }) => column))
  }
  private plan(
    table: DataTable,
    columns: DataColumn[],
    sql: string,
    parameters: Cell[],
    requestedRows?: number,
  ) {
    const token = randomUUID()
    this.plans.set(token, { table, columns, sql, parameters, created: Date.now(), requestedRows })
    while (this.plans.size > 2) this.plans.delete(this.plans.keys().next().value!)
    return {
      kind: 'mutation-preview' as const,
      token,
      sql,
      parameters,
      ...(requestedRows ? { requestedRows } : {}),
    }
  }
  private async previewInsert(input: Extract<TableRequest, { kind: 'preview-insert' }>) {
    const table = { schema: input.table?.schema, name: input.table?.name }
    const meta = await this.metadata(table)
    if (!meta.regular || !Array.isArray(input.values) || input.values.length > meta.columns.length)
      throw new Error('此对象不支持新增行或字段参数无效')
    const names = new Set<string>(),
      parameters: Cell[] = []
    for (const item of input.values) {
      const column = meta.columns.find((column) => column.name === item?.column)
      if (
        !column ||
        !(column.editable || column.primaryKey > 0) ||
        !simple(column.type) ||
        names.has(item.column)
      )
        throw new Error('字段不支持写入或重复')
      this.validCell(item.value)
      names.add(item.column)
      parameters.push(item.value)
    }
    const sql =
      'INSERT INTO ' +
      this.qualified(table) +
      (names.size
        ? ' (' +
          [...names].map((name) => quote(name, this.type)).join(', ') +
          ') VALUES (' +
          parameters.map((_, i) => this.mark(i + 1)).join(', ') +
          ')'
        : this.type === 'mysql'
          ? ' () VALUES ()'
          : ' DEFAULT VALUES')
    return this.plan(table, meta.columns, sql, parameters)
  }
  private rowConditions(snapshot: Snapshot, rowIndex: number, parameters: Cell[]) {
    const conditions = snapshot.columns.map((column, index) => {
      const value = snapshot.rows[rowIndex]![index]!
      parameters.push(value)
      let left = quote(column.name, this.type),
        right = this.mark(parameters.length)
      if (typeof value === 'string') {
        if (this.type === 'mysql') {
          left = 'BINARY ' + left
          right = 'BINARY ' + right
        } else if (this.type === 'sqlite') left += ' COLLATE BINARY'
        else if (/^(text|char|character|varchar)/i.test(column.type)) left += ' COLLATE "C"'
      }
      return (
        left +
        (this.type === 'mysql'
          ? ' <=> '
          : this.type === 'postgresql'
            ? ' IS NOT DISTINCT FROM '
            : ' IS ') +
        right
      )
    })
    return '(' + conditions.join(' AND ') + ')'
  }
  private selectedSnapshot(snapshotId: string, indices: number[]) {
    const snapshot = this.snapshots.get(snapshotId)
    if (
      !snapshot ||
      !Array.isArray(indices) ||
      !indices.length ||
      indices.length > 100 ||
      new Set(indices).size !== indices.length ||
      indices.some((index) => !Number.isInteger(index) || !snapshot.rows[index])
    )
      throw new Error('数据快照已过期或所选行无效，请刷新')
    if (!snapshot.columns.every((column) => simple(column.type)))
      throw new Error('当前表含复杂字段，暂不能安全比较整行写入')
    if (indices.length * snapshot.columns.length > 10000)
      throw new Error('写入参数超过10000个，请减少所选行')
    return snapshot
  }
  private async previewUpdate(input: Extract<TableRequest, { kind: 'preview-update-many' }>) {
    const snapshot = this.selectedSnapshot(input.snapshotId, input.rowIndices)
    const column = snapshot.columns.find((column) => column.name === input.column)
    if (!column?.editable || column.primaryKey || !simple(column.type))
      throw new Error('此字段不可批量更新')
    this.validCell(input.value)
    const parameters: Cell[] = [input.value]
    const conditions = input.rowIndices.map((index) =>
      this.rowConditions(snapshot, index, parameters),
    )
    return this.plan(
      snapshot.table,
      snapshot.columns,
      'UPDATE ' +
        this.qualified(snapshot.table) +
        ' SET ' +
        quote(input.column, this.type) +
        ' = ' +
        this.mark(1) +
        ' WHERE ' +
        conditions.join(' OR '),
      parameters,
      input.rowIndices.length,
    )
  }
  private async previewDelete(
    input: Extract<TableRequest, { kind: 'preview-delete' | 'preview-delete-many' }>,
  ) {
    const indices = input.kind === 'preview-delete' ? [input.rowIndex] : input.rowIndices
    const snapshot = this.selectedSnapshot(input.snapshotId, indices)
    const parameters: Cell[] = []
    const conditions = indices.map((index) => this.rowConditions(snapshot, index, parameters))
    return this.plan(
      snapshot.table,
      snapshot.columns,
      'DELETE FROM ' + this.qualified(snapshot.table) + ' WHERE ' + conditions.join(' OR '),
      parameters,
      input.kind === 'preview-delete-many' ? indices.length : undefined,
    )
  }
  private async commit(token: string) {
    const plan = this.plans.get(token)
    if (!plan) throw new Error('预览已过期，请重新预览')
    this.plans.delete(token)
    const meta = await this.metadata(plan.table)
    if (!meta.regular || this.signature(meta.columns) !== this.signature(plan.columns))
      throw new Error('表结构已修改，请刷新后重新预览')
    const result = await this.query(plan.sql, plan.parameters)
    this.snapshots.clear()
    if (plan.requestedRows !== undefined)
      return {
        kind: 'edited' as const,
        affectedRows: result.affectedRows,
        requestedRows: plan.requestedRows,
      }
    if (result.affectedRows !== 1) throw new Error('数据已修改或行已删除，发生冲突；请刷新后重试')
    return { kind: 'edited' as const, affectedRows: 1 }
  }
  constructor(
    private type: Dialect,
    private query: Query,
  ) {}
  private mark(index: number) {
    return this.type === 'postgresql' ? '$' + index : '?'
  }
  private qualified(table: DataTable) {
    return quote(table.schema, this.type) + '.' + quote(table.name, this.type)
  }
  private async metadata(table: DataTable): Promise<Metadata> {
    this.qualified(table)
    let columns: QueryResult, object: QueryResult
    if (this.type === 'sqlite') {
      object = await this.query(
        'SELECT type, sql FROM ' + quote(table.schema, this.type) + '.sqlite_schema WHERE name=?',
        [table.name],
      )
      // Identifier quoting doubles apostrophes because table_xinfo expects a SQL string argument.
      columns = await this.query(
        'PRAGMA ' +
          quote(table.schema, this.type) +
          ".table_xinfo('" +
          table.name.replaceAll("'", "''") +
          "')",
      )
      const regular =
        object.rows[0]?.[0] === 'table' &&
        !/^CREATE\s+VIRTUAL\s+TABLE/i.test(String(object.rows[0]?.[1]))
      if (!object.rows.length || !columns.rows.length || columns.truncated)
        throw new Error('表不存在或字段数量超过上限')
      return {
        regular,
        columns: columns.rows
          .filter((row) => Number(row[6]) !== 1)
          .map((row) => ({
            name: String(row[1]),
            type: String(row[2]),
            primaryKey: Number(row[5]),
            editable:
              regular && Number(row[5]) === 0 && Number(row[6]) === 0 && simple(String(row[2])),
          })),
      }
    }
    const p1 = this.mark(1),
      p2 = this.mark(2)
    object = await this.query(
      `SELECT table_type FROM information_schema.tables WHERE table_schema=${p1} AND table_name=${p2}`,
      [table.schema, table.name],
    )
    if (this.type === 'mysql')
      columns = await this.query(
        `SELECT column_name,data_type,CASE WHEN column_key='PRI' THEN ordinal_position ELSE 0 END,extra FROM information_schema.columns WHERE table_schema=${p1} AND table_name=${p2} ORDER BY ordinal_position`,
        [table.schema, table.name],
      )
    else
      columns = await this.query(
        `SELECT c.column_name,c.data_type,COALESCE(pk.ordinal_position,0),c.is_generated,EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class parent ON parent.oid=i.inhparent JOIN pg_catalog.pg_namespace ns ON ns.oid=parent.relnamespace JOIN pg_catalog.pg_class child ON child.oid=i.inhrelid WHERE ns.nspname=c.table_schema AND parent.relname=c.table_name AND NOT child.relispartition) FROM information_schema.columns c LEFT JOIN (SELECT k.table_schema,k.table_name,k.column_name,k.ordinal_position FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k ON k.constraint_catalog=t.constraint_catalog AND k.constraint_schema=t.constraint_schema AND k.constraint_name=t.constraint_name AND k.table_schema=t.table_schema AND k.table_name=t.table_name WHERE t.constraint_type='PRIMARY KEY') pk ON pk.table_schema=c.table_schema AND pk.table_name=c.table_name AND pk.column_name=c.column_name WHERE c.table_schema=${p1} AND c.table_name=${p2} ORDER BY c.ordinal_position`,
        [table.schema, table.name],
      )
    if (!object.rows.length || !columns.rows.length || columns.truncated)
      throw new Error('表不存在或字段数量超过上限')
    const regular =
      String(object.rows[0]?.[0]).toUpperCase() === 'BASE TABLE' &&
      !(this.type === 'postgresql' && columns.rows.some((row) => row[4] === true))
    return {
      regular,
      columns: columns.rows.map((row) => ({
        name: String(row[0]),
        type: String(row[1]),
        primaryKey: Number(row[2]),
        editable:
          regular &&
          Number(row[2]) === 0 &&
          simple(String(row[1])) &&
          (this.type === 'mysql' ? !/GENERATED/i.test(String(row[3])) : row[3] === 'NEVER'),
      })),
    }
  }
  async request(input: TableRequest): Promise<TableResponse> {
    if (!input || typeof input !== 'object') throw new Error('数据表请求无效')
    for (const [id, snapshot] of this.snapshots)
      if (Date.now() - snapshot.created > 5 * 60 * 1000) this.snapshots.delete(id)
    for (const [token, plan] of this.plans)
      if (Date.now() - plan.created > 5 * 60 * 1000) this.plans.delete(token)
    if (input.kind === 'preview-update-many') return this.previewUpdate(input)
    if (input.kind === 'preview-insert') return this.previewInsert(input)
    if (input.kind === 'preview-delete' || input.kind === 'preview-delete-many')
      return this.previewDelete(input)
    if (input.kind === 'commit') return this.commit(input.token)
    if (input.kind === 'edit') return this.edit(input)
    if (
      input.kind !== 'browse' ||
      !input.table ||
      !Number.isInteger(input.page) ||
      input.page < 0 ||
      input.page > 100000 ||
      !Number.isInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > 100
    )
      throw new Error('数据表分页参数无效')
    const table = { schema: input.table.schema, name: input.table.name },
      meta = await this.metadata(table)
    const names = new Set(meta.columns.map((column) => column.name)),
      parameters: Cell[] = [],
      where: string[] = []
    if (input.filter && input.filters) throw new Error('不能同时使用两种筛选参数')
    const filters = input.filters ?? (input.filter ? [input.filter] : [])
    if (
      !Array.isArray(filters) ||
      filters.length > 20 ||
      (input.match !== undefined && !['all', 'any'].includes(input.match))
    )
      throw new Error('筛选条件无效或超过20条')
    for (const f of filters) {
      if (!f || !names.has(f.column)) throw new Error('筛选字段不存在')
      const column = quote(f.column, this.type)
      if (f.operator === 'is-null' || f.operator === 'not-null') {
        where.push(column + (f.operator === 'is-null' ? ' IS NULL' : ' IS NOT NULL'))
        continue
      }
      this.validCell(f.value)
      const operators = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }
      if (Object.hasOwn(operators, f.operator)) {
        if (f.value === null) throw new Error('NULL 请使用为空或不为空筛选')
        parameters.push(f.value!)
        where.push(
          column +
            ' ' +
            operators[f.operator as keyof typeof operators] +
            ' ' +
            this.mark(parameters.length),
        )
      } else if (['contains', 'not-contains', 'starts-with', 'ends-with'].includes(f.operator)) {
        if (typeof f.value !== 'string') throw new Error('文本匹配需要文本值')
        const value = f.value.replace(/[!%_]/g, (match) => '!' + match)
        parameters.push(
          (f.operator === 'starts-with' ? '' : '%') +
            value +
            (f.operator === 'ends-with' ? '' : '%'),
        )
        where.push(
          `CAST(${column} AS ${this.type === 'mysql' ? 'CHAR' : 'TEXT'}) ${f.operator === 'not-contains' ? 'NOT LIKE' : 'LIKE'} ${this.mark(parameters.length)} ESCAPE '!'`,
        )
      } else throw new Error('筛选操作无效')
    }
    const primary = meta.columns
      .filter((column) => column.primaryKey > 0)
      .sort((a, b) => a.primaryKey - b.primaryKey)
    const order: string[] = []
    if (input.sort) {
      if (!names.has(input.sort.column) || typeof input.sort.descending !== 'boolean')
        throw new Error('排序字段无效')
      order.push(quote(input.sort.column, this.type) + (input.sort.descending ? ' DESC' : ' ASC'))
    }
    for (const column of primary)
      if (column.name !== input.sort?.column) order.push(quote(column.name, this.type) + ' ASC')
    if (!order.length) {
      const fallback = meta.columns.find((column) => simple(column.type))
      if (fallback) order.push(quote(fallback.name, this.type) + ' ASC')
    }
    const limit = input.pageSize + 1,
      offset = input.page * input.pageSize
    if (this.type !== 'mysql') parameters.push(limit, offset)
    // MySQL binary protocol sends JS numbers as DOUBLE; validated LIMIT/OFFSET integers are emitted directly.
    const pagination =
      this.type === 'mysql'
        ? ` LIMIT ${limit} OFFSET ${offset}`
        : ' LIMIT ' + this.mark(parameters.length - 1) + ' OFFSET ' + this.mark(parameters.length)
    const projections = meta.columns.map((column) => quote(column.name, this.type))
    if (this.type === 'sqlite')
      projections.push(
        ...meta.columns.map((column) => 'typeof(' + quote(column.name, this.type) + ')'),
      )
    const result = await this.query(
      'SELECT ' +
        projections.join(',') +
        ' FROM ' +
        this.qualified(table) +
        (where.length ? ' WHERE ' + where.join(input.match === 'any' ? ' OR ' : ' AND ') : '') +
        (order.length ? ' ORDER BY ' + order.join(',') : '') +
        pagination,
      parameters,
    )
    const hasNext = !result.truncated && result.rows.length > input.pageSize
    const rawRows = result.rows.slice(0, input.pageSize)
    const rows = rawRows.map((row) => row.slice(0, meta.columns.length))
    const types = this.type === 'sqlite' ? rawRows.map((row) => row.slice(meta.columns.length)) : []
    if (this.type === 'sqlite')
      meta.columns = meta.columns.map((column, index) => ({
        ...column,
        editable: column.editable && !types.some((row) => row[index] === 'blob'),
      }))
    const data = { ...result, columns: meta.columns.map((column) => column.name), rows }
    const page: TablePage = {
      kind: 'page',
      result: data,
      columns: meta.columns,
      page: input.page,
      pageSize: input.pageSize,
      hasNext,
      insertColumns: meta.regular
        ? meta.columns
            .filter((column) => simple(column.type) && (column.editable || column.primaryKey > 0))
            .map((column) => column.name)
        : undefined,
    }
    let reason = ''
    if (
      this.type === 'sqlite' &&
      types.some((row) =>
        primary.some(
          (column) => row[meta.columns.findIndex((c) => c.name === column.name)] === 'blob',
        ),
      )
    )
      reason = '当前页包含实际为二进制的主键，仅支持读取'
    else if (!meta.regular) reason = '视图、虚拟表或传统继承父表仅支持读取'
    else if (!primary.length || primary.some((column) => !simple(column.type)))
      reason = '没有可安全定位的标量主键，仅支持读取'
    else if (
      rows.some((row) =>
        primary.some(
          (column) => row[meta.columns.findIndex((c) => c.name === column.name)] == null,
        ),
      )
    )
      reason = '当前页包含空主键，仅支持读取'
    else if (result.truncated || Buffer.byteLength(JSON.stringify(rows)) > 1024 * 1024)
      reason = '当前页超过编辑快照上限，仅支持读取'
    if (reason) {
      page.readOnlyReason = reason
      page.columns = meta.columns.map((column) => ({ ...column, editable: false }))
    } else if (rows.length) {
      const id = randomUUID()
      this.snapshots.set(id, { table, columns: meta.columns, rows, created: Date.now() })
      while (this.snapshots.size > 2) this.snapshots.delete(this.snapshots.keys().next().value!)
      page.snapshotId = id
      page.canDelete = meta.columns.every((column) => simple(column.type))
      page.canBatchUpdate = page.canDelete && meta.columns.some((column) => column.editable)
    }
    return page
  }
  private async edit(input: Extract<TableRequest, { kind: 'edit' }>): Promise<TableResponse> {
    const snapshot = this.snapshots.get(input.snapshotId)
    if (!snapshot) throw new Error('编辑快照已过期，请刷新数据表')
    if (
      !Number.isInteger(input.rowIndex) ||
      input.rowIndex < 0 ||
      input.rowIndex >= snapshot.rows.length
    )
      throw new Error('编辑行无效')
    const cell = snapshot.columns.find((column) => column.name === input.column)
    if (!cell?.editable) throw new Error('此字段为只读，不能编辑主键、生成字段或复杂类型')
    if (
      (input.value !== null && !['string', 'number', 'boolean'].includes(typeof input.value)) ||
      (typeof input.value === 'number' && !Number.isFinite(input.value)) ||
      (typeof input.value === 'string' && Buffer.byteLength(input.value) > 65536)
    )
      throw new Error('单元格值无效或超过64 KiB')
    const fresh = await this.metadata(snapshot.table)
    if (
      !fresh.regular ||
      JSON.stringify(fresh.columns.map(({ editable: _editable, ...column }) => column)) !==
        JSON.stringify(snapshot.columns.map(({ editable: _editable, ...column }) => column)) ||
      !fresh.columns.find((column) => column.name === cell.name)?.editable
    )
      throw new Error('数据表结构已修改，请刷新后重试')
    const row = snapshot.rows[input.rowIndex]!,
      parameters: Cell[] = [input.value]
    const conditions: string[] = []
    const compare = (name: string, value: Cell, exact = false) => {
      parameters.push(value)
      let left = quote(name, this.type),
        right = this.mark(parameters.length)
      if (exact && this.type === 'sqlite') left += ' COLLATE BINARY'
      if (this.type === 'mysql' && typeof value === 'string') {
        left = 'BINARY ' + left
        right = 'BINARY ' + right
      }
      if (exact && this.type === 'postgresql' && /^(text|char|character|varchar)/i.test(cell.type))
        left += ' COLLATE "C"'
      const op =
        this.type === 'postgresql'
          ? ' IS NOT DISTINCT FROM '
          : this.type === 'mysql'
            ? ' <=> '
            : ' IS '
      conditions.push(left + op + right)
    }
    for (const column of snapshot.columns.filter((c) => c.primaryKey > 0))
      compare(column.name, row[snapshot.columns.findIndex((c) => c.name === column.name)]!)
    compare(cell.name, row[snapshot.columns.findIndex((c) => c.name === cell.name)]!, true)
    const result = await this.query(
      'UPDATE ' +
        this.qualified(snapshot.table) +
        ' SET ' +
        quote(cell.name, this.type) +
        '=' +
        this.mark(1) +
        ' WHERE ' +
        conditions.join(' AND '),
      parameters,
    )
    if (result.affectedRows !== 1) throw new Error('数据已修改或行已删除，发生冲突；请刷新后重试')
    this.snapshots.clear()
    return { kind: 'edited', affectedRows: 1 }
  }
}
