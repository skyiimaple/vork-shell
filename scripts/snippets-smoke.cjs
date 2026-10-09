const { app, BrowserWindow } = require('electron')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path'),
  { tmpdir } = require('node:os'),
  { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-snippets-')),
  database = join(directory, 'test.sqlite')
const db = new DatabaseSync(database)
db.exec('CREATE TABLE audit(n INTEGER)')
db.close()
app.setPath('userData', directory)
writeFileSync(
  join(directory, 'connections.json'),
  JSON.stringify([{ id: 'local', type: 'sqlite', name: 'Local', path: database }]),
)
require('./smoke-window.cjs')
require('../out/main/index.js')
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function wait(w, expression) {
  for (let i = 0; i < 100; i++) {
    if (await w.webContents.executeJavaScript(expression)) return
    await pause(50)
  }
  throw Error(expression)
}
async function click(w, selector) {
  await w.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)}).click()`,
  )
}
async function name(w, value) {
  await w.webContents.executeJavaScript(
    `(() => {const el=document.querySelector('[aria-label="SQL 片段名称"]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await pause(50)
}
async function edit(w, value) {
  await w.webContents.executeJavaScript(
    `(() => {const el=document.querySelector('[aria-label="SQL 查询"]');el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',metaKey:${process.platform === 'darwin'},ctrlKey:${process.platform !== 'darwin'},bubbles:true,cancelable:true}))})()`,
  )
  await w.webContents.insertText(value)
  await pause(100)
}
const timer = setTimeout(() => app.exit(1), 30000)
app.whenReady().then(async () => {
  const w = BrowserWindow.getAllWindows()[0]
  try {
    if (w.webContents.isLoading())
      await new Promise((r) => w.webContents.once('did-finish-load', r))
    await wait(w, `document.querySelector('[aria-label="连接 Local"]')`)
    await click(w, '[aria-label="连接 Local"]')
    await wait(w, `document.querySelector('[aria-label="SQL 查询"]')`)
    const sql = 'INSERT INTO audit VALUES(77);'
    await edit(w, 'SELECT 1;\n' + sql)
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="SQL 查询"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',code:'Home',shiftKey:true,bubbles:true,cancelable:true}))`,
    )
    await pause(50)
    await click(w, '[aria-label="SQL 收藏片段"]')
    await wait(w, `document.querySelector('[aria-label="SQL 片段名称"]')`)
    await name(w, '待执行插入')
    await click(w, '[role=dialog] button[type=submit]')
    await wait(w, `document.querySelector('[aria-label="载入片段 待执行插入"]')`)
    assert.equal(
      await w.webContents.executeJavaScript(
        `JSON.parse(localStorage.getItem('vork.sql-snippets.v1')).items[0].sql`,
      ),
      sql,
    )
    await w.webContents.executeJavaScript(
      `(() => {const el=document.querySelector('[aria-label="搜索 SQL 片段"]');el.value='no-match';el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    )
    await wait(w, `document.querySelector('[role=dialog]').textContent.includes('没有匹配的片段')`)
    await w.webContents.executeJavaScript(
      `(() => {const el=document.querySelector('[aria-label="搜索 SQL 片段"]');el.value='';el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    )
    await wait(w, `document.querySelector('[aria-label="重命名片段 待执行插入"]')`)
    await click(w, '[aria-label="重命名片段 待执行插入"]')
    await name(w, '审计片段')
    await click(w, '[role=dialog] button[type=submit]')
    await wait(w, `document.querySelector('[aria-label="载入片段 审计片段"]')`)
    await click(w, '[data-slot=dialog-close]')
    await wait(w, `document.querySelector('[role=dialog]')===null`)
    await edit(w, 'SELECT 1;')
    await click(w, '[aria-label="SQL 收藏片段"]')
    await wait(w, `document.querySelector('[aria-label="载入片段 审计片段"]')`)
    await click(w, '[aria-label="载入片段 审计片段"]')
    await wait(
      w,
      `document.querySelector('[aria-label="SQL 查询"]').textContent===${JSON.stringify(sql)}`,
    )
    const check = new DatabaseSync(database)
    assert.equal(check.prepare('SELECT count(*) AS n FROM audit').get().n, 0)
    check.close()
    const loaded = new Promise((r) => w.webContents.once('did-finish-load', r))
    w.webContents.reload()
    await loaded
    await wait(w, `document.body.textContent.includes('待重连')`)
    await click(w, '[aria-label="SQL 收藏片段"]')
    await wait(w, `document.querySelector('[aria-label="删除片段 审计片段"]')`)
    await click(w, '[aria-label="删除片段 审计片段"]')
    await wait(w, `document.querySelector('[role=alertdialog]')`)
    await w.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=alertdialog] button')).find(b=>b.textContent==='确认删除片段').click()`,
    )
    await wait(w, `JSON.parse(localStorage.getItem('vork.sql-snippets.v1')).items.length===0`)
    await click(w, '[data-slot=dialog-close]')
    await wait(w, `document.querySelector('[role=dialog]')===null`)
    await w.webContents.executeJavaScript(`localStorage.setItem('vork.sql-snippets.v1','{')`)
    await click(w, '[aria-label="SQL 收藏片段"]')
    await wait(w, `document.querySelector('[role=dialog]').textContent.includes('数据损坏')`)
    assert.equal(
      await w.webContents.executeJavaScript(`localStorage.getItem('vork.sql-snippets.v1')`),
      '{',
    )
    assert.equal(
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="SQL 片段名称"]').disabled`,
      ),
      true,
    )
    console.log(
      'Snippets desktop passed: save, rename, restore without execution, reload persistence, confirmed deletion, damaged storage preserved',
    )
    clearTimeout(timer)
    w.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (e) {
    console.error(e)
    console.error(await w.webContents.executeJavaScript('document.body.textContent'))
    clearTimeout(timer)
    w.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(1)
  }
})
