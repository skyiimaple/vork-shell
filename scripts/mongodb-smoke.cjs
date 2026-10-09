const { app, BrowserWindow } = require('electron')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { MongoClient, BSON } = require('mongodb')
const assert = require('node:assert/strict')
const port = Number(process.env.VORK_MONGODB_TEST_PORT)
if (!port) throw new Error('请设置隔离 MongoDB 实例的 VORK_MONGODB_TEST_PORT')
const database = 'vork_ui_' + randomUUID().replaceAll('-', '')
const directory = mkdtempSync(join(tmpdir(), 'vork-mongodb-ui-'))
app.setPath('userData', directory)
writeFileSync(
  join(directory, 'connections.json'),
  JSON.stringify([
    {
      id: 'mongo-test',
      name: 'Mongo UI Test',
      type: 'mongodb',
      host: '127.0.0.1',
      port,
      database,
      authSource: 'admin',
    },
  ]),
)
require('./smoke-window.cjs')
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function wait(w, expression) {
  for (let i = 0; i < 150; i++) {
    if (await w.webContents.executeJavaScript(expression)) return
    await pause(40)
  }
  throw Error('UI condition failed: ' + expression)
}
async function click(w, selector) {
  await wait(
    w,
    `document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`,
  )
  await w.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)}).click()`,
  )
  await pause(50)
}
async function textButton(w, text) {
  await w.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('[role=dialog] button')).find(el => el.textContent.trim() === ${JSON.stringify(text)}).click()`,
  )
  await pause(50)
}
async function input(w, selector, value) {
  await w.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  )
  await pause(50)
}
let client
const timeout = setTimeout(() => {
  console.error('MongoDB UI smoke timeout')
  app.exit(1)
}, 45000)
;(async () => {
  try {
    client = await new MongoClient(`mongodb://127.0.0.1:${port}`, {
      serverSelectionTimeoutMS: 5000,
    }).connect()
    await client
      .db(database)
      .collection('items')
      .insertMany(
        Array.from({ length: 55 }, (_, n) => ({
          n,
          name: '中文文档 ' + n,
          large: BSON.Long.fromString('9007199254740993'),
        })),
      )
    await client.db(database).collection('items').createIndex({ name: 1 })
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((r) => w.webContents.once('did-finish-load', r))
    await click(w, '[aria-label="新建连接"]')
    await textButton(w, 'MongoDB')
    assert.equal(
      await w.webContents.executeJavaScript(
        `document.querySelector('[role=dialog] input[type=number]').value`,
      ),
      '27017',
    )
    await click(w, '[data-slot=dialog-close]')
    await click(w, '[aria-label="连接 Mongo UI Test"]')
    await click(w, `[aria-label="MongoDB 集合 items"]`)
    await wait(w, `document.querySelector('[aria-label="MongoDB 文档 50"]')`)
    assert.ok(
      (await w.webContents.executeJavaScript(`document.body.textContent`)).includes(
        '9007199254740993',
      ),
    )
    await click(w, '[aria-label="MongoDB 下一页"]')
    await wait(
      w,
      `document.querySelector('[aria-label="MongoDB 文档 5"]') && !document.querySelector('[aria-label="MongoDB 文档 6"]')`,
    )
    await click(w, '[aria-label="MongoDB 上一页"]')
    await wait(w, `document.querySelector('[aria-label="MongoDB 文档 50"]')`)
    await input(w, '[aria-label="MongoDB 查询条件"]', '{"n":0}')
    await click(w, '[aria-label="查询 MongoDB 文档"]')
    await wait(
      w,
      `document.querySelector('[aria-label="MongoDB 文档 1"]') && !document.querySelector('[aria-label="MongoDB 文档 2"]')`,
    )
    writeFileSync(
      join(tmpdir(), 'vork-mongodb-preview.png'),
      (await w.webContents.capturePage()).toPNG(),
    )
    await click(w, '[aria-label="编辑 MongoDB 文档"]')
    const spacing = await w.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('[aria-label="MongoDB 文档内容"]'); const label = el.closest('[data-slot=label]'); return el.getBoundingClientRect().top - label.querySelector('span').getBoundingClientRect().bottom; })()`,
    )
    assert.ok(spacing >= 7.9, 'label gap ' + spacing)
    const draft = JSON.parse(
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="MongoDB 文档内容"]').value`,
      ),
    )
    draft.name = '已编辑中文'
    await input(w, '[aria-label="MongoDB 文档内容"]', JSON.stringify(draft))
    await textButton(w, '确认保存')
    await wait(
      w,
      `!document.querySelector('[role=dialog]') && document.body.textContent.includes('已编辑中文')`,
    )
    assert.equal(
      (await client.db(database).collection('items').findOne({ n: 0 })).name,
      '已编辑中文',
    )
    await click(w, '[aria-label="新增 MongoDB 文档"]')
    await input(w, '[aria-label="MongoDB 文档内容"]', '{"n":0,"name":"新增中文"}')
    await textButton(w, '确认保存')
    await wait(
      w,
      `!document.querySelector('[role=dialog]') && document.querySelector('[aria-label="MongoDB 文档 2"]')`,
    )
    await click(w, '[aria-label="MongoDB 文档 2"]')
    await click(w, '[aria-label="删除 MongoDB 文档"]')
    await textButton(w, '确认删除')
    await wait(
      w,
      `!document.querySelector('[role=dialog]') && !document.querySelector('[aria-label="MongoDB 文档 2"]')`,
    )
    assert.equal(await client.db(database).collection('items').countDocuments(), 55)
    await click(w, '[aria-label="查看 MongoDB 索引"]')
    await wait(w, `document.body.textContent.includes('name_1')`)
    await click(w, '[aria-label="查看当前连接详情"]')
    await wait(w, `document.querySelector('[role=dialog]')?.textContent.includes('MongoDB 版本')`)
    await click(w, '[data-slot=dialog-close]')
    await click(w, '[aria-label="关闭连接 Mongo UI Test"]')
    await click(w, '[aria-label="重连 Mongo UI Test"]')
    await click(w, `[aria-label="MongoDB 集合 items"]`)
    await wait(w, `document.querySelector('[aria-label="MongoDB 文档 50"]')`)
    console.log(
      'MongoDB desktop smoke passed: connection form, browsing, paging, query, insert/edit/delete, BSON, indexes, details, reconnect and 8px dialog spacing',
    )
    clearTimeout(timeout)
    await click(w, '[aria-label="关闭连接 Mongo UI Test"]')
    await wait(w, `document.querySelector('[aria-label="重连 Mongo UI Test"]')`)
    await client.db(database).dropDatabase()
    await client.close()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (e) {
    console.error(e)
    clearTimeout(timeout)
    await client
      ?.db(database)
      .dropDatabase()
      .catch(() => {})
    await client?.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
    app.exit(1)
  }
})()
