import { randomUUID, createHash } from 'node:crypto'
import type { Cell, DataTable, QueryResult } from '../shared/contracts'
import { assertSingleStatement } from './validation'
type Query = (sql: string, parameters?: Cell[]) => Promise<QueryResult>
export type SqliteColumnChange =
  | { kind: 'default'; column: string; defaultSql?: string }
  | { kind: 'nullable'; column: string; nullable: boolean }
  | { kind: 'type'; column: string; type: string; convert: boolean }
  | { kind: 'add-foreign-key'; name: string; definition: string; column?: never }
  | { kind: 'drop-foreign-key'; key: string; column?: never }
interface Token {
  start: number
  end: number
  text: string
  kind: 'word' | 'quoted' | 'group' | 'other'
}
function quotedEnd(sql: string, start: number) {
  const endChar = sql[start] === '[' ? ']' : sql[start]!
  for (let i = start + 1; i < sql.length; i++)
    if (sql[i] === endChar) {
      if (endChar !== ']' && sql[i + 1] === endChar) {
        i++
        continue
      }
      return i + 1
    }
  throw Error('建表定义引号不完整')
}
function skipComment(sql: string, start: number) {
  if (sql.startsWith('--', start)) {
    const end = sql.indexOf('\n', start)
    return end < 0 ? sql.length : end + 1
  }
  if (sql.startsWith('/*', start)) {
    const end = sql.indexOf('*/', start + 2)
    if (end < 0) throw Error('建表定义注释不完整')
    return end + 2
  }
  return start
}
function groupEnd(sql: string, start: number) {
  let depth = 1
  for (let i = start + 1; i < sql.length; i++) {
    if (['"', "'", '`', '['].includes(sql[i]!)) {
      i = quotedEnd(sql, i) - 1
      continue
    }
    const comment = skipComment(sql, i)
    if (comment !== i) {
      i = comment - 1
      continue
    }
    if (sql[i] === '(') depth++
    else if (sql[i] === ')' && !--depth) return i + 1
  }
  throw Error('建表定义括号不完整')
}
function tokens(sql: string): Token[] {
  const result: Token[] = []
  for (let i = 0; i < sql.length;) {
    if (/\s/.test(sql[i]!)) {
      i++
      continue
    }
    const comment = skipComment(sql, i)
    if (comment !== i) {
      i = comment
      continue
    }
    let end = i + 1,
      kind: Token['kind'] = 'other'
    if (['"', "'", '`', '['].includes(sql[i]!)) {
      end = quotedEnd(sql, i)
      kind = 'quoted'
    } else if (sql[i] === '(') {
      end = groupEnd(sql, i)
      kind = 'group'
    } else {
      const match =
        /^(?:0x[\da-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[\p{L}_$][\p{L}\p{N}_$]*)/iu.exec(
          sql.slice(i),
        )
      if (match) {
        end = i + match[0].length
        kind = 'word'
      }
    }
    result.push({ start: i, end, text: sql.slice(i, end), kind })
    i = end
  }
  return result
}
function word(token: Token | undefined, value: string) {
  return token?.kind === 'word' && token.text.toUpperCase() === value
}
function identifier(token: Token) {
  if (token.kind !== 'quoted') return token.text
  if (token.text[0] === '[') return token.text.slice(1, -1)
  const quote = token.text[0]!
  return token.text.slice(1, -1).replaceAll(quote + quote, quote)
}
function quote(name: string) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.length > 256)
    throw Error('数据库对象名称无效')
  return '"' + name.replaceAll('"', '""') + '"'
}
function editDefinition(
  part: string,
  change: Exclude<SqliteColumnChange, { kind: 'add-foreign-key' | 'drop-foreign-key' }>,
) {
  const list = tokens(part),
    first = list[0]!
  if (identifier(first) !== change.column) return part
  if (change.kind === 'type') {
    const constraint = list
      .slice(1)
      .find(
        (token) =>
          token.kind === 'word' &&
          [
            'CONSTRAINT',
            'PRIMARY',
            'NOT',
            'UNIQUE',
            'CHECK',
            'DEFAULT',
            'COLLATE',
            'REFERENCES',
            'GENERATED',
            'AS',
          ].includes(token.text.toUpperCase()),
      )
    const end = constraint?.start ?? list.at(-1)!.end
    return part.slice(0, first.end) + ' ' + change.type + ' ' + part.slice(end)
  }
  const keyword = change.kind === 'default' ? 'DEFAULT' : 'NOT'
  let index = list.findIndex(
    (token, i) =>
      i > 0 && word(token, keyword) && (change.kind !== 'nullable' || word(list[i + 1], 'NULL')),
  )
  if (index < 0)
    return change.kind === 'default'
      ? change.defaultSql === undefined
        ? part
        : part + '\n DEFAULT ' + change.defaultSql
      : change.nullable
        ? part
        : part + '\n NOT NULL'
  const begin = list[index]!.start
  if (change.kind === 'default') {
    let value = index + 1
    if (list[value]?.text === '+' || list[value]?.text === '-') value++
    if (word(list[value], 'X') && list[value + 1]?.kind === 'quoted') value++
    if (!list[value]) throw Error('默认值定义不完整')
    const end = list[value]!.end
    if (change.defaultSql !== undefined)
      return part.slice(0, begin) + 'DEFAULT ' + change.defaultSql + part.slice(end)
    if (index >= 2 && word(list[index - 2], 'CONSTRAINT')) index -= 2
    return part.slice(0, list[index]!.start) + part.slice(end)
  }
  if (!change.nullable) return part
  let last = index + 1
  if (word(list[last + 1], 'ON') && word(list[last + 2], 'CONFLICT') && list[last + 3]) last += 3
  if (index >= 2 && word(list[index - 2], 'CONSTRAINT')) index -= 2
  return part.slice(0, list[index]!.start) + part.slice(list[last]!.end)
}
function tableParts(source: string) {
  assertSingleStatement(source)
  const list = tokens(source),
    body = list.find((token) => token.kind === 'group')
  if (!body || !word(list[0], 'CREATE') || !list.some((token) => word(token, 'TABLE')))
    throw Error('无法解析建表定义')
  const contents = source.slice(body.start + 1, body.end - 1),
    parts: string[] = []
  let start = 0
  for (const comma of [
    ...tokens(contents).filter((token) => token.kind === 'other' && token.text === ','),
    { start: contents.length, end: contents.length },
  ]) {
    parts.push(contents.slice(start, comma.start))
    start = comma.end
  }
  return { body, parts }
}
export interface SqliteForeignKeyClause {
  key: string
  name?: string
  fromColumns: string[]
  toTable: string
  toColumns: string[]
  onUpdate: string
  onDelete: string
  definition: string
  partIndex: number
  start: number
  end: number
  whole: boolean
}
function fieldNames(token: Token | undefined) {
  if (token?.kind !== 'group') throw Error('外键字段列表无效')
  const fields = tokens(token.text.slice(1, -1)).filter((token) => token.text !== ',')
  if (!fields.length || fields.some((token) => !['word', 'quoted'].includes(token.kind)))
    throw Error('外键字段列表无效')
  return fields.map(identifier)
}
export function sqliteForeignKeyClauses(source: string): SqliteForeignKeyClause[] {
  const { parts } = tableParts(source),
    result: SqliteForeignKeyClause[] = []
  parts.forEach((part, partIndex) => {
    const list = tokens(part),
      first = list[0]
    if (!first) throw Error('字段定义为空')
    const begin = word(first, 'CONSTRAINT') ? 2 : 0,
      whole = word(list[begin], 'FOREIGN') && word(list[begin + 1], 'KEY')
    const isTableConstraint =
      whole ||
      (first.kind === 'word' &&
        ['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK'].includes(first.text.toUpperCase()))
    if (isTableConstraint && !whole) return
    for (let index = 0; index < list.length; index++) {
      if (!word(list[index], 'REFERENCES')) continue
      if (whole && index !== begin + 3) throw Error('外键定义无法解析')
      const fromColumns = whole ? fieldNames(list[begin + 2]) : [identifier(first)]
      const target = list[index + 1]
      if (!target || !['word', 'quoted'].includes(target.kind)) throw Error('外键目标无效')
      const toTable = identifier(target)
      let position = index + 2,
        toColumns: string[] = []
      if (list[position]?.kind === 'group') {
        toColumns = fieldNames(list[position])
        position++
      }
      let onUpdate = 'NO ACTION',
        onDelete = 'NO ACTION'
      while (position < list.length) {
        if (
          word(list[position], 'ON') &&
          (word(list[position + 1], 'UPDATE') || word(list[position + 1], 'DELETE'))
        ) {
          const operation = list[position + 1]!.text.toUpperCase(),
            rule = list[position + 2]?.text.toUpperCase()
          let value = rule,
            count = 3
          if (rule === 'SET' || rule === 'NO') {
            value = rule + ' ' + list[position + 3]?.text.toUpperCase()
            count = 4
          }
          if (
            !['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT'].includes(value || '')
          )
            throw Error('外键规则无法解析')
          if (operation === 'UPDATE') onUpdate = value!
          else onDelete = value!
          position += count
        } else if (word(list[position], 'MATCH') && list[position + 1]) position += 2
        else if (word(list[position], 'NOT') && word(list[position + 1], 'DEFERRABLE'))
          position += 2
        else if (word(list[position], 'DEFERRABLE')) position++
        else if (
          word(list[position], 'INITIALLY') &&
          (word(list[position + 1], 'DEFERRED') || word(list[position + 1], 'IMMEDIATE'))
        )
          position += 2
        else break
      }
      const named = whole
        ? word(first, 'CONSTRAINT')
          ? identifier(list[1]!)
          : undefined
        : word(list[index - 2], 'CONSTRAINT')
          ? identifier(list[index - 1]!)
          : undefined
      const start = whole ? 0 : list[named ? index - 2 : index]!.start,
        end = whole ? part.length : list[position - 1]!.end
      const key =
        'sqlite-fk:' +
        createHash('sha256')
          .update(source + '\0' + partIndex + '\0' + start)
          .digest('hex')
      result.push({
        key,
        name: named,
        fromColumns,
        toTable,
        toColumns,
        onUpdate,
        onDelete,
        definition: part.slice(start, end).trim(),
        partIndex,
        start,
        end,
        whole,
      })
      index = position - 1
    }
  })
  return result
}
function createSql(source: string, schema: string, name: string, change: SqliteColumnChange) {
  const { body, parts } = tableParts(source)
  if (change.kind === 'add-foreign-key') {
    const names = parts.flatMap((part) => {
      const list = tokens(part)
      return list.flatMap((token, index) =>
        word(token, 'CONSTRAINT') && list[index + 1] ? [identifier(list[index + 1]!)] : [],
      )
    })
    if (names.includes(change.name)) throw Error('约束名称已存在')
    parts.push(change.definition)
  } else if (change.kind === 'drop-foreign-key') {
    const target = sqliteForeignKeyClauses(source).find((key) => key.key === change.key)
    if (!target) throw Error('外键已变化，请刷新')
    if (target.whole) parts.splice(target.partIndex, 1)
    else {
      const part = parts[target.partIndex]!
      parts[target.partIndex] = part.slice(0, target.start) + part.slice(target.end)
    }
  } else {
    let found = false
    parts.forEach((part, index) => {
      const first = tokens(part)[0]
      if (!first) throw Error('字段定义为空')
      const constraint =
        first.kind === 'word' &&
        ['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(first.text.toUpperCase())
      if (!constraint && identifier(first) === change.column) {
        parts[index] = editDefinition(part, change)
        found = true
      }
    })
    if (!found) throw Error('建表定义中未找到字段')
  }
  const sql =
    'CREATE TABLE ' +
    quote(schema) +
    '.' +
    quote(name) +
    ' (\n' +
    parts.join('\n,\n') +
    '\n)' +
    source.slice(body.end)
  assertSingleStatement(sql)
  return sql
}
function auxiliarySql(sql: string, schema: string, name: string, kind: string) {
  assertSingleStatement(sql)
  const list = tokens(sql),
    index = list.findIndex((token) => word(token, kind.toUpperCase()))
  let position = index + 1
  if (index < 0) throw Error('索引或触发器定义无效')
  if (word(list[position], 'IF')) position += 3
  const first = list[position]
  if (!first) throw Error('索引或触发器名称缺失')
  let end = first.end
  if (list[position + 1]?.text === '.' && list[position + 2]) end = list[position + 2]!.end
  const result =
    'CREATE ' +
    (kind === 'index' && list.some((token) => word(token, 'UNIQUE')) ? 'UNIQUE ' : '') +
    kind.toUpperCase() +
    ' ' +
    quote(schema) +
    '.' +
    quote(name) +
    sql.slice(end)
  assertSingleStatement(result)
  return result
}
interface Snapshot {
  signature: string
  sql: string
  columns: Cell[][]
  objects: Cell[][]
  withoutRowid: boolean
}
interface Plan {
  table: DataTable
  change: SqliteColumnChange
  newName: string
  create: string
  copy: string
  tail: string[]
  snapshot: Snapshot
  foreign: number
  legacy: number
  created: number
  rowid?: string
}
export class SqliteRebuildService {
  private plans = new Map<string, Plan>()
  constructor(private query: Query) {}
  private qualified(table: DataTable) {
    return quote(table.schema) + '.' + quote(table.name)
  }
  private async flag(name: string) {
    const result = await this.query('PRAGMA ' + name),
      value = Number(result.rows[0]?.[0])
    if (![0, 1].includes(value)) throw Error('无法读取 SQLite ' + name)
    return value
  }
  private async snapshot(table: DataTable): Promise<Snapshot> {
    this.qualified(table)
    if (table.schema === 'temp') throw Error('临时表的重建尚未提供')
    const tableKind = await this.query(
      `PRAGMA ${quote(table.schema)}.table_list('${table.name.replaceAll("'", "''")}')`,
    )
    if (tableKind.rows.some((row) => row[2] === 'shadow'))
      throw Error('虚拟表的影子存储不能通过普通表重建编辑')
    const temporary = await this.query(
      "SELECT name FROM temp.sqlite_schema WHERE type='trigger' AND tbl_name=?",
      [table.name],
    )
    if (temporary.truncated || temporary.rows.length)
      throw Error('此表存在临时触发器，当前无法保证保留，请先处理临时触发器')
    const objects = await this.query(
      `SELECT type,name,tbl_name,sql FROM ${quote(table.schema)}.sqlite_schema ORDER BY type,name`,
    )
    const source = objects.rows.find((row) => row[0] === 'table' && row[1] === table.name)
    if (!source || typeof source[3] !== 'string' || /^CREATE\s+VIRTUAL/i.test(source[3]))
      throw Error('此对象不支持重建表')
    const columns = await this.query(
      `PRAGMA ${quote(table.schema)}.table_xinfo('${table.name.replaceAll("'", "''")}')`,
    )
    if (objects.truncated || columns.truncated || !columns.rows.length)
      throw Error('结构超过读取上限，无法验证重建表')
    return {
      signature: JSON.stringify([objects.rows, columns.rows]),
      sql: source[3],
      columns: columns.rows,
      objects: objects.rows,
      withoutRowid: tokens(
        source[3].slice(tokens(source[3]).find((token) => token.kind === 'group')!.end),
      ).some((token, index, list) => word(token, 'WITHOUT') && word(list[index + 1], 'ROWID')),
    }
  }
  async preview(table: DataTable, change: SqliteColumnChange) {
    const snapshot = await this.snapshot(table),
      field = snapshot.columns.find((row) => row[1] === change.column)
    if (!field && change.kind !== 'add-foreign-key' && change.kind !== 'drop-foreign-key')
      throw Error('字段不存在，请刷新')
    if (change.kind === 'nullable' && change.nullable && Number(field![5]) > 0)
      throw Error('主键字段不能设为可空')
    if (
      change.kind === 'type' &&
      (typeof change.convert !== 'boolean' || typeof change.type !== 'string')
    )
      throw Error('类型参数无效')
    if (change.kind === 'nullable' && typeof change.nullable !== 'boolean')
      throw Error('可空参数无效')
    if (change.kind === 'type' && Number(field![6]) !== 0) throw Error('生成字段的类型修改尚未提供')
    if (
      change.kind === 'type' &&
      Number(field![5]) > 0 &&
      change.type === 'INTEGER' &&
      String(field![2]).toUpperCase() !== 'INTEGER' &&
      !snapshot.withoutRowid
    )
      throw Error('此修改会改变 rowid 主键别名，当前需手动迁移')
    const foreign = await this.flag('foreign_keys'),
      legacy = await this.flag('legacy_alter_table')
    const newName = '__vork_rebuild_' + randomUUID().replaceAll('-', ''),
      newTable = { schema: table.schema, name: newName },
      names = snapshot.columns.filter((row) => Number(row[6]) === 0).map((row) => String(row[1]))
    const used = new Set(snapshot.columns.map((row) => String(row[1]).toLowerCase()))
    const rowid = snapshot.withoutRowid
      ? undefined
      : ['rowid', '_rowid_', 'oid'].find((name) => !used.has(name))
    if (!snapshot.withoutRowid && !rowid)
      throw Error('所有 rowid 别名均被字段遮蔽，无法保证原行标识')
    const copyNames = [...(rowid ? [rowid] : []), ...names]
    const create = createSql(snapshot.sql, table.schema, newName, change)
    const copy =
      'INSERT INTO ' +
      this.qualified(newTable) +
      ' (' +
      copyNames.map(quote).join(',') +
      ') SELECT ' +
      copyNames
        .map((name) =>
          change.kind === 'type' && change.convert && name === change.column
            ? 'CAST(' + quote(name) + ' AS ' + change.type + ')'
            : quote(name),
        )
        .join(',') +
      ' FROM ' +
      this.qualified(table)
    const tail = [
      'DROP TABLE ' + this.qualified(table),
      'ALTER TABLE ' + this.qualified(newTable) + ' RENAME TO ' + quote(table.name),
      ...snapshot.objects
        .filter(
          (row) =>
            row[2] === table.name &&
            ['index', 'trigger'].includes(String(row[0])) &&
            typeof row[3] === 'string',
        )
        .map((row) => auxiliarySql(String(row[3]), table.schema, String(row[1]), String(row[0]))),
    ]
    const token = randomUUID()
    this.plans.set(token, {
      table: { ...table },
      change: { ...change },
      newName,
      create,
      copy,
      tail,
      snapshot,
      foreign,
      legacy,
      created: Date.now(),
      rowid,
    })
    while (this.plans.size > 2) this.plans.delete(this.plans.keys().next().value!)
    return {
      kind: 'schema-preview' as const,
      token,
      sql:
        [
          '-- 重建步骤预览：校验和序列值在执行时读取；不是独立迁移脚本',
          `PRAGMA foreign_keys=OFF`,
          `PRAGMA legacy_alter_table=ON`,
          'BEGIN IMMEDIATE',
          create,
          copy,
          '-- 校验行数及未授权变化；不通过即回滚\n' + tail.join(';\n'),
          `PRAGMA ${quote(table.schema)}.foreign_key_check`,
          '-- 保留原 AUTOINCREMENT 序列高水位\nCOMMIT',
          `PRAGMA legacy_alter_table=${legacy}`,
          `PRAGMA foreign_keys=${foreign}`,
        ].join(';\n') + ';',
    }
  }
  private async checkForeign(table: DataTable) {
    const check = await this.query(`PRAGMA ${quote(table.schema)}.foreign_key_check`)
    if (check.truncated || check.rows.length)
      throw Error('数据库存在外键问题或检查超过上限，重建表已停止')
  }
  private async validateRows(plan: Plan) {
    const old = this.qualified(plan.table),
      next = this.qualified({ schema: plan.table.schema, name: plan.newName })
    const count = await this.query(
      `SELECT CAST((SELECT COUNT(*) FROM ${old}) AS TEXT),CAST((SELECT COUNT(*) FROM ${next}) AS TEXT)`,
    )
    if (count.rows[0]?.[0] !== count.rows[0]?.[1]) throw Error('复制行数不一致，已停止重建表')
    const converting = plan.change.kind === 'type' && plan.change.convert
    const columns = plan.snapshot.columns
      .filter((row) => !converting || (row[1] !== plan.change.column && Number(row[6]) === 0))
      .map((row) => String(row[1]))
    const keys = plan.rowid
      ? [plan.rowid]
      : plan.snapshot.columns
          .filter((row) => Number(row[5]) > 0 && (!converting || row[1] !== plan.change.column))
          .map((row) => String(row[1]))
    for (let start = 0; start < columns.length; start += 50) {
      const expressions = [
        ...keys.map((name) => quote(name) + ' COLLATE BINARY'),
        ...columns
          .slice(start, start + 50)
          .flatMap((name) => [quote(name) + ' COLLATE BINARY', 'typeof(' + quote(name) + ')']),
      ].join(',')
      const difference = await this.query(
        `SELECT 1 FROM (SELECT ${expressions} FROM ${old} EXCEPT SELECT ${expressions} FROM ${next}) LIMIT 1`,
      )
      if (difference.rows.length)
        throw Error('复制会改变未授权的原值；类型转换需要显式勾选后重新预览')
    }
  }
  async commit(token: string) {
    const plan = this.plans.get(token)
    this.plans.delete(token)
    if (!plan || Date.now() - plan.created > 300000) throw Error('重建表预览已过期，请重新预览')
    if (
      (await this.flag('foreign_keys')) !== plan.foreign ||
      (await this.flag('legacy_alter_table')) !== plan.legacy
    )
      throw Error('连接设置已变化，请重新预览')
    let transaction = false,
      committed = false
    try {
      await this.query('PRAGMA foreign_keys=OFF')
      if ((await this.flag('foreign_keys')) !== 0) throw Error('请先提交或回滚当前事务，再重建表')
      await this.query('PRAGMA legacy_alter_table=ON')
      await this.query('BEGIN IMMEDIATE')
      transaction = true
      if ((await this.snapshot(plan.table)).signature !== plan.snapshot.signature)
        throw Error('数据库结构已变化，请重新预览')
      let sequence: Cell | undefined
      if (plan.snapshot.objects.some((row) => row[0] === 'table' && row[1] === 'sqlite_sequence'))
        sequence = (
          await this.query(
            `SELECT CAST(seq AS TEXT) FROM ${quote(plan.table.schema)}.sqlite_sequence WHERE name=?`,
            [plan.table.name],
          )
        ).rows[0]?.[0]
      if (sequence !== undefined && (typeof sequence !== 'string' || !/^\d+$/.test(sequence)))
        throw Error('自增序列元数据无效')
      await this.query(plan.create)
      await this.query(plan.copy)
      await this.validateRows(plan)
      for (const sql of plan.tail) await this.query(sql)
      if (sequence !== undefined) {
        await this.query(
          `INSERT INTO ${quote(plan.table.schema)}.sqlite_sequence(name,seq) SELECT ?,CAST(? AS INTEGER) WHERE NOT EXISTS(SELECT 1 FROM ${quote(plan.table.schema)}.sqlite_sequence WHERE name=?)`,
          [plan.table.name, sequence, plan.table.name],
        )
        await this.query(
          `UPDATE ${quote(plan.table.schema)}.sqlite_sequence SET seq=MAX(seq,CAST(? AS INTEGER)) WHERE name=?`,
          [sequence, plan.table.name],
        )
      }
      await this.checkForeign(plan.table)
      await this.query('COMMIT')
      transaction = false
      committed = true
      return { kind: 'schema-applied' as const }
    } catch (error) {
      if (transaction) {
        try {
          await this.query('ROLLBACK')
          transaction = false
        } catch (rollbackError) {
          if (!(
            rollbackError instanceof Error &&
            /no transaction is active/i.test(rollbackError.message)
          ))
            throw Error('无法确认重建表回滚状态，请重新连接并核对数据')
        }
      }
      throw error
    } finally {
      try {
        await this.query('PRAGMA legacy_alter_table=' + plan.legacy)
        await this.query('PRAGMA foreign_keys=' + plan.foreign)
      } catch {
        throw Error(
          committed
            ? '结构已提交，但连接设置未能恢复，请重新连接'
            : '连接设置未能恢复，请重新连接并核对数据',
        )
      }
    }
  }
}
