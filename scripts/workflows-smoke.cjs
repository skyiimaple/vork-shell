const { app, BrowserWindow } = require('electron')
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-workflows-')),
  database = join(directory, 'flow.sqlite')
const db = new DatabaseSync(database)
db.exec('CREATE TABLE audit(n INTEGER)')
db.close()
app.setPath('userData', directory)
writeFileSync(
  join(directory, 'connections.json'),
  JSON.stringify([
    { id: 'alpha', name: 'Alpha', type: 'sqlite', path: database, group: '开发' },
    { id: 'beta', name: 'Beta', type: 'sqlite', path: ':memory:', group: '开发' },
  ]),
)
require('./smoke-window.cjs')
require('../out/main/index.js')
const timer = setTimeout(() => {
  console.error('workflow smoke timeout')
  app.exit(1)
}, 60000)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function wait(w, expression) {
  for (let i = 0; i < 100; i++) {
    if (await w.webContents.executeJavaScript(expression)) return
    await pause(50)
  }
  throw new Error('UI condition failed: ' + expression)
}
async function click(w, selector) {
  await w.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)}).click()`,
  )
}
async function edit(w, text) {
  await w.webContents.executeJavaScript(
    `(() => {const el=document.querySelector('[aria-label="SQL 查询"]');el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',metaKey:${process.platform === 'darwin'},ctrlKey:${process.platform !== 'darwin'},bubbles:true,cancelable:true}))})()`,
  )
  await w.webContents.insertText(text)
  await pause(100)
}
async function run(w) {
  await w.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('执行')&&b.textContent.includes('⌘')).click()`,
  )
}
app.whenReady().then(async () => {
  const w = BrowserWindow.getAllWindows()[0]
  const errors = []
  w.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(e.message)
  })
  try {
    if (w.webContents.isLoading())
      await new Promise((r) => w.webContents.once('did-finish-load', r))
    await wait(w, `document.querySelector('[aria-label="收藏连接 Alpha"]') !== null`)
    await click(w, '[aria-label="收藏连接 Alpha"]')
    await wait(
      w,
      `document.querySelector('[aria-label="收藏连接 Alpha"]').getAttribute('aria-pressed') === 'true'`,
    )
    assert.equal(
      JSON.parse(readFileSync(join(directory, 'connections.json'), 'utf8'))[0].favorite,
      true,
    )
    await click(w, '[aria-label="连接 Alpha"]')
    await wait(
      w,
      `document.querySelector('[aria-label="SQL 查询"][contenteditable=true]') !== null`,
    )
    await edit(w, 'SELECT 11 AS first;\nSELECT 22 AS second;')
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="SQL 查询"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',code:'Home',shiftKey:true,bubbles:true,cancelable:true}))`,
    )
    await wait(
      w,
      `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('执行选中'))`,
    )
    await run(w)
    await wait(
      w,
      `document.querySelector('[data-slot=table]')?.textContent.includes('22') && document.querySelector('[aria-label="SQL 结果集"]') === null`,
    )
    await edit(w, 'SELECT 11 AS first; SELECT 22 AS second;')
    await run(w)
    await wait(
      w,
      `document.querySelector('[aria-label="SQL 结果集"]') !== null && document.querySelector('[data-slot=table]')?.textContent.includes('22')`,
    )
    mkdirSync(resolve('.artifacts'), { recursive: true })
    await pause(200)
    writeFileSync(
      resolve('.artifacts/sql-multi-results.png'),
      (await w.webContents.capturePage()).toPNG(),
    )
    // Partial success is retained and later writes are not executed.
    await edit(w, 'SELECT 33 AS retained; SELECT missing FROM audit; INSERT INTO audit VALUES(99);')
    await run(w)
    await wait(
      w,
      `document.body.textContent.includes('第 2 条语句失败') && document.querySelector('[data-slot=table]')?.textContent.includes('33')`,
    )
    await edit(w, 'INSERT INTO audit VALUES(88); -- pending draft')
    await wait(w, `localStorage.getItem('vork.workspace.v1')?.includes('pending draft')`)
    const before = await w.webContents.executeJavaScript(
      `JSON.parse(localStorage.getItem('vork.workspace.v1'))`,
    )
    const oldId = before.tabs[0].session.id
    const loaded = new Promise((r) => w.webContents.once('did-finish-load', r))
    w.webContents.reload()
    await loaded
    await wait(
      w,
      `document.body.textContent.includes('待重连') && document.querySelector('[aria-label="SQL 查询"]').textContent.includes('pending draft')`,
    )
    assert.equal(
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="SQL 查询"]').getAttribute('contenteditable')`,
      ),
      'false',
    )
    assert.equal(
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="收藏连接 Alpha"]').getAttribute('aria-pressed')`,
      ),
      'true',
    )
    const check = new DatabaseSync(database)
    assert.equal(check.prepare('SELECT count(*) AS n FROM audit').get().n, 0)
    check.close()
    await assert.rejects(
      w.webContents.executeJavaScript(`window.vork.execute(${JSON.stringify(oldId)},'SELECT 1')`),
    )
    await click(w, '[aria-label="重连 Alpha"]')
    await wait(
      w,
      `document.querySelector('[aria-label="SQL 查询"]').getAttribute('contenteditable') === 'true' && document.querySelector('[aria-label="SQL 查询"]').textContent.includes('pending draft')`,
    )
    await wait(
      w,
      `JSON.parse(localStorage.getItem('vork.workspace.v1')).tabs[0].session.id !== ${JSON.stringify(oldId)} && !JSON.parse(localStorage.getItem('vork.workspace.v1')).tabs[0].session.id.startsWith('restored-')`,
    )
    const id = await w.webContents.executeJavaScript(
      `JSON.parse(localStorage.getItem('vork.workspace.v1')).tabs[0].session.id`,
    )
    await w.webContents.executeJavaScript(`window.vork.cancel(${JSON.stringify(id)})`)
    await wait(w, `document.querySelector('[aria-label="重连 Alpha"]') !== null`)
    await click(w, '[aria-label="重连 Alpha"]')
    await wait(
      w,
      `document.querySelector('[aria-label="SQL 查询"]').getAttribute('contenteditable') === 'true'`,
    )
    await click(w, '[aria-label="关闭 Alpha"]')
    await wait(w, `JSON.parse(localStorage.getItem('vork.workspace.v1')).tabs.length === 0`)
    assert.deepEqual(errors, [])
    console.log(
      'Workflow desktop passed: favorite, quick connect, selected SQL, multi results, stop on failure, offline workspace/draft recovery, manual reconnect, resource release',
    )
    clearTimeout(timer)
    w.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (e) {
    console.error(e)
    console.error(await w.webContents.executeJavaScript('document.body.textContent'))
    mkdirSync(resolve('.artifacts'), { recursive: true })
    writeFileSync(
      resolve('.artifacts/workflow-failure.png'),
      (await w.webContents.capturePage()).toPNG(),
    )
    clearTimeout(timer)
    w.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(1)
  }
})
