import { ErDiagramService } from './er-diagram'
import {
  SqliteRebuildService,
  sqliteForeignKeyClauses,
  type SqliteColumnChange,
} from './sqlite-rebuild'
import { rewriteMysqlColumn } from './mysql-column'
import { randomUUID } from 'node:crypto'
import type {
  Cell,
  DataTable,
  QueryResult,
  SchemaIndex,
  SchemaInfo,
  SchemaRequest,
  SchemaResponse,
  ColumnDefault,
  SchemaForeignKey,
} from '../shared/contracts'
type Dialect = 'sqlite' | 'mysql' | 'postgresql'
type Query = (sql: string, parameters?: Cell[]) => Promise<QueryResult>
export class SchemaTools {
  private plans = new Map<
    string,
    {
      table: DataTable
      signature: string
      sql: string
      created: number
      sqlMode?: string
      strictMode?: string
      mysqlForeignCheck?: boolean
      sqliteToken?: string
      reference?: { table: DataTable; signature: string }
    }
  >()
  private sqliteRebuild?: SqliteRebuildService
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
  private tableName(table: DataTable) {
    return this.quote(table.schema) + '.' + this.quote(table.name)
  }
  private mark(index: number) {
    return this.type === 'postgresql' ? '$' + index : '?'
  }
  private async inspect(table: DataTable): Promise<SchemaInfo> {
    this.tableName(table)
    const indexes: SchemaIndex[] = []
    let canCreateIndex = false,
      objectKind = '',
      objectDefinition = ''
    let checks: QueryResult = {
      columns: [],
      rows: [],
      affectedRows: 0,
      elapsedMs: 0,
      truncated: false,
    }
    let columns: QueryResult, foreignKeys: QueryResult, triggers: QueryResult
    if (this.type === 'sqlite') {
      const schema = this.quote(table.schema),
        literal = (value: string) => "'" + value.replaceAll("'", "''") + "'"
      const object = await this.query(`SELECT type,sql FROM ${schema}.sqlite_schema WHERE name=?`, [
        table.name,
      ])
      objectKind = String(object.rows[0]?.[0] || '')
      objectDefinition = String(object.rows[0]?.[1] || '')
      if (/^CREATE\s+VIRTUAL/i.test(objectDefinition)) objectKind = 'virtual-table'
      canCreateIndex = objectKind === 'table'
      columns = await this.query(`PRAGMA ${schema}.table_xinfo(${literal(table.name)})`)
      const rows = await this.query(`PRAGMA ${schema}.index_list(${literal(table.name)})`)
      if (rows.truncated) throw new Error('索引数量超过读取上限')
      for (const row of rows.rows) {
        const name = String(row[1]),
          fields = await this.query(`PRAGMA ${schema}.index_xinfo(${literal(name)})`)
        const source = await this.query(
          `SELECT sql FROM ${schema}.sqlite_schema WHERE type='index' AND name=?`,
          [name],
        )
        indexes.push({
          name,
          method: 'BTREE',
          predicate: row[4] ? String(source.rows[0]?.[0] || '') : null,
          unique: Boolean(row[2]),
          protected: row[3] !== 'c',
          columns: fields.rows
            .filter((row) => row[5] === 1)
            .map(
              (row) =>
                (row[2] === null ? '(表达式)' : String(row[2])) + (row[3] ? ' DESC' : ' ASC'),
            ),
          definition: String(source.rows[0]?.[0] || '由主键或唯一约束维护'),
        })
      }
      foreignKeys = await this.query(`PRAGMA ${schema}.foreign_key_list(${literal(table.name)})`)
      triggers = await this.query(
        `SELECT name,sql FROM ${schema}.sqlite_schema WHERE type='trigger' AND tbl_name=? ORDER BY name`,
        [table.name],
      )
    } else {
      const parameters = [table.schema, table.name],
        where = `table_schema=${this.mark(1)} AND table_name=${this.mark(2)}`
      if (this.type === 'mysql') {
        const object = await this.query(
          `SELECT table_type FROM information_schema.tables WHERE ${where}`,
          parameters,
        )
        objectKind = object.rows[0]?.[0] === 'BASE TABLE' ? 'table' : 'view'
        canCreateIndex = objectKind === 'table'
        columns = await this.query(
          `SELECT column_name,column_type,is_nullable,column_default,extra,collation_name,ordinal_position,column_key,generation_expression,column_comment FROM information_schema.columns WHERE ${where} ORDER BY ordinal_position`,
          parameters,
        )
        const definition = await this.query('SHOW CREATE TABLE ' + this.tableName(table))
        objectDefinition = String(definition.rows[0]?.[1] || '')
        const available = await this.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='information_schema' AND table_name='CHECK_CONSTRAINTS'",
        )
        if (available.rows.length)
          checks = await this.query(
            "SELECT t.constraint_name,c.check_clause FROM information_schema.table_constraints t JOIN information_schema.check_constraints c ON c.constraint_schema=t.constraint_schema AND c.constraint_name=t.constraint_name WHERE t.table_schema=? AND t.table_name=? AND t.constraint_type='CHECK' ORDER BY t.constraint_name",
            parameters,
          )
      } else {
        const object = await this.query(
          `SELECT c.relkind,CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) ELSE NULL END FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`,
          parameters,
        )
        const kinds: Record<string, string> = {
          r: 'table',
          p: 'partitioned-table',
          v: 'view',
          m: 'materialized-view',
          f: 'foreign-table',
        }
        objectKind = kinds[String(object.rows[0]?.[0])] || String(object.rows[0]?.[0] || '')
        objectDefinition = String(object.rows[0]?.[1] || '')
        canCreateIndex = ['table', 'partitioned-table', 'materialized-view'].includes(objectKind)
        columns = await this.query(
          `SELECT a.attname,format_type(a.atttypid,a.atttypmod),CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END,pg_get_expr(d.adbin,d.adrelid),a.attgenerated,CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END,a.attnum,a.attidentity,CASE WHEN a.attgenerated<>'' THEN pg_get_expr(d.adbin,d.adrelid) ELSE NULL END,col_description(a.attrelid,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
          parameters,
        )
        checks = await this.query(
          `SELECT con.conname,pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE con.contype='c' AND n.nspname=$1 AND c.relname=$2 ORDER BY con.conname`,
          parameters,
        )
      }
      if (this.type === 'mysql') {
        const expressionSupport = await this.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='information_schema' AND table_name='STATISTICS' AND column_name='EXPRESSION'",
        )
        const rows = await this.query(
          'SELECT index_name,non_unique,column_name,collation,index_type,sub_part,' +
            (expressionSupport.rows.length ? 'expression' : 'NULL') +
            ' FROM information_schema.statistics WHERE ' +
            where +
            ' ORDER BY index_name,seq_in_index',
          parameters,
        )
        if (rows.truncated) throw new Error('索引数量超过读取上限')
        for (const row of rows.rows) {
          const name = String(row[0])
          let index = indexes.find((index) => index.name === name)
          if (!index) {
            index = {
              name,
              unique: !row[1],
              protected: name === 'PRIMARY',
              columns: [],
              definition: String(row[4]),
              method: String(row[4]),
            }
            indexes.push(index)
          }
          index.columns.push(
            (row[2] === null ? String(row[6] || '(表达式)') : String(row[2])) +
              (row[5] == null ? '' : '(' + row[5] + ')') +
              (row[3] === 'D' ? ' DESC' : ' ASC'),
          )
        }
        foreignKeys = await this.query(
          `SELECT constraint_name,column_name,referenced_table_schema,referenced_table_name,referenced_column_name FROM information_schema.key_column_usage WHERE ${where} AND referenced_table_name IS NOT NULL ORDER BY constraint_name,ordinal_position`,
          parameters,
        )
        triggers = await this.query(
          'SELECT trigger_name,event_manipulation,action_timing,action_statement FROM information_schema.triggers WHERE trigger_schema=? AND event_object_table=? ORDER BY trigger_name',
          parameters,
        )
      } else {
        const rows = await this.query(
          `SELECT idx.relname,i.indisunique,EXISTS(SELECT 1 FROM pg_constraint con WHERE con.conindid=i.indexrelid),pg_get_indexdef(i.indexrelid),pg_get_indexdef(i.indexrelid,k.n,true),am.amname,pg_get_expr(i.indpred,i.indrelid),k.n>i.indnkeyatts FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_am am ON am.oid=idx.relam CROSS JOIN LATERAL generate_series(1,i.indnatts) k(n) WHERE ns.nspname=$1 AND t.relname=$2 ORDER BY idx.relname,k.n`,
          parameters,
        )
        if (rows.truncated) throw new Error('索引数量超过读取上限')
        for (const row of rows.rows) {
          const name = String(row[0])
          let index = indexes.find((index) => index.name === name)
          if (!index) {
            index = {
              name,
              unique: Boolean(row[1]),
              protected: Boolean(row[2]),
              columns: [],
              definition: String(row[3]),
              method: String(row[5]),
              predicate: row[6] === null ? null : String(row[6]),
              included: [],
            }
            indexes.push(index)
          }
          index.columns.push(String(row[4]))
          if (row[7] === true) index.included!.push(String(row[4]))
        }
        foreignKeys = await this.query(
          `SELECT c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2 AND c.contype='f' ORDER BY c.conname`,
          parameters,
        )
        triggers = await this.query(
          `SELECT tg.tgname,pg_get_triggerdef(tg.oid) AS definition FROM pg_trigger tg JOIN pg_class t ON t.oid=tg.tgrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=$2 AND NOT tg.tgisinternal ORDER BY tg.tgname`,
          parameters,
        )
      }
    }
    if (
      !columns.rows.length ||
      columns.truncated ||
      foreignKeys.truncated ||
      triggers.truncated ||
      checks.truncated
    )
      throw new Error('对象不存在或结构数量超过读取上限')
    return {
      kind: 'schema',
      columnInfo: columns,
      objectKind,
      objectDefinition,
      checks,
      canCreateIndex,
      columns: columns.rows.map((row) => String(row[this.type === 'sqlite' ? 1 : 0])),
      indexes,
      foreignKeys,
      triggers,
    }
  }
  private signature(info: SchemaInfo) {
    return JSON.stringify([
      info.canCreateIndex,
      info.columns,
      info.columnInfo.rows,
      info.objectKind,
      this.type === 'mysql' && info.objectKind === 'table' ? null : info.objectDefinition,
      info.checks.rows,
      info.indexes,
      info.foreignKeys.rows,
      info.triggers.rows,
    ])
  }
  private preview(
    table: DataTable,
    info: SchemaInfo,
    sql: string,
    sqlMode?: string,
    strictMode?: string,
    reference?: { table: DataTable; signature: string },
  ): SchemaResponse {
    const token = randomUUID()
    this.plans.set(token, {
      table,
      sql,
      signature: this.signature(info),
      created: Date.now(),
      sqlMode,
      strictMode,
      reference,
    })
    while (this.plans.size > 2) this.plans.delete(this.plans.keys().next().value!)
    const previewSql = strictMode
      ? `SET SESSION sql_mode='${strictMode}';\n${sql};\nSET SESSION sql_mode='${sqlMode}';`
      : sql
    return { kind: 'schema-preview', token, sql: previewSql }
  }
  private async sqlitePreview(table: DataTable, info: SchemaInfo, change: SqliteColumnChange) {
    this.sqliteRebuild ??= new SqliteRebuildService(this.query)
    const result = await this.sqliteRebuild.preview(table, change)
    this.plans.set(result.token, {
      table,
      sql: result.sql,
      signature: this.signature(info),
      created: Date.now(),
      sqliteToken: result.token,
    })
    while (this.plans.size > 2) this.plans.delete(this.plans.keys().next().value!)
    return result
  }
  private async foreignKeys(table: DataTable, info: SchemaInfo): Promise<SchemaForeignKey[]> {
    const graph = await new ErDiagramService(this.type, this.query).request({
      kind: 'diagram',
      tables: [table],
    })
    if (graph.kind !== 'er-diagram' || graph.warnings.length)
      throw new Error('外键元数据不完整，请刷新')
    if (this.type !== 'sqlite')
      return graph.relations.map((relation) => ({
        ...relation,
        key: relation.name,
        droppable: true,
        definition:
          this.type === 'postgresql'
            ? String(info.foreignKeys.rows.find((row) => row[0] === relation.name)?.[1] || '')
            : this.foreignDefinition(
                relation.name,
                relation.fromColumns,
                relation.to,
                relation.toColumns,
                relation.onUpdate,
                relation.onDelete,
              ),
      }))
    let clauses: ReturnType<typeof sqliteForeignKeyClauses> = []
    try {
      clauses = sqliteForeignKeyClauses(info.objectDefinition)
    } catch {
      /* Unrecognized clauses remain read-only. */
    }
    const used = new Set<string>(),
      fold = (value: string) => value.replace(/[A-Z]/g, (value) => value.toLowerCase()),
      same = (a: string[], b: string[]) =>
        JSON.stringify(a.map(fold)) === JSON.stringify(b.map(fold))
    return graph.relations.map((relation) => {
      const clause = clauses.find(
        (clause) =>
          !used.has(clause.key) &&
          same(clause.fromColumns, relation.fromColumns) &&
          fold(clause.toTable) === fold(relation.to.name) &&
          (!clause.toColumns.length || same(clause.toColumns, relation.toColumns)) &&
          clause.onUpdate === relation.onUpdate &&
          clause.onDelete === relation.onDelete,
      )
      if (clause) used.add(clause.key)
      return {
        ...relation,
        key: clause?.key || relation.id,
        name: clause?.name || relation.name,
        droppable: !!clause,
        definition: clause?.definition || '',
      }
    })
  }
  private foreignDefinition(
    name: string,
    columns: string[],
    target: DataTable,
    targetColumns: string[],
    onUpdate: string,
    onDelete: string,
  ) {
    return (
      'CONSTRAINT ' +
      this.quote(name) +
      ' FOREIGN KEY (' +
      columns.map((name) => this.quote(name)).join(', ') +
      ') REFERENCES ' +
      (this.type === 'sqlite' ? this.quote(target.name) : this.tableName(target)) +
      ' (' +
      targetColumns.map((name) => this.quote(name)).join(', ') +
      ') ON UPDATE ' +
      onUpdate +
      ' ON DELETE ' +
      onDelete
    )
  }
  private async assertMysqlForeignKeyContext(table: DataTable, reference: DataTable) {
    if (Number((await this.query('SELECT @@foreign_key_checks')).rows[0]?.[0]) !== 1)
      throw new Error('请先开启当前连接的 foreign_key_checks，再创建外键')
    for (const target of [table, reference]) {
      const result = await this.query(
        'SELECT engine FROM information_schema.tables WHERE table_schema=? AND table_name=?',
        [target.schema, target.name],
      )
      if (String(result.rows[0]?.[0]).toUpperCase() !== 'INNODB')
        throw new Error('当前外键管理要求源表和目标表使用 InnoDB 引擎')
    }
  }
  private async foreignPreview(
    input: Extract<
      SchemaRequest,
      { kind: 'preview-create-foreign-key' | 'preview-drop-foreign-key' }
    >,
    table: DataTable,
    info: SchemaInfo,
  ) {
    if (!['table', 'partitioned-table'].includes(info.objectKind))
      throw new Error('此对象不支持外键编辑')
    const keys = await this.foreignKeys(table, info)
    if (input.kind === 'preview-drop-foreign-key') {
      const key = keys.find((key) => key.key === input.key)
      if (!key || !key.droppable) throw new Error('外键已变化或无法解析，请刷新')
      if (this.type === 'sqlite')
        return this.sqlitePreview(table, info, { kind: 'drop-foreign-key', key: input.key })
      return this.preview(
        table,
        info,
        'ALTER TABLE ' +
          this.tableName(table) +
          (this.type === 'mysql' ? ' DROP FOREIGN KEY ' : ' DROP CONSTRAINT ') +
          this.quote(key.name),
      )
    }
    this.quote(input.name)
    if (
      (this.type === 'postgresql' && Buffer.byteLength(input.name) > 63) ||
      (this.type === 'mysql' && [...input.name].length > 64)
    )
      throw new Error('外键名称超过数据库长度限制')
    if (keys.some((key) => key.name === input.name)) throw new Error('外键名称已存在')
    const rules = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']
    if (!rules.includes(input.onUpdate) || !rules.includes(input.onDelete))
      throw new Error('外键规则无效')
    if (this.type === 'mysql' && [input.onUpdate, input.onDelete].includes('SET DEFAULT'))
      throw new Error('MySQL 不支持 SET DEFAULT 外键规则')
    if (
      !Array.isArray(input.columns) ||
      !Array.isArray(input.referenceColumns) ||
      !input.columns.length ||
      input.columns.length > 32 ||
      input.columns.length !== input.referenceColumns.length ||
      new Set(input.columns).size !== input.columns.length ||
      new Set(input.referenceColumns).size !== input.referenceColumns.length ||
      input.columns.some((name) => !info.columns.includes(name))
    )
      throw new Error('外键字段映射无效或重复')
    const reference = { schema: input.reference?.schema, name: input.reference?.name }
    this.tableName(reference)
    if (this.type === 'sqlite' && reference.schema.toLowerCase() !== table.schema.toLowerCase())
      throw new Error('SQLite 外键不能跨数据库')
    const target = await this.inspect(reference)
    if (
      !['table', 'partitioned-table'].includes(target.objectKind) ||
      input.referenceColumns.some((name) => !target.columns.includes(name))
    )
      throw new Error('目标表或字段无效')
    if (this.type === 'mysql') await this.assertMysqlForeignKeyContext(table, reference)
    const definition = this.foreignDefinition(
      input.name,
      input.columns,
      reference,
      input.referenceColumns,
      input.onUpdate,
      input.onDelete,
    )
    if (this.type === 'sqlite')
      return this.sqlitePreview(table, info, {
        kind: 'add-foreign-key',
        name: input.name,
        definition,
      })
    const result = this.preview(
      table,
      info,
      'ALTER TABLE ' + this.tableName(table) + ' ADD ' + definition,
      undefined,
      undefined,
      { table: reference, signature: this.signature(target) },
    )
    if (this.type === 'mysql' && result.kind === 'schema-preview')
      this.plans.get(result.token)!.mysqlForeignCheck = true
    return result
  }
  private columnType(input: string) {
    if (typeof input !== 'string' || input.length > 100) throw new Error('字段类型无效')
    const value = input.trim().toUpperCase().replace(/\s+/g, ' ')
    const types =
      this.type === 'sqlite'
        ? 'INTEGER|INT|TEXT|REAL|BLOB|NUMERIC|VARCHAR|CHAR|BOOLEAN|DATE|DATETIME|DECIMAL'
        : this.type === 'mysql'
          ? 'TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|FLOAT|DOUBLE|DECIMAL|NUMERIC|CHAR|VARCHAR|TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT|BINARY|VARBINARY|BLOB|TINYBLOB|MEDIUMBLOB|LONGBLOB|BOOLEAN|BOOL|DATE|TIME|DATETIME|TIMESTAMP|YEAR|JSON|BIT'
          : 'SMALLINT|INT|INTEGER|BIGINT|REAL|DOUBLE PRECISION|DECIMAL|NUMERIC|CHAR|CHARACTER|VARCHAR|CHARACTER VARYING|TEXT|BYTEA|BOOLEAN|BOOL|DATE|TIME|TIMESTAMP|TIMESTAMPTZ|TIMETZ|UUID|JSON|JSONB|INET|CIDR|MACADDR|INTERVAL'
    const suffix =
      this.type === 'mysql'
        ? '(?: UNSIGNED)?'
        : this.type === 'postgresql'
          ? '(?: (?:WITH|WITHOUT) TIME ZONE)?(?:\\[\\])?'
          : ''
    if (
      !new RegExp(
        '^(?:' + types + ')(?:\\([0-9]{1,6}(?:\\s*,\\s*[0-9]{1,6})?\\))?' + suffix + '$',
      ).test(value)
    )
      throw new Error('字段类型不受支持或语法无效，请使用内置类型')
    return value
  }
  private async columnDefault(option: ColumnDefault, columnType: string) {
    let sqlMode: string | undefined
    if (!option || typeof option !== 'object') throw new Error('默认值无效')
    let literal: string
    if (option.kind === 'expression') {
      if (!['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME'].includes(option.expression))
        throw new Error('默认表达式无效')
      literal =
        this.type === 'mysql' && option.expression !== 'CURRENT_TIMESTAMP'
          ? '(' + option.expression + ')'
          : option.expression
    } else if (option.kind === 'value') {
      const value = option.value
      if (value === null) literal = 'NULL'
      else if (typeof value === 'boolean') literal = value ? 'TRUE' : 'FALSE'
      else if (typeof value === 'number' && Number.isFinite(value)) literal = String(value)
      else if (
        typeof value === 'string' &&
        !value.includes('\0') &&
        Buffer.byteLength(value) <= 65536
      ) {
        let text = value
        if (this.type === 'mysql') {
          const mode = await this.query('SELECT @@sql_mode')
          if (typeof mode.rows[0]?.[0] !== 'string') throw new Error('无法读取 MySQL SQL 模式')
          sqlMode = String(mode.rows[0][0])
          if (!sqlMode.split(',').includes('NO_BACKSLASH_ESCAPES'))
            text = text.replaceAll('\\', '\\\\')
        } else if (this.type === 'postgresql') text = text.replaceAll('\\', '\\\\')
        literal = (this.type === 'postgresql' ? 'E' : '') + "'" + text.replaceAll("'", "''") + "'"
      } else throw new Error('默认值无效或超过64 KiB')
    } else throw new Error('默认值类型无效')
    if (this.type === 'mysql' && /^(?:TINY|MEDIUM|LONG)?(?:TEXT|BLOB)$|^JSON$/.test(columnType))
      literal = '(' + literal + ')'
    return { literal, sqlMode }
  }
  private async columnPreview(
    input: Extract<
      SchemaRequest,
      {
        kind:
          | 'preview-add-column'
          | 'preview-rename-column'
          | 'preview-drop-column'
          | 'preview-column-default'
          | 'preview-column-type'
          | 'preview-column-nullable'
      }
    >,
    table: DataTable,
    info: SchemaInfo,
  ) {
    if (!['table', 'partitioned-table'].includes(info.objectKind))
      throw new Error('此对象不支持字段编辑')
    const name = this.quote(input.name)
    if (
      (this.type === 'postgresql' && Buffer.byteLength(input.name) > 63) ||
      (this.type === 'mysql' && [...input.name].length > 64)
    )
      throw new Error('字段名称超过数据库长度限制')
    const base = 'ALTER TABLE ' + this.tableName(table)
    let sql: string
    let sqlMode: string | undefined
    let strictMode: string | undefined
    if (input.kind === 'preview-add-column') {
      if (info.columns.includes(input.name)) throw new Error('字段名称已存在')
      if (typeof input.nullable !== 'boolean') throw new Error('可空参数无效')
      const columnType = this.columnType(input.type)
      sql = base + ' ADD COLUMN ' + name + ' ' + columnType + (input.nullable ? '' : ' NOT NULL')
      if (input.default !== undefined) {
        const result = await this.columnDefault(input.default, columnType)
        sqlMode = result.sqlMode
        sql += ' DEFAULT ' + result.literal
      }
    } else if (
      input.kind === 'preview-column-default' ||
      input.kind === 'preview-column-type' ||
      input.kind === 'preview-column-nullable'
    ) {
      if (!info.columns.includes(input.name)) throw new Error('字段不存在，请刷新')
      if (this.type === 'sqlite') {
        let change: SqliteColumnChange
        if (input.kind === 'preview-column-type') {
          if (typeof input.convert !== 'boolean') throw new Error('类型转换参数无效')
          change = {
            kind: 'type',
            column: input.name,
            type: this.columnType(input.type),
            convert: input.convert,
          }
        } else if (input.kind === 'preview-column-nullable') {
          if (typeof input.nullable !== 'boolean') throw new Error('可空参数无效')
          change = { kind: 'nullable', column: input.name, nullable: input.nullable }
        } else
          change = {
            kind: 'default',
            column: input.name,
            ...(input.default === undefined
              ? {}
              : { defaultSql: (await this.columnDefault(input.default, '')).literal }),
          }
        return this.sqlitePreview(table, info, change)
      }
      const original = info.columnInfo.rows.find((row) => row[0] === input.name)!
      if (input.kind === 'preview-column-default') {
        sql = base + ' ALTER COLUMN ' + name
        if (input.default === undefined) sql += ' DROP DEFAULT'
        else {
          const result = await this.columnDefault(input.default, String(original[1]).toUpperCase())
          sqlMode = result.sqlMode
          sql += ' SET DEFAULT ' + result.literal
        }
      } else if (this.type === 'postgresql') {
        if (input.kind === 'preview-column-type') {
          if (typeof input.convert !== 'boolean') throw new Error('类型转换参数无效')
          const type = this.columnType(input.type)
          sql =
            base +
            ' ALTER COLUMN ' +
            name +
            ' TYPE ' +
            type +
            (input.convert ? ' USING ' + name + '::' + type : '')
        } else {
          if (typeof input.nullable !== 'boolean') throw new Error('可空参数无效')
          sql =
            base + ' ALTER COLUMN ' + name + (input.nullable ? ' DROP NOT NULL' : ' SET NOT NULL')
        }
      } else {
        if (input.kind === 'preview-column-type' && input.convert !== false)
          throw new Error('MySQL 不支持 PostgreSQL 显式转换选项')
        if (input.kind === 'preview-column-nullable' && typeof input.nullable !== 'boolean')
          throw new Error('可空参数无效')
        const mode = await this.query('SELECT @@sql_mode')
        if (typeof mode.rows[0]?.[0] !== 'string') throw new Error('无法读取 MySQL SQL 模式')
        sqlMode = String(mode.rows[0][0])
        if (!/^[A-Z0-9_,]*$/i.test(sqlMode)) throw new Error('MySQL SQL 模式格式无效')
        if (!sqlMode.split(',').includes('STRICT_ALL_TABLES'))
          strictMode = [...sqlMode.split(',').filter(Boolean), 'STRICT_ALL_TABLES'].join(',')
        const definition = rewriteMysqlColumn(
          info.objectDefinition,
          input.name,
          String(original[1]),
          input.kind === 'preview-column-type'
            ? { type: this.columnType(input.type) }
            : { nullable: input.nullable },
          sqlMode.split(',').includes('NO_BACKSLASH_ESCAPES'),
        )
        sql = base + ' MODIFY COLUMN ' + definition
      }
    } else if (input.kind === 'preview-rename-column') {
      if (!info.columns.includes(input.column)) throw new Error('原字段不存在，请刷新')
      if (info.columns.includes(input.name)) throw new Error('字段名称已存在')
      sql = base + ' RENAME COLUMN ' + this.quote(input.column) + ' TO ' + name
    } else {
      if (!info.columns.includes(input.name)) throw new Error('字段不存在，请刷新')
      if (info.columns.length <= 1) throw new Error('不能删除最后一个字段')
      sql = base + ' DROP COLUMN ' + name
    }
    return this.preview(table, info, sql, sqlMode, strictMode)
  }
  async request(input: SchemaRequest): Promise<SchemaResponse> {
    if (!input || typeof input !== 'object') throw new Error('结构请求无效')
    for (const [token, plan] of this.plans)
      if (Date.now() - plan.created > 300000) this.plans.delete(token)
    if (input.kind === 'commit') {
      const plan = this.plans.get(input.token)
      if (!plan) throw new Error('结构预览已过期，请重新预览')
      this.plans.delete(input.token)
      if (
        plan.sqlMode !== undefined &&
        (await this.query('SELECT @@sql_mode')).rows[0]?.[0] !== plan.sqlMode
      )
        throw new Error('SQL 模式已变化，请重新预览')
      if (this.signature(await this.inspect(plan.table)) !== plan.signature)
        throw new Error('数据库结构已变化，请刷新并重新预览')
      if (
        plan.reference &&
        this.signature(await this.inspect(plan.reference.table)) !== plan.reference.signature
      )
        throw new Error('目标表结构已变化，请重新预览')
      if (plan.mysqlForeignCheck && plan.reference)
        await this.assertMysqlForeignKeyContext(plan.table, plan.reference.table)
      if (plan.sqliteToken) {
        if (!this.sqliteRebuild) throw new Error('重建表预览已过期')
        return this.sqliteRebuild.commit(plan.sqliteToken)
      }
      if (plan.strictMode) {
        await this.query('SET SESSION sql_mode=?', [plan.strictMode])
        try {
          await this.query(plan.sql)
        } finally {
          try {
            await this.query('SET SESSION sql_mode=?', [plan.sqlMode!])
          } catch {
            throw new Error('无法恢复原 SQL 模式，结构变更结果需核对；请重新连接')
          }
        }
      } else await this.query(plan.sql)
      return { kind: 'schema-applied' }
    }
    if (
      ![
        'inspect',
        'foreign-keys',
        'preview-create-foreign-key',
        'preview-drop-foreign-key',
        'preview-create-index',
        'preview-drop-index',
        'preview-add-column',
        'preview-rename-column',
        'preview-drop-column',
        'preview-column-default',
        'preview-column-type',
        'preview-column-nullable',
      ].includes(input.kind)
    )
      throw new Error('结构操作无效')
    const table = { schema: input.table?.schema, name: input.table?.name },
      info = await this.inspect(table)
    if (input.kind === 'inspect') return info
    if (input.kind === 'foreign-keys')
      return { kind: 'foreign-keys', keys: await this.foreignKeys(table, info) }
    if (input.kind === 'preview-create-foreign-key' || input.kind === 'preview-drop-foreign-key')
      return this.foreignPreview(input, table, info)
    if (input.kind !== 'preview-create-index' && input.kind !== 'preview-drop-index')
      return this.columnPreview(input, table, info)
    const name = this.quote(input.name)
    if (
      (this.type === 'postgresql' && Buffer.byteLength(input.name) > 63) ||
      (this.type === 'mysql' && [...input.name].length > 64)
    )
      throw new Error('索引名称超过数据库长度限制')
    let sql: string
    if (input.kind === 'preview-create-index') {
      if (!info.canCreateIndex) throw new Error('此对象不支持创建索引')
      if (
        typeof input.unique !== 'boolean' ||
        !Array.isArray(input.columns) ||
        !input.columns.length ||
        input.columns.length > 32 ||
        new Set(input.columns.map((column) => column.name)).size !== input.columns.length ||
        input.columns.some(
          (column) => !info.columns.includes(column.name) || typeof column.descending !== 'boolean',
        )
      )
        throw new Error('索引字段无效或重复')
      if (info.indexes.some((index) => index.name === input.name)) throw new Error('索引名称已存在')
      sql =
        'CREATE ' +
        (input.unique ? 'UNIQUE ' : '') +
        'INDEX ' +
        (this.type === 'sqlite' ? this.quote(table.schema) + '.' : '') +
        name +
        ' ON ' +
        (this.type === 'sqlite' ? this.quote(table.name) : this.tableName(table)) +
        ' (' +
        input.columns
          .map((column) => this.quote(column.name) + (column.descending ? ' DESC' : ' ASC'))
          .join(', ') +
        ')'
    } else {
      const index = info.indexes.find((index) => index.name === input.name)
      if (!index) throw new Error('索引不存在，请刷新')
      if (index.protected) throw new Error('此索引由主键或约束维护，不能作为普通索引删除')
      sql =
        'DROP INDEX ' +
        (this.type === 'mysql'
          ? name + ' ON ' + this.tableName(table)
          : this.quote(table.schema) + '.' + name)
    }
    return this.preview(table, info, sql)
  }
}
