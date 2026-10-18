const { app, BrowserWindow } = require('electron')
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs')
const { join } = require('node:path'),
  { tmpdir } = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-plan-')),
  database = join(directory, 'fixture.sqlite')
const db = new DatabaseSync(database)
db.exec(
  "CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT);CREATE INDEX title_idx ON items(title);INSERT INTO items VALUES(1,'one'),(2,'two')",
)
app.setPath('userData', directory)
writeFileSync(
  join(directory, 'connections.json'),
  JSON.stringify([{ id: 'fixture', type: 'sqlite', name: 'PlanFixture', path: database }]),
)
require('./smoke-window.cjs')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(w, code) {
  for (let i = 0; i < 150; i++) {
    if (await w.webContents.executeJavaScript(code)) return
    await pause(40)
  }
  throw new Error(code)
}
async function button(w, text) {
  const point = await w.webContents.executeJavaScript(
    `(()=>{const el=Array.from(document.querySelectorAll('button')).find(el=>el.offsetParent!==null && el.textContent.trim()===${JSON.stringify(text)});const rect=el.getBoundingClientRect();return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}})()`,
  )
  w.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  w.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
}
const timer = setTimeout(() => app.exit(1), 30000)
;(async () => {
  try {
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    const state = {
      version: 1,
      active: 's',
      tabs: [
        {
          session: {
            id: 's',
            profileId: 'fixture',
            type: 'sqlite',
            name: 'PlanFixture',
            target: database,
          },
          sql: "SELECT * FROM items WHERE title='one'; -- 尾部注释",
        },
      ],
    }
    await w.webContents.executeJavaScript(
      `localStorage.setItem('vork.workspace.v1',${JSON.stringify(JSON.stringify(state))});Storage.prototype.setItem=function(){};void 0`,
    )
    w.reload()
    await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    await wait(w, `Boolean(document.querySelector('[aria-label="重连 PlanFixture"]'))`)
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="重连 PlanFixture"]').click()`,
    )
    await wait(
      w,
      `Boolean(document.querySelector('[aria-label="查看执行计划"]')) && !document.querySelector('[aria-label="查看执行计划"]').disabled`,
    )
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="查看执行计划"]').click()`,
    )
    await wait(
      w,
      `document.querySelector('[aria-label="执行计划树"]')?.textContent.includes('title_idx')`,
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2)
    mkdirSync(join(process.cwd(), '.artifacts'), { recursive: true })
    writeFileSync(
      join(process.cwd(), '.artifacts/query-plan.png'),
      (await w.webContents.capturePage()).toPNG(),
    )
    assert.equal(
      await w.webContents.executeJavaScript(`document.body.textContent.includes('SQL 已修改')`),
      false,
    )
    await button(w, '原始计划')
    await wait(
      w,
      `document.querySelector('[aria-label="原始执行计划"]')?.textContent.includes('title_idx')`,
    )
    await w.webContents.executeJavaScript(
      `(()=>{const el=document.querySelector('[aria-label="执行计划 SQL"]');el.value="INSERT INTO items VALUES(3,'not executed')";el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    )
    await pause(80)
    await button(w, '生成执行计划')
    await wait(w, `document.body.textContent.includes('数据库未为此语句返回可视计划节点')`)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2)
    await w.webContents.executeJavaScript(
      `(()=>{const el=document.querySelector('[aria-label="执行计划 SQL"]');el.value='SELECT 1; DELETE FROM items';el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    )
    await pause(80)
    await button(w, '生成执行计划')
    await wait(w, `document.body.textContent.includes('仅支持一条 SQL')`)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2)
    console.log(
      'Execution plan UI: index tree, raw plan, non-executing INSERT and multi-statement rejection passed',
    )
    clearTimeout(timer)
    w.destroy()
    db.close()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (e) {
    console.error(e)
    const w = BrowserWindow.getAllWindows()[0]
    if (w)
      console.error(await w.webContents.executeJavaScript('document.body.innerText.slice(-3000)'))
    clearTimeout(timer)
    app.exit(1)
  }
})()
