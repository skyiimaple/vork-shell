interface Token {
  start: number
  end: number
  text: string
}
function quotedEnd(sql: string, start: number, noBackslash: boolean): number {
  const quote = sql[start]!
  for (let index = start + 1; index < sql.length; index++) {
    if (sql[index] === '\\' && quote !== '`' && !noBackslash) {
      index++
      continue
    }
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index++
        continue
      }
      return index + 1
    }
  }
  throw new Error('字段原定义包含未结束的引号')
}
function commentEnd(sql: string, index: number) {
  if (sql.startsWith('/*', index)) {
    const end = sql.indexOf('*/', index + 2)
    if (end < 0) throw new Error('字段原定义注释不完整')
    return end + 2
  }
  if (sql[index] === '#' || (sql.startsWith('--', index) && /\s/.test(sql[index + 2] || ''))) {
    const end = sql.indexOf('\n', index)
    return end < 0 ? sql.length : end + 1
  }
  return index
}
function definitions(sql: string, noBackslash: boolean) {
  const parts: string[] = []
  let depth = 0,
    start = -1
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!
    if (['`', "'", '"'].includes(char)) {
      index = quotedEnd(sql, index, noBackslash) - 1
      continue
    }
    const end = commentEnd(sql, index)
    if (end !== index) {
      index = end - 1
      continue
    }
    if (char === '(') {
      depth++
      if (depth === 1) start = index + 1
    } else if (char === ')') {
      depth--
      if (depth === 0 && start >= 0) {
        parts.push(sql.slice(start, index).trim())
        return parts
      }
      if (depth < 0) break
    } else if (char === ',' && depth === 1) {
      parts.push(sql.slice(start, index).trim())
      start = index + 1
    }
  }
  throw new Error('无法解析数据库返回的建表定义')
}
function words(sql: string, noBackslash: boolean): Token[] {
  const tokens: Token[] = []
  let depth = 0
  for (let index = 0; index < sql.length;) {
    const char = sql[index]!
    if (/\s/.test(char)) {
      index++
      continue
    }
    if (['`', "'", '"'].includes(char)) {
      const end = quotedEnd(sql, index, noBackslash)
      if (!depth) tokens.push({ start: index, end, text: sql.slice(index, end) })
      index = end
      continue
    }
    const end = commentEnd(sql, index)
    if (end !== index) {
      index = end
      continue
    }
    if (char === '(') {
      depth++
      index++
      continue
    }
    if (char === ')') {
      depth--
      index++
      continue
    }
    const match = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(sql.slice(index))
    if (match) {
      if (!depth)
        tokens.push({ start: index, end: index + match[0].length, text: match[0].toUpperCase() })
      index += match[0].length
    } else index++
  }
  return tokens
}
/** Reuses the database's full column clause so unedited attributes survive MODIFY COLUMN. */
export function rewriteMysqlColumn(
  ddl: string,
  name: string,
  originalType: string,
  change: { type?: string; nullable?: boolean },
  noBackslash: boolean,
): string {
  if (ddl.length > 4 * 1024 * 1024) throw new Error('建表定义超过读取上限')
  for (const part of definitions(ddl, noBackslash)) {
    let end: number, field: string
    if (part[0] === '`') {
      end = quotedEnd(part, 0, noBackslash)
      field = part.slice(1, end - 1).replaceAll('``', '`')
    } else {
      const match = /^[\p{L}\p{N}_$]+/u.exec(part)
      if (!match) continue
      end = match[0].length
      field = match[0]
    }
    if (field !== name) continue
    const rest = part.slice(end),
      escaped = originalType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    const match = new RegExp('^\\s*' + escaped + '(?=\\s|$)', 'i').exec(rest)
    if (!match) throw new Error('字段原类型与建表定义不一致，无法保留属性，请刷新')
    let tail = rest.slice(match[0].length)
    if (change.nullable !== undefined) {
      const tokens = words(tail, noBackslash)
      let range: { start: number; end: number } | undefined
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!
        if (token.text === 'NOT' && tokens[index + 1]?.text === 'NULL') {
          range = { start: token.start, end: tokens[index + 1]!.end }
          break
        }
        if (token.text === 'NULL' && tokens[index - 1]?.text !== 'DEFAULT') {
          range = token
          break
        }
      }
      const clause = change.nullable ? 'NULL' : 'NOT NULL'
      if (range) tail = tail.slice(0, range.start) + clause + tail.slice(range.end)
      else {
        let index = 0
        if (tokens[0]?.text === 'CHARACTER' && tokens[1]?.text === 'SET' && tokens[2]) index = 3
        if (tokens[index]?.text === 'COLLATE' && tokens[index + 1]) index += 2
        const position = index ? tokens[index - 1]!.end : 0
        tail = tail.slice(0, position) + ' ' + clause + tail.slice(position)
      }
    }
    return part.slice(0, end) + ' ' + (change.type ?? rest.slice(0, match[0].length).trim()) + tail
  }
  throw new Error('数据库返回的建表定义中未找到字段')
}
