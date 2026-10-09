import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConnectionProject } from '../shared/contracts'
type Seed = { id?: string; group?: string }
function projectName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 100 ||
    value.includes('\0') ||
    /[\r\n]/.test(value)
  )
    throw new Error('项目名称需为 1–100 字，不能包含换行')
  return value.trim()
}
export class ProjectStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private directory: string,
    private connections: () => Promise<Seed[]>,
  ) {}
  private async read(): Promise<ConnectionProject[]> {
    const profiles = await this.connections(),
      live = new Set(profiles.map((p) => p.id))
    let data: unknown
    try {
      data = JSON.parse(await readFile(join(this.directory, 'projects.json'), 'utf8'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('项目文件损坏或无法读取，原文件已保留')
      const groups = new Map<string, ConnectionProject>()
      for (const p of profiles) {
        if (!p.id || !p.group?.trim()) continue
        const name = projectName(p.group),
          key = name.toLocaleLowerCase()
        let project = groups.get(key)
        if (!project) {
          project = { id: randomUUID(), name, connectionIds: [] }
          groups.set(key, project)
        }
        project.connectionIds.push(p.id)
      }
      data = [...groups.values()]
      if (groups.size > 100) throw new Error('旧分组超过 100 个，请先整理后迁移项目')
      await this.write(data as ConnectionProject[])
    }
    if (!Array.isArray(data) || data.length > 100) throw new Error('项目文件格式无效，原文件已保留')
    const ids = new Set<string>(),
      names = new Set<string>()
    return data.map((item: unknown) => {
      if (!item || typeof item !== 'object') throw new Error('项目文件格式无效')
      const p = item as ConnectionProject,
        name = projectName(p.name),
        key = name.toLocaleLowerCase()
      if (
        typeof p.id !== 'string' ||
        !p.id ||
        p.id.length > 200 ||
        ids.has(p.id) ||
        names.has(key) ||
        !Array.isArray(p.connectionIds) ||
        p.connectionIds.length > 10000 ||
        p.connectionIds.some((id) => typeof id !== 'string' || id.length > 200)
      )
        throw new Error('项目文件格式无效，原文件已保留')
      ids.add(p.id)
      names.add(key)
      return {
        id: p.id,
        name,
        connectionIds: [...new Set(p.connectionIds)].filter((id) => live.has(id)),
      }
    })
  }
  private async write(items: ConnectionProject[]) {
    await mkdir(this.directory, { recursive: true })
    const destination = join(this.directory, 'projects.json'),
      temp = destination + '.' + randomUUID() + '.tmp'
    await writeFile(temp, JSON.stringify(items, null, 2), { mode: 0o600 })
    await rename(temp, destination)
  }
  private run<T>(action: (items: ConnectionProject[]) => Promise<T>) {
    const task = this.queue.then(async () => action(await this.read()))
    this.queue = task.catch(() => {})
    return task
  }
  list() {
    return this.run(async (items) => items)
  }
  create(input: unknown, members: unknown = []) {
    return this.run(async (items) => {
      const name = projectName(input)
      if (items.length >= 100) throw new Error('最多创建 100 个项目')
      if (items.some((p) => p.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
        throw new Error('项目名称已存在')
      const live = new Set((await this.connections()).map((p) => p.id))
      if (
        !Array.isArray(members) ||
        members.length > 10000 ||
        members.some((member) => typeof member !== 'string' || !live.has(member))
      )
        throw new Error('连接不存在，请刷新后重试')
      const project = { id: randomUUID(), name, connectionIds: [...new Set(members)] as string[] }
      await this.write([...items, project])
      return project
    })
  }
  update(id: unknown, input: unknown, members: unknown) {
    return this.run(async (items) => {
      const name = projectName(input),
        target = items.find((p) => p.id === id)
      if (!target) throw new Error('项目不存在')
      if (items.some((p) => p.id !== id && p.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
        throw new Error('项目名称已存在')
      const live = new Set((await this.connections()).map((p) => p.id))
      if (
        !Array.isArray(members) ||
        members.length > 10000 ||
        members.some((member) => typeof member !== 'string' || !live.has(member))
      )
        throw new Error('连接不存在，请刷新后重试')
      await this.write(
        items.map((p) => (p.id === id ? { ...p, name, connectionIds: [...new Set(members)] } : p)),
      )
    })
  }
  remove(id: unknown) {
    return this.run(async (items) => {
      if (!items.some((p) => p.id === id)) throw new Error('项目不存在')
      await this.write(items.filter((p) => p.id !== id))
    })
  }
  assign(connectionId: unknown, projectIds: unknown) {
    return this.run(async (items) => {
      if (
        typeof connectionId !== 'string' ||
        !(await this.connections()).some((p) => p.id === connectionId)
      )
        throw new Error('连接不存在')
      if (
        !Array.isArray(projectIds) ||
        projectIds.length > 100 ||
        projectIds.some((id) => typeof id !== 'string' || !items.some((p) => p.id === id))
      )
        throw new Error('项目不存在')
      await this.write(
        items.map((p) => ({
          ...p,
          connectionIds: projectIds.includes(p.id)
            ? [...new Set([...p.connectionIds, connectionId])]
            : p.connectionIds.filter((id) => id !== connectionId),
        })),
      )
    })
  }
}
