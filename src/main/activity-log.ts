import { mkdir, readFile, appendFile, stat, rename, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActivityEntry } from '../shared/contracts'
export class ActivityLog {
  readonly path: string
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private directory: string) {
    this.path = join(directory, 'logs', 'activity.jsonl')
  }
  record(level: 'info' | 'error', action: string, connection = '', message = '') {
    const clean = (value: string) =>
      value
        .replace(/(password|passphrase|auth|token)\s*[=:]\s*[^\s,;]+/gi, '$1=[隐藏]')
        .replace(/:\/\/[^\s/@]+:[^\s/@]+@/g, '://[隐藏]@')
        .replace(/-----BEGIN[\s\S]*?-----END[^\n]+/g, '[密钥已隐藏]')
        .slice(0, 1000)
    const row: ActivityEntry = {
      time: new Date().toISOString(),
      level,
      action,
      connection: clean(connection),
      message: clean(message),
    }
    const task = this.queue.then(async () => {
      await mkdir(join(this.directory, 'logs'), { recursive: true, mode: 0o700 })
      const size = await stat(this.path)
        .then((s) => s.size)
        .catch(() => 0)
      if (size >= 5 * 1024 * 1024) await rename(this.path, this.path + '.1')
      await appendFile(this.path, JSON.stringify(row) + '\n', { mode: 0o600 })
      await chmod(this.path, 0o600)
    })
    this.queue = task.catch(() => {})
    return task
  }
  async list(): Promise<ActivityEntry[]> {
    await this.queue
    const read = async (path: string) => {
      try {
        return await readFile(path, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw e
      }
    }
    const text = (await read(this.path + '.1')) + (await read(this.path))
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ActivityEntry]
        } catch {
          return []
        }
      })
      .slice(-2000)
      .reverse()
  }
  async exportText() {
    await this.queue
    const read = async (path: string) => {
      try {
        return await readFile(path, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw e
      }
    }
    return (await read(this.path + '.1')) + (await read(this.path))
  }
}
