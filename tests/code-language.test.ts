import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import { codeLanguage } from '../src/renderer/src/lib/code-language'
function tokens(doc: string, language: Parameters<typeof codeLanguage>[0]) {
  const state = EditorState.create({ doc, extensions: [codeLanguage(language)] })
  const result: { text: string; style: string }[] = []
  highlightTree(syntaxTree(state), classHighlighter, (from, to, style) =>
    result.push({ text: doc.slice(from, to), style }),
  )
  return result
}
describe('editor syntax languages', () => {
  it.each(['sqlite', 'mysql', 'postgresql'] as const)(
    'highlights %s keywords strings and comments',
    (language) => {
      const result = tokens("SELECT '中文 <script>' AS value, 42; -- note", language)
      expect(result.some((t) => t.text === 'SELECT' && t.style.includes('keyword'))).toBe(true)
      expect(
        result.some((t) => t.text.includes('中文 <script>') && t.style.includes('string')),
      ).toBe(true)
      expect(result.some((t) => t.text.includes('-- note') && t.style.includes('comment'))).toBe(
        true,
      )
    },
  )
  it('distinguishes Redis commands from keys, strings and numbers', () => {
    const result = tokens('SET select "hello \\"quoted\\" 中文" EX 60\nGET select', 'redis')
    expect(result.filter((t) => t.style.includes('keyword')).map((t) => t.text)).toEqual([
      'SET',
      'GET',
    ])
    expect(result.some((t) => t.text === '60' && t.style.includes('number'))).toBe(true)
    expect(result.some((t) => t.text.includes('中文') && t.style.includes('string'))).toBe(true)
    expect(
      result.filter((t) => t.text === 'select').every((t) => !t.style.includes('keyword')),
    ).toBe(true)
  })
})

it('highlights JSON scalar values without interpreting markup', () => {
  const result = tokens('{"name":"<script>","count":42,"ready":true,"none":null}', 'json')
  expect(result.some((t) => t.text === '42' && t.style.includes('number'))).toBe(true)
  expect(result.some((t) => t.text === 'true' && t.style.includes('bool'))).toBe(true)
  expect(result.some((t) => t.text.includes('<script>') && t.style.includes('string'))).toBe(true)
})

it('does not treat SQL keywords as JSON keywords', () => {
  expect(tokens('SELECT', 'json').some((t) => t.style.includes('keyword'))).toBe(false)
})
