import type { QueryResult, SqlBatchResult } from './contracts'
export type SqlDialect = 'sqlite' | 'mysql' | 'postgresql'
export function splitSqlScript(sql: string, dialect: SqlDialect): string[] {
  if (typeof sql !== 'string' || !sql.trim() || new TextEncoder().encode(sql).length > 1024 * 1024)
    throw new Error('SQL为空或超过1 MiB')
  const result: string[] = []
  let start = 0,
    quote = '',
    dollar = '',
    comment = '',
    commentDepth = 0,
    content = false,
    block = 0,
    escape = false
  let words: string[] = []
  function finish(end: number) {
    if (content) result.push(sql.slice(start, end).trim())
    start = end
    content = false
    words = []
    if (result.length > 100) throw new Error('脚本最多100条语句')
  }
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!,
      next = sql[i + 1]
    if (comment === 'line') {
      if (c === '\n') comment = ''
      continue
    }
    if (comment === 'block') {
      if (dialect === 'postgresql' && c === '/' && next === '*') {
        commentDepth++
        i++
      } else if (c === '*' && next === '/') {
        commentDepth--
        i++
        if (!commentDepth) comment = ''
      }
      continue
    }
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        i += dollar.length - 1
        dollar = ''
      }
      continue
    }
    if (quote) {
      if (escape && c === '\\') {
        i++
        continue
      }
      if (c === quote) {
        if (next === quote && quote !== ']') i++
        else quote = ''
      }
      continue
    }
    if (
      c === '-' &&
      next === '-' &&
      (dialect !== 'mysql' || (next !== undefined && /\s/.test(sql[i + 2] || ' ')))
    ) {
      comment = 'line'
      i++
      continue
    }
    if (dialect === 'mysql' && c === '#') {
      comment = 'line'
      continue
    }
    if (c === '/' && next === '*') {
      if (dialect === 'mysql' && sql[i + 2] === '!')
        throw new Error('脚本不支持MySQL可执行注释，请单独执行')
      comment = 'block'
      commentDepth = 1
      i++
      continue
    }
    if (dialect === 'postgresql' && c === '$') {
      const match = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)
      if (match) {
        dollar = match[0]
        i += dollar.length - 1
        content = true
        continue
      }
    }
    if (c === "'" || c === '"' || c === '`' || (dialect === 'sqlite' && c === '[')) {
      quote = c === '[' ? ']' : c
      escape =
        dialect === 'mysql' ||
        (dialect === 'postgresql' &&
          c === "'" &&
          /[eE]/.test(sql[i - 1] || '') &&
          !/[\w]/.test(sql[i - 2] || ''))
      content = true
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let end = i + 1
      while (end < sql.length && /[A-Za-z_0-9]/.test(sql[end]!)) end++
      const word = sql.slice(i, end).toUpperCase()
      words.push(word)
      if (
        dialect === 'mysql' &&
        (word === 'DELIMITER' ||
          (words[0] === 'CREATE' &&
            ['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT'].includes(word) &&
            !words.includes('TABLE')))
      )
        throw new Error('脚本暂不支持MySQL DELIMITER或存储程序，请单独执行')
      const trigger =
        dialect === 'sqlite' &&
        words[0] === 'CREATE' &&
        (words[1] === 'TRIGGER' ||
          (['TEMP', 'TEMPORARY'].includes(words[1] || '') && words[2] === 'TRIGGER'))
      if (trigger && word === 'BEGIN') block++
      else if (block && word === 'CASE') block++
      else if (block && word === 'END') block--
      if (dialect === 'postgresql' && word === 'ATOMIC' && words.at(-2) === 'BEGIN')
        throw new Error('请使用美元引号函数体，暂不支持BEGIN ATOMIC脚本拆分')
      i = end - 1
      content = true
      continue
    }
    if (c === ';' && !block) {
      finish(i + 1)
      continue
    }
    if (!/\s/.test(c)) content = true
  }
  if (quote || dollar || comment === 'block' || block)
    throw new Error('SQL含未闭合的引号、注释或语句块')
  finish(sql.length)
  if (!result.length) throw new Error('脚本没有可执行语句')
  return result
}
export async function runSqlScript(
  sql: string,
  dialect: SqlDialect,
  execute: (sql: string) => Promise<QueryResult>,
): Promise<SqlBatchResult> {
  const statements = splitSqlScript(sql, dialect),
    start = performance.now()
  const batch: SqlBatchResult = { results: [], elapsedMs: 0 }
  let bytes = 0
  const budget = 16 * 1024 * 1024 - 1024
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  for (let index = 0; index < statements.length; index++) {
    if (budget - bytes < 1024) {
      batch.notice = '脚本结果累计达到16 MiB，后续语句未执行'
      break
    }
    try {
      const result = await execute(statements[index]!)
      const entry = { index: index + 1, sql: statements[index]!, result }
      const remaining = budget - bytes
      if (size(entry) > remaining) {
        entry.result = { ...result, rows: [], truncated: true }
        if (size(entry) > remaining) {
          entry.result.columns = []
          entry.sql = ''
        }
        let retained = size(entry)
        for (const row of entry.result.columns.length === result.columns.length
          ? result.rows
          : []) {
          const rowBytes = size(row) + 1
          if (retained + rowBytes > remaining) break
          entry.result.rows.push(row)
          retained += rowBytes
        }
        batch.results.push(entry)
        batch.notice = `第 ${index + 1} 条语句已执行，当前结果因16 MiB累计上限截断；${index + 1 < statements.length ? '后续语句未执行' : '脚本已执行完成'}`
        break
      }
      bytes += size(entry) + 1
      batch.results.push(entry)
    } catch (e) {
      batch.error = (e instanceof Error ? e.message : 'SQL执行失败').slice(0, 512)
      batch.failedIndex = index + 1
      break
    }
  }
  batch.elapsedMs = Math.round(performance.now() - start)
  return batch
}
