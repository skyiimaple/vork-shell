const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-sidebar-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const name = 'Redis 生产环境用于检查完整名称展示与自动换行的长连接名称'
const timeout = setTimeout(() => {
  console.error('Sidebar smoke timeout')
  app.exit(1)
}, 20000)
;(async () => {
  try {
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    await w.webContents.executeJavaScript(
      `window.vork.saveProfile({type:'sqlite',name:${JSON.stringify(name)},path:':memory:'})`,
    )
    await w.webContents.reload()
    await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    for (let i = 0; i < 100; i++) {
      if (
        await w.webContents.executeJavaScript(
          `Boolean(document.querySelector('[aria-label="连接操作 ${name}"]'))`,
        )
      )
        break
      await pause(30)
    }
    const layout = await w.webContents.executeJavaScript(
      `(()=>{const el=document.querySelector('[aria-label="连接 ${name}"] p');return {text:el.textContent,width:el.clientWidth,scroll:el.scrollWidth,whiteSpace:getComputedStyle(el).whiteSpace}})()`,
    )
    assert.equal(layout.text, name)
    assert.ok(layout.scroll > layout.width)
    assert.equal(layout.whiteSpace, 'nowrap')
    assert.equal(
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="编辑连接 ${name}"]')===null`,
      ),
      true,
    )
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="连接操作 ${name}"]').focus()`,
    )
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await pause(200)
    assert.equal(
      await w.webContents.executeJavaScript("document.querySelectorAll('[role=menuitem]').length"),
      6,
    )
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="编辑连接 ${name}"]').click()`,
    )
    await pause(150)
    assert.ok(
      await w.webContents.executeJavaScript("Boolean(document.querySelector('[role=dialog]'))"),
    )
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await pause(100)
    assert.equal(
      await w.webContents.executeJavaScript(
        'document.querySelector(\'[aria-label="SQLite 连接"]\')!==null',
      ),
      true,
    )
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="连接 ${name}"]').click()`,
    )
    for (let i = 0; i < 100; i++) {
      if (
        await w.webContents.executeJavaScript(
          `document.querySelector('[aria-label="连接 ${name}"]').getAttribute('aria-current')==='true'`,
        )
      )
        break
      await pause(30)
    }
    assert.equal(
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="连接 ${name}"]').closest('[data-connected]').getAttribute('data-connected')`,
      ),
      'true',
    )
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="关闭 ${name}"]').click()`,
    )
    await pause(150)
    assert.equal(
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="连接 ${name}"]').closest('[data-connected]').getAttribute('data-connected')`,
      ),
      'false',
    )
    console.log(
      'Connection name truncates on one line; six actions in keyboard-accessible dropdown; independent edit, type icon and connected/disconnected highlight passed',
    )
    clearTimeout(timeout)
    w.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  }
})()
