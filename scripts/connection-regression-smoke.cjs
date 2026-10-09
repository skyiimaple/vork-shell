const { app, BrowserWindow } = require('electron')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path'),
  { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-connection-regression-'))
app.setPath('userData', directory)
writeFileSync(
  join(directory, 'connections.json'),
  JSON.stringify([
    { id: 'local', type: 'sqlite', name: 'Local', path: ':memory:' },
    {
      id: 'broken',
      type: 'sqlite',
      name: 'Broken',
      path: join(directory, 'missing', 'database.sqlite'),
    },
  ]),
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
const timer = setTimeout(() => app.exit(1), 20000)
app.whenReady().then(async () => {
  const w = BrowserWindow.getAllWindows()[0]
  try {
    if (w.webContents.isLoading())
      await new Promise((r) => w.webContents.once('did-finish-load', r))
    await wait(w, `document.querySelector('[aria-label="编辑连接 Local"]')`)
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="连接 Local"]').click()`,
    )
    await wait(w, `document.querySelector('[aria-label="SQL 查询"]')!==null`)
    assert.equal(
      await w.webContents.executeJavaScript(`document.querySelector('[role=dialog]')===null`),
      true,
    )
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="编辑连接 Local"]').click()`,
    )
    await wait(w, `document.querySelector('[role=dialog]')`)
    await pause(250)
    const point = await w.webContents.executeJavaScript(
      `(() => {const r=document.querySelector('[role=dialog] button[type=submit]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
    )
    w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    w.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await wait(w, `document.querySelector('[role=dialog]')===null`)
    assert.ok(
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="SQL 查询"]')!==null`,
      ),
    )
    console.log('Actual submit click connected saved SQLite')
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="新建连接"]').click()`,
    )
    await wait(w, `document.querySelector('[role=dialog]')`)
    await w.webContents.executeJavaScript(
      `(() => {const input=document.querySelector('[role=dialog] input[type=number]');input.value='0';input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    )
    await pause(100)
    await w.webContents.executeJavaScript(
      `document.querySelector('[role=dialog] button[type=submit]').click()`,
    )
    await wait(w, `document.querySelector('[role=dialog]').textContent.includes('端口必须')`)
    console.log('Invalid connection configuration displays actionable error')
    await w.webContents.executeJavaScript(
      `document.querySelector('[data-slot=dialog-close]').click()`,
    )
    await wait(w, `document.querySelector('[role=dialog]')===null`)
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="连接 Broken"]').click()`,
    )
    await wait(
      w,
      `document.querySelector('[role=alert]')?.textContent.includes('连接「Broken」失败')`,
    )
    assert.equal(
      await w.webContents.executeJavaScript(`document.querySelector('[role=dialog]')===null`),
      true,
    )
    await pause(7200)
    assert.ok(
      await w.webContents.executeJavaScript(
        `document.querySelector('[role=alert]')?.textContent.includes('连接「Broken」失败')`,
      ),
    )
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="关闭通知"]').click()`,
    )
    await wait(w, `document.querySelector('[role=alert]')===null`)
    console.log('Single-click connects; editing is separate; failure stays visible until dismissed')
    clearTimeout(timer)
    w.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (e) {
    console.error(e)
    console.error(
      await w.webContents.executeJavaScript(`document.querySelector('[role=dialog]')?.textContent`),
    )
    clearTimeout(timer)
    w.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(1)
  }
})
