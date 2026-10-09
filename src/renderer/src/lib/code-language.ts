import { LanguageSupport, StreamLanguage } from '@codemirror/language'
import { sql } from '@codemirror/lang-sql'
import {
  sqlCompletionConfig,
  safeSchemaCompletionSource,
  type SqlCompletionTable,
} from './sql-completion'
export type CodeLanguage = 'sqlite' | 'mysql' | 'postgresql' | 'redis' | 'json'
const redis = StreamLanguage.define({
  startState: () => ({ first: true }),
  token(stream, state) {
    if (stream.sol()) state.first = true
    if (stream.eatSpace()) return null
    if (state.first) {
      state.first = false
      stream.eatWhile(/[^\s]/)
      return 'keyword'
    }
    const quote = stream.peek()
    if (quote === '"' || quote === "'") {
      stream.next()
      let escaped = false,
        char: string | void
      while ((char = stream.next()) !== undefined) {
        if (!escaped && char === quote) break
        if (!escaped && char === '\\') escaped = true
        else escaped = false
      }
      return 'string'
    }
    if (stream.match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?=\s|$)/i)) return 'number'
    stream.eatWhile(/[^\s]/)
    return 'variableName'
  },
})
const json = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return 'string'
    if (stream.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return 'number'
    if (stream.match(/^(?:true|false)\b/)) return 'bool'
    if (stream.match(/^null\b/)) return 'null'
    if (stream.match(/^[{}[\],:]/)) return 'punctuation'
    stream.next()
    return null
  },
})
export function codeLanguage(language: CodeLanguage, tables: readonly SqlCompletionTable[] = []) {
  if (language === 'json') return json
  if (language === 'redis') return redis
  const config = sqlCompletionConfig(language, tables)
  const support = sql({ ...config, schema: undefined })
  return new LanguageSupport(support.language, [
    support.support,
    support.language.data.of({ autocomplete: safeSchemaCompletionSource(config) }),
  ])
}
