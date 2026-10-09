export function formatSql(sql: string, dialect: 'sqlite' | 'mysql' | 'postgresql'): string {
  if (sql.trimStart().startsWith('.')) return sql
  const tokens: {
    text: string
    kind: 'word' | 'comment' | 'literal' | 'symbol'
    start: number
    end: number
  }[] = []
  const add = (
    text: string,
    kind: 'word' | 'comment' | 'literal' | 'symbol',
    start: number,
    end: number,
  ) => tokens.push({ text, kind, start, end })
  for (let i = 0; i < sql.length;) {
    if (/\s/.test(sql[i]!)) {
      i++
      continue
    }
    const start = i,
      char = sql[i]!
    if (sql.startsWith('--', i) || (dialect === 'mysql' && char === '#')) {
      while (i < sql.length && sql[i] !== '\n') i++
      add(sql.slice(start, i), 'comment', start, i)
      continue
    }
    if (sql.startsWith('/*', i)) {
      i += 2
      let depth = 1
      while (i < sql.length && depth) {
        if (dialect === 'postgresql' && sql.startsWith('/*', i)) {
          depth++
          i += 2
        } else if (sql.startsWith('*/', i)) {
          depth--
          i += 2
        } else i++
      }
      if (depth) throw new Error('注释未闭合，保留原 SQL')
      add(sql.slice(start, i), 'comment', start, i)
      continue
    }
    const dollar =
      dialect === 'postgresql' && char === '$'
        ? sql.slice(i).match(/^\$(?:[a-zA-Z_][\w]*)?\$/)?.[0]
        : undefined
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length)
      if (end < 0) throw new Error('Dollar 字符串未闭合')
      i = end + dollar.length
      add(sql.slice(start, i), 'literal', start, i)
      continue
    }
    if (["'", '"', '`', '['].includes(char)) {
      const endChar = char === '[' ? ']' : char
      const pgEscape =
        dialect === 'postgresql' &&
        /[eE]/.test(sql[i - 1] || '') &&
        (i < 2 || !/[\w]/.test(sql[i - 2]!))
      i++
      let closed = false
      while (i < sql.length) {
        if (sql[i] === '\\' && (dialect === 'mysql' || pgEscape)) {
          i += 2
          continue
        }
        if (sql[i] === endChar) {
          if (sql[i + 1] === endChar && endChar !== ']') {
            i += 2
            continue
          }
          i++
          closed = true
          break
        }
        i++
      }
      if (!closed) throw new Error('引号未闭合，保留原 SQL')
      // Prefixes such as E'...' and X'...' must remain adjacent.
      const previous = tokens.at(-1)
      if (
        char === "'" &&
        previous?.kind === 'word' &&
        /^(?:E|N|X|B)$/i.test(previous.text) &&
        previous.end === start
      ) {
        previous.text += sql.slice(start, i)
        previous.kind = 'literal'
        previous.end = i
      } else add(sql.slice(start, i), 'literal', start, i)
      continue
    }
    const word = sql
      .slice(i)
      .match(/^(?:[a-zA-Z_\u0080-\uffff][\w$\u0080-\uffff]*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0]
    if (word) {
      i += word.length
      add(word, 'word', start, i)
      continue
    }
    const operator =
      sql
        .slice(i)
        .match(
          /^(?:->>|->|::|<=|>=|<>|!=|==|\|\||&&|:=|!~\*|!~|~\*|<<|>>|@>|<@|\?\||\?&|#>>|#>)/,
        )?.[0] || char
    i += operator.length
    add(operator, 'symbol', start, i)
  }
  let output = '',
    depth = 0
  const line = () => {
    output = output.trimEnd() + '\n' + '  '.repeat(Math.max(0, depth))
  }
  const clauses = new Set([
    'select',
    'from',
    'where',
    'group',
    'order',
    'having',
    'limit',
    'offset',
    'join',
    'left',
    'right',
    'inner',
    'outer',
    'union',
    'returning',
    'values',
    'set',
  ])
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1],
      lower = token.text.toLowerCase()
    if (token.text === ')') depth = Math.max(0, depth - 1)
    if (
      token.kind === 'word' &&
      clauses.has(lower) &&
      output &&
      previous?.end !== token.start &&
      previous?.text !== '(' &&
      !['left', 'right', 'inner', 'outer', 'full', 'cross'].includes(
        previous?.text.toLowerCase() || '',
      )
    )
      line()
    if (token.kind === 'comment') {
      if (output && !output.endsWith('\n')) output += ' '
      output += token.text
      line()
      return
    }
    if (
      dialect === 'postgresql' &&
      token.kind === 'literal' &&
      previous?.kind === 'literal' &&
      /[\r\n]/.test(sql.slice(previous.end, token.start))
    )
      line()
    const tight =
      [',', ';', ')', '.', '::'].includes(token.text) ||
      ['.', '::', '('].includes(previous?.text || '')
    if (output && !/\s$/.test(output) && !tight && previous?.end !== token.start) output += ' '
    output += token.text
    if (token.text === '(') depth++
    if (token.text === ';' && index < tokens.length - 1) line()
  })
  return output.trim()
}
