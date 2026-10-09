import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const renderer = fileURLToPath(new URL('../src/renderer/src/', import.meta.url))
const kebabFile = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:vue|ts)$/

function walk(directory: string, skipUi: boolean): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (skipUi && path.includes(join('components', 'ui'))) continue
      found.push(...walk(path, skipUi))
      continue
    }
    found.push(path)
  }
  return found
}

it('uses kebab-case filenames outside shadcn-vue ui components', () => {
  const bad = walk(renderer, true).filter((path) => {
    if (!/\.(vue|ts)$/.test(path) || path.endsWith('.d.ts')) return false
    return !kebabFile.test(basename(path))
  })
  expect(bad.map((path) => path.slice(renderer.length))).toEqual([])
})

it('names composables use-*.ts', () => {
  const names = readdirSync(join(renderer, 'composables')).filter((name) => name.endsWith('.ts'))
  expect(names.filter((name) => !/^use-[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/.test(name))).toEqual([])
})

// Lowercasing these component names makes Vue or the template parser treat them as native tags.
const pascalCaseTags = new Set([
  'Button',
  'Copy',
  'Database',
  'Dialog',
  'Download',
  'Input',
  'Label',
  'Progress',
  'Search',
  'Select',
  'Table',
  'Textarea',
  'Upload',
])

it('uses kebab-case component tags except names that match HTML elements', () => {
  const bad: string[] = []
  for (const path of walk(renderer, false)) {
    if (!path.endsWith('.vue')) continue
    const template = readFileSync(path, 'utf8').match(/<template[^>]*>([\s\S]*)<\/template>/)?.[1]
    if (!template) continue
    for (const match of template.matchAll(/<\/?([A-Z][A-Za-z0-9]*)\b/g)) {
      if (!pascalCaseTags.has(match[1])) bad.push(`${path.slice(renderer.length)} <${match[1]}>`)
    }
  }
  expect(bad).toEqual([])
})
