const { app, BrowserWindow, dialog } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path'),
  { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-docker-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
dialog.showMessageBox = async () => ({ response: 1 })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function wait(w, e) {
  for (let i = 0; i < 250; i++) {
    if (await w.webContents.executeJavaScript(e)) return
    await pause(40)
  }
  throw Error(e)
}
const timer = setTimeout(() => {
  console.error('Docker desktop test timeout')
  app.exit(1)
}, 120000)
;(async () => {
  try {
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((r) => w.webContents.once('did-finish-load', r))
    assert.equal(
      await w.webContents.executeJavaScript(
        `Boolean(document.querySelector('[aria-label="添加连接"]'))`,
      ),
      false,
    )
    assert.equal(
      await w.webContents.executeJavaScript(
        `Boolean(document.querySelector('[aria-label="查看隐藏标签"]'))`,
      ),
      false,
    )
    for (let i = 0; i < 10; i++) {
      await w.webContents.executeJavaScript(
        `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='打开 SQLite').click()`,
      )
      await wait(w, `document.querySelectorAll('[data-session-tab]').length===${i + 1}`)
    }
    await wait(w, `Boolean(document.querySelector('[aria-label="查看隐藏标签"]'))`)
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="查看隐藏标签"]').click()`,
    )
    await wait(w, `Boolean(document.querySelector('[role=menuitem]'))`)
    await w.webContents.executeJavaScript(`document.querySelector('[role=menuitem]').click()`)
    await pause(100)
    const recentId = await w.webContents.executeJavaScript(
      `[...document.querySelectorAll('[data-session-tab]')].find(el=>el.className.includes('border-b-2')).dataset.sessionTab`,
    )
    await w.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',metaKey:true,bubbles:true}))`,
    )
    await wait(w, `Boolean(document.querySelector('[aria-label="搜索最近编辑的标签"]'))`)
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="搜索最近编辑的标签"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
    )
    await wait(w, `!document.querySelector('[role=dialog]')`)
    assert.equal(
      await w.webContents.executeJavaScript(
        `[...document.querySelectorAll('[data-session-tab]')].find(el=>el.className.includes('border-b-2')).dataset.sessionTab`,
      ),
      recentId,
    )
    console.log('Overflow tab dropdown, recent tab Cmd+P and Enter navigation passed')
    clearTimeout(timer)
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    await pause(200)
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})()
