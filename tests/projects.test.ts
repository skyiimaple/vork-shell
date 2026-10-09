import { it, expect } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectStore } from '../src/main/projects'
const connections = [{ id: 'a', group: '旧项目' }, { id: 'b', group: '旧项目' }, { id: 'c' }]
it('migrates old custom groups once and keeps independent cross-type memberships', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vork-projects-'))
  try {
    const store = new ProjectStore(dir, async () => connections)
    const initial = await store.list()
    expect(initial).toHaveLength(1)
    expect(initial[0]).toMatchObject({ name: '旧项目', connectionIds: ['a', 'b'] })
    const p = await store.create('新项目')
    await store.update(p.id, '新项目', ['a', 'c'])
    expect((await store.list()).find((row) => row.id === p.id)?.connectionIds).toEqual(['a', 'c'])
    await store.remove(initial[0].id)
    expect(
      (await new ProjectStore(dir, async () => connections).list()).map((row) => row.name),
    ).toEqual(['新项目'])
    expect(connections[0].group).toBe('旧项目')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('rejects duplicates, missing connections and invalid names atomically; concurrent updates are serialized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vork-projects-'))
  try {
    const store = new ProjectStore(dir, async () => [{ id: 'a' }, { id: 'b' }])
    const a = await store.create('A')
    await expect(store.create('a')).rejects.toThrow('已存在')
    await expect(store.create(' ')).rejects.toThrow()
    await expect(store.update(a.id, 'A', ['missing'])).rejects.toThrow('不存在')
    await Promise.all([store.create('B'), store.create('C')])
    expect(await store.list()).toHaveLength(3)
    await store.update(a.id, 'Renamed', ['a', 'b', 'a'])
    expect((await store.list())[0].connectionIds).toEqual(['a', 'b'])
    expect(JSON.parse(await readFile(join(dir, 'projects.json'), 'utf8'))).toHaveLength(3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('filters deleted connections and preserves corrupt files instead of overwriting them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vork-projects-'))
  let profiles = [{ id: 'a' }]
  try {
    const store = new ProjectStore(dir, async () => profiles)
    const p = await store.create('A')
    await store.update(p.id, 'A', ['a'])
    profiles = []
    expect((await store.list())[0].connectionIds).toEqual([])
    await writeFile(join(dir, 'projects.json'), 'broken')
    await expect(store.list()).rejects.toThrow()
    expect(await readFile(join(dir, 'projects.json'), 'utf8')).toBe('broken')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('assigns one connection to several projects atomically without changing original groups', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vork-projects-'))
  try {
    const store = new ProjectStore(dir, async () => [{ id: 'a' }])
    const first = await store.create('One'),
      second = await store.create('Two')
    await store.assign('a', [first.id, second.id])
    expect((await store.list()).every((p) => p.connectionIds.includes('a'))).toBe(true)
    await expect(store.assign('a', [first.id, 'missing'])).rejects.toThrow()
    expect((await store.list()).every((p) => p.connectionIds.includes('a'))).toBe(true)
    await store.assign('a', [])
    expect((await store.list()).every((p) => !p.connectionIds.length)).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
