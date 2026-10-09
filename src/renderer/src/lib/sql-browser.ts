import type { ConnectionType } from '../../../shared/contracts'
export interface SqlObject {
  schema: string
  name: string
  kind: string
}
function dialect(type: ConnectionType) {
  if (!['sqlite', 'mysql', 'postgresql'].includes(type))
    throw new Error('此连接不支持 SQL 对象浏览')
}
function identifier(value: string, mysql: boolean) {
  if (!value || value.includes('\0')) throw new Error('数据库对象名称无效')
  const quote = mysql ? '`' : '"'
  return quote + value.split(quote).join(quote + quote) + quote
}
function literal(value: string, type: ConnectionType) {
  if (type === 'mysql')
    return (
      'CONVERT(0x' +
      Array.from(new TextEncoder().encode(value), (b) => b.toString(16).padStart(2, '0')).join('') +
      ' USING utf8mb4)'
    )
  if (type === 'postgresql')
    return "E'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'"
  return "'" + value.replaceAll("'", "''") + "'"
}
export function schemasSql(type: ConnectionType): string {
  dialect(type)
  if (type === 'sqlite') return 'SELECT name AS schema_name FROM pragma_database_list'
  if (type === 'mysql')
    return 'SELECT SCHEMA_NAME AS schema_name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME'
  return "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema') ORDER BY schema_name"
}
export function objectsSql(type: ConnectionType, schema?: string): string {
  dialect(type)
  if (type === 'sqlite')
    return (
      'SELECT ' +
      literal(schema || 'main', type) +
      ' AS schema_name, name, type AS kind FROM ' +
      identifier(schema || 'main', false) +
      ".sqlite_schema WHERE type IN ('table','view') AND name NOT GLOB 'sqlite_*' ORDER BY type,name"
    )
  if (type === 'mysql')
    return (
      'SELECT TABLE_SCHEMA AS schema_name,TABLE_NAME AS name,TABLE_TYPE AS kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=' +
      (schema ? literal(schema, type) : 'DATABASE()') +
      ' ORDER BY TABLE_TYPE,TABLE_NAME'
    )
  return (
    'SELECT table_schema AS schema_name,table_name AS name,table_type AS kind FROM information_schema.tables WHERE ' +
    (schema
      ? 'table_schema=' + literal(schema, type)
      : "table_schema NOT IN ('pg_catalog','information_schema')") +
    ' ORDER BY table_schema,table_type,table_name'
  )
}
export function columnsSql(type: ConnectionType, object: SqlObject): string {
  dialect(type)
  if (type === 'sqlite')
    return (
      'PRAGMA ' +
      identifier(object.schema, false) +
      '.table_xinfo(' +
      literal(object.name, type) +
      ')'
    )
  return (
    'SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=' +
    literal(object.schema, type) +
    ' AND table_name=' +
    literal(object.name, type) +
    ' ORDER BY ordinal_position'
  )
}
export function qualifiedName(type: ConnectionType, object: SqlObject): string {
  dialect(type)
  return (
    identifier(object.schema, type === 'mysql') + '.' + identifier(object.name, type === 'mysql')
  )
}
export function countSql(type: ConnectionType, object: SqlObject): string {
  return 'SELECT COUNT(*) AS count FROM ' + qualifiedName(type, object) + ';'
}
export function previewSql(type: ConnectionType, object: SqlObject): string {
  return 'SELECT * FROM ' + qualifiedName(type, object) + ' LIMIT 1000;'
}
