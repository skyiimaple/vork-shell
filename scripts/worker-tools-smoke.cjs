const { Worker } = require('node:worker_threads')
const { resolve } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const worker = new Worker(resolve('out/main/sqlite-worker.js'), {
  workerData: { path: ':memory:' },
})
const tasks = new Map()
let counter = 0
worker.on('message', (message) => {
  const task = tasks.get(message.requestId)
  if (!task) return
  tasks.delete(message.requestId)
  message.error ? task.reject(new Error(message.error)) : task.resolve(message.result)
})
worker.on('error', (error) => {
  for (const task of tasks.values()) task.reject(error)
  tasks.clear()
})
function request(payload) {
  return new Promise((resolve, reject) => {
    const requestId = String(++counter)
    tasks.set(requestId, { resolve, reject })
    worker.postMessage({ requestId, ...payload })
  })
}
const timeout = setTimeout(() => {
  console.error('Worker tools smoke timeout')
  void worker.terminate()
  process.exitCode = 1
}, 10000)
;(async () => {
  try {
    await new Promise((resolve, reject) => {
      worker.once('message', (message) =>
        message.ready ? resolve() : reject(new Error(message.error)),
      )
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('Worker stopped before ready')))
    })
    await request({ sql: 'CREATE TABLE t(id INTEGER PRIMARY KEY,value TEXT)' })
    const imported = await request({
      tool: { kind: 'import', table: 't', csv: 'id,value\n1,first\n2,"hello, quoted"\n' },
    })
    assert.equal(imported.affectedRows, 2)
    await assert.rejects(
      request({ tool: { kind: 'import', table: 't', csv: 'id,value\n3,rollback\n1,duplicate' } }),
    )
    const count = await request({ sql: 'SELECT count(*) AS n FROM t' })
    assert.equal(count.rows[0][0], 2)
    const dump = await request({ tool: { kind: 'dump' } })
    const db = new DatabaseSync(':memory:')
    db.exec(dump)
    assert.deepEqual(
      db
        .prepare('SELECT * FROM t ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 1, value: 'first' },
        { id: 2, value: 'hello, quoted' },
      ],
    )
    db.close()
    console.log(
      'Built SQLite worker smoke passed: typed request routing, import, rollback, dump roundtrip, subsequent SQL query.',
    )
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    await worker.terminate()
  }
})()
