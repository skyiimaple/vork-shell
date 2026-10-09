const { app, BrowserWindow } = require('electron')
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path'),
  { tmpdir } = require('node:os'),
  { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-table-data-')),
  database = join(directory, 'test.sqlite')
const seed = new DatabaseSync(database)
seed.exec(
  'CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT,score INTEGER); CREATE VIEW readonly_items AS SELECT * FROM items',
)
const insert = seed.prepare('INSERT INTO items VALUES(?,?,?)')
for (let i = 1; i <= 102; i++) insert.run(i, 'row-' + i, i)
seed.close()
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
async function select(w, label, text) {
  await w.webContents.executeJavaScript(
    `document.querySelector('[role=combobox][aria-label=${JSON.stringify(label)}]').focus()`,
  )
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
  await wait(
    w,
    `Array.from(document.querySelectorAll('[role=option]')).some(el=>el.textContent.trim()===${JSON.stringify(text)})`,
  )
  const point = await w.webContents.executeJavaScript(
    `(()=>{const el=Array.from(document.querySelectorAll('[role=option]')).find(el=>el.textContent.trim()===${JSON.stringify(text)});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
  )
  w.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  w.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await wait(w, `document.querySelector('[role=listbox]')===null`)
}
async function input(w, label, text) {
  await w.webContents.executeJavaScript(
    `(()=>{const el=document.querySelector('[aria-label=${JSON.stringify(label)}]');el.value=${JSON.stringify(text)};el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await pause(50)
}
const timer = setTimeout(() => app.exit(1), 45000)
app.whenReady().then(async () => {
  const w = BrowserWindow.getAllWindows()[0]
  try {
    if (w.webContents.isLoading())
      await new Promise((r) => w.webContents.once('did-finish-load', r))
    await wait(w, `document.querySelector('[aria-label="连接 Local"]')`)
    await click(w, '[aria-label="连接 Local"]')
    await wait(w, `document.querySelector('[aria-label="刷新 SQL 对象"]')`)
    await click(w, '[aria-label="刷新 SQL 对象"]')
    await wait(w, `document.querySelector('[aria-label="管理数据 main.items"]')`)
    await click(w, '[aria-label="管理数据 main.items"]')
    await wait(
      w,
      `document.querySelector('[aria-label="数据分页状态"]')?.textContent.includes('50 行')`,
    )
    await click(w, '[aria-label="数据下一页"]')
    await wait(
      w,
      `document.querySelector('[aria-label="数据分页状态"]').textContent.includes('第 2 页')`,
    )
    await wait(
      w,
      `document.querySelector('[role=dialog] [data-slot=table]').textContent.includes('row-51')`,
    )
    await click(w, '[aria-label="数据下一页"]')
    await wait(
      w,
      `document.querySelector('[aria-label="数据分页状态"]').textContent.includes('第 3 页')&&document.querySelector('[aria-label="数据分页状态"]').textContent.includes('2 行')`,
    )
    assert.equal(
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="数据下一页"]').disabled`,
      ),
      true,
    )
    await click(w, '[role=dialog] [aria-label="排序 score"]')
    await wait(
      w,
      `document.querySelector('[aria-label="数据分页状态"]').textContent.includes('第 1 页')`,
    )
    await click(w, '[role=dialog] [aria-label="排序 score"]')
    await wait(
      w,
      `document.querySelector('[role=dialog] [data-slot=table]').textContent.includes('row-102')`,
    )
    await select(w, '数据筛选字段', 'title')
    await input(w, '数据筛选值', 'row-2')
    await w.webContents.executeJavaScript(
      `document.querySelector('[role=dialog] form').requestSubmit()`,
    )
    await wait(
      w,
      `document.querySelector('[aria-label="数据分页状态"]').textContent.includes('1 行')`,
    )
    await click(w, '[aria-label="编辑 title 第 1 行"]')
    await wait(w, `document.querySelector('[aria-label="单元格新值"]')`)
    await input(w, '单元格新值', "edited ' ; --")
    await w.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent==='确认写入数据库').click()`,
    )
    await wait(w, `document.body.textContent.includes('已修改1个单元格')`)
    const verify = new DatabaseSync(database)
    assert.equal(verify.prepare('SELECT title FROM items WHERE id=2').get().title, "edited ' ; --")
    assert.equal(verify.prepare('SELECT count(*) AS n FROM items').get().n, 102)
    await select(w, '数据筛选字段', '全部数据')
    await w.webContents.executeJavaScript(
      `document.querySelector('[role=dialog] form').requestSubmit()`,
    )
    await wait(
      w,
      `document.querySelector('[aria-label="编辑 title 第 1 行"]')&&!document.body.textContent.includes('正在加载…')`,
    )
    await click(w, '[aria-label="编辑 title 第 1 行"]')
    await wait(w, `document.querySelector('[aria-label="单元格新值"]')`)
    verify.exec("UPDATE items SET title='external' WHERE id=102")
    await input(w, '单元格新值', 'overwrite')
    await w.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent==='确认写入数据库').click()`,
    )
    await wait(w, `document.body.textContent.includes('发生冲突')`)
    assert.equal(verify.prepare('SELECT title FROM items WHERE id=102').get().title, 'external')
    verify.close()
    await w.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent==='取消').click()`,
    )
    await wait(w, `document.querySelector('[aria-label="单元格新值"]')===null`)
    mkdirSync(resolve('.artifacts'), { recursive: true })
    writeFileSync(resolve('.artifacts/table-data.png'), (await w.webContents.capturePage()).toPNG())
    const sessionId = await w.webContents.executeJavaScript(
      `JSON.parse(localStorage.getItem('vork.workspace.v1')).tabs[0].session.id`,
    )
    const readonly = await w.webContents.executeJavaScript(
      `window.vork.tableRequest(${JSON.stringify(sessionId)},{kind:'browse',table:{schema:'main',name:'readonly_items'},page:0,pageSize:20})`,
    )
    assert.equal(readonly.snapshotId, undefined)
    assert.ok(readonly.columns.every((c) => !c.editable))
    console.log(
      'Table data desktop passed: worker bindings, server paging/sorting/filtering, confirmed one-cell edit, concurrent conflict, read-only view',
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
