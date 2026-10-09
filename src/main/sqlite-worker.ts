import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { runSqliteTool } from './sqlite-tools'
import type { SqliteToolRequest, Cell } from '../shared/contracts'
import { runSqlite } from './sqlite'

try {
  const db = new DatabaseSync(workerData.path)
  db.exec('PRAGMA busy_timeout = 3000')
  parentPort!.postMessage({ ready: true })
  parentPort!.on(
    'message',
    ({
      requestId,
      sql,
      tool,
      parameters,
    }: {
      requestId: string
      sql: string
      tool?: SqliteToolRequest
      parameters?: Cell[]
    }) => {
      try {
        parentPort!.postMessage({
          requestId,
          result: tool ? runSqliteTool(db, tool) : runSqlite(db, sql, 1000, parameters),
        })
      } catch (error) {
        parentPort!.postMessage({
          requestId,
          error: error instanceof Error ? error.message : '查询失败',
        })
      }
    },
  )
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : '无法打开 SQLite' })
}
