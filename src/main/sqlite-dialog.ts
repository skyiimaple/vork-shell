import { readFile, stat, writeFile } from 'node:fs/promises'
import { parseSqliteCommand } from './sqlite-tools'
import type { QueryResult } from '../shared/contracts'
import type { SessionManager } from './sessions'
export async function executeSqliteCommand(
  sessions: SessionManager,
  owner: number,
  id: string,
  command: string,
  pickImport: () => Promise<string | null>,
  pickDump: () => Promise<string | null>,
): Promise<QueryResult> {
  if (sessions.getSession(owner, id).type !== 'sqlite') throw new Error('便捷命令仅适用于 SQLite')
  const request = parseSqliteCommand(command)
  const file = await (request.kind === 'import' ? pickImport() : pickDump())
  sessions.assertOwned(owner, id)
  if (!file)
    return {
      columns: ['消息'],
      rows: [['已取消文件操作']],
      affectedRows: 0,
      elapsedMs: 0,
      truncated: false,
    }
  if (request.kind === 'import') {
    const info = await stat(file)
    if (!info.isFile() || info.size > 16 * 1024 * 1024)
      throw new Error('请选择不超过 16 MiB 的普通 CSV 文件')
    const content = await readFile(file)
    if (content.byteLength > 16 * 1024 * 1024) throw new Error('CSV 超过 16 MiB')
    const csv = new TextDecoder('utf-8', { fatal: true }).decode(content)
    const result = await sessions.sqliteTool(owner, id, {
      kind: 'import',
      table: request.table,
      csv,
    })
    if (typeof result === 'string') throw new Error('SQLite 导入返回类型无效')
    return result
  }
  const started = performance.now()
  const dump = await sessions.sqliteTool(owner, id, request)
  if (typeof dump !== 'string') throw new Error('SQLite 导出返回类型无效')
  sessions.assertOwned(owner, id)
  await writeFile(file, dump, { mode: 0o600 })
  return {
    columns: ['导出 SQL 文件'],
    rows: [[file]],
    affectedRows: 0,
    elapsedMs: Math.round(performance.now() - started),
    truncated: false,
  }
}
