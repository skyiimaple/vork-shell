const { readdirSync, readFileSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')
const root = resolve(__dirname, '../src/renderer/src')
const violations = []
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (path !== join(root, 'components/ui')) scan(path)
      continue
    }
    if (!entry.name.endsWith('.vue')) continue
    const source = readFileSync(path, 'utf8')
    // Hyphenated component tags such as <select-trigger> are not native <select>.
    const forbidden =
      /<(?:button|input|textarea|select|option|table|thead|tbody|tr|th|td|label|dialog)(?![\w-])|\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/g
    for (const match of source.matchAll(forbidden)) {
      const line = source.slice(0, match.index).split('\n').length
      violations.push(`${relative(root, path)}:${line} ${match[0]}`)
    }
  }
}
scan(root)
if (violations.length) {
  console.error('业务界面请优先使用 shadcn-vue 基础组件：\n' + violations.join('\n'))
  process.exitCode = 1
} else
  console.log(
    'UI audit passed: business views use shared components; native primitives remain inside components/ui.',
  )
