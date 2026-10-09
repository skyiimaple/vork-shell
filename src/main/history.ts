import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { QueryHistoryEntry, Session } from '../shared/contracts'
export class HistoryStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private directory: string,
    private limit = 500,
  ) {}
  async list(): Promise<QueryHistoryEntry[]> {
    await this.queue
    try {
      const entries: unknown = JSON.parse(
        await readFile(join(this.directory, 'query-history.json'), 'utf8'),
      )
      if (!Array.isArray(entries)) throw new Error('查询历史格式无效')
      return entries
        .filter(
          (entry): entry is QueryHistoryEntry =>
            entry &&
            typeof entry.sql === 'string' &&
            Buffer.byteLength(entry.sql) <= 65536 &&
            typeof entry.id === 'string' &&
            typeof entry.target === 'string' &&
            typeof entry.name === 'string' &&
            ['sqlite', 'mysql', 'postgresql'].includes(entry.type),
        )
        .slice(0, this.limit)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  async record(session: Session, sql: string): Promise<void> {
    if (
      typeof sql !== 'string' ||
      !sql.trim() ||
      Buffer.byteLength(sql) > 65536 ||
      !['sqlite', 'mysql', 'postgresql'].includes(session.type)
    )
      throw new Error('查询历史为空、类型无效或超过 64 KiB')
    const identity = session.profileId || `${session.type}:${session.target}:${session.name}`
    const prior = this.queue
    const operation = prior.then(async () => {
      // Read directly here: list() awaits the queue, which includes this operation.
      let entries: QueryHistoryEntry[] = []
      try {
        const stored = JSON.parse(
          await readFile(join(this.directory, 'query-history.json'), 'utf8'),
        )
        if (!Array.isArray(stored)) throw new Error('查询历史格式无效')
        entries = stored
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const entry: QueryHistoryEntry = {
        id: randomUUID(),
        profileId: session.profileId,
        identity,
        name: session.name,
        type: session.type as QueryHistoryEntry['type'],
        target: session.target,
        sql,
        timestamp: Date.now(),
      }
      const next = [
        entry,
        ...entries.filter((item) => item.identity !== identity || item.sql !== sql),
      ].slice(0, this.limit)
      await mkdir(this.directory, { recursive: true })
      const path = join(this.directory, 'query-history.json'),
        temporary = path + '.' + randomUUID() + '.tmp'
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 })
      await rename(temporary, path)
    })
    this.queue = operation.catch(() => {})
    return operation
  }
}
