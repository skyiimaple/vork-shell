const { app, BrowserWindow, dialog } = require('electron')
const { mkdtempSync, rmSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-settings-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
let destination = join(directory, 'connections.json')
dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const timer = setTimeout(() => {
  console.error('Settings smoke timeout')
  app.exit(1)
}, 30000)
async function wait(w, expression) {
  for (let i = 0; i < 150; i++) {
    if (await w.webContents.executeJavaScript(expression)) return
    await pause(40)
  }
  throw Error(expression)
}
;(async () => {
  try {
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((r) => w.webContents.once('did-finish-load', r))
    await w.webContents.executeJavaScript(
      "window.vork.saveProfile({name:'Local settings',type:'sqlite',path:':memory:'})",
    )
    await w.webContents.executeJavaScript('document.querySelector(\'[aria-label="设置"]\').click()')
    await wait(w, "document.querySelector('[role=dialog]')?.textContent.includes('连接配置')")
    assert.ok(
      await w.webContents.executeJavaScript(
        'Boolean(document.querySelector(\'[aria-label="设置主题"]\'))',
      ),
    )
    await w.webContents.executeJavaScript(
      "[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='导出 JSON').click()",
    )
    await wait(w, "document.querySelector('[role=dialog]')?.textContent.includes('已导出到')")
    const exported = JSON.parse(readFileSync(destination, 'utf8'))
    assert.equal(exported.format, 'vork-shell')
    assert.equal(exported.connections[0].type, 'sqlite')
    assert.ok(!JSON.stringify(exported).includes('password'))
    await w.webContents.executeJavaScript(
      "window.vork.connect({name:'Failure log',type:'redis',host:'127.0.0.1',port:1,password:'do-not-log-secret'}).catch(()=>{})",
    )
    await w.webContents.executeJavaScript(
      "[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='操作与错误日志').click()",
    )
    await wait(w, "document.querySelector('[role=dialog]')?.textContent.includes('Failure log')")
    const logs = await w.webContents.executeJavaScript('window.vork.activityLogs()')
    assert.ok(
      logs.entries.some(
        (row) =>
          row.level === 'error' && row.action === 'connect' && row.connection === 'Failure log',
      ),
    )
    assert.ok(!readFileSync(logs.path, 'utf8').includes('do-not-log-secret'))
    destination = join(directory, 'exported.jsonl')
    await w.webContents.executeJavaScript(
      "[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='导出日志').click()",
    )
    await wait(w, "document.querySelector('[role=dialog]')?.textContent.includes('已导出到')")
    assert.ok(readFileSync(destination, 'utf8').includes('Failure log'))
    console.log(
      'Settings, native JSON export, failed connection log persistence, viewer and log export passed',
    )
    clearTimeout(timer)
    w.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (e) {
    console.error(e)
    clearTimeout(timer)
    app.exit(1)
  }
})()
