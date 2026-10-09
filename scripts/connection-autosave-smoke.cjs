const { app, BrowserWindow, dialog } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs'),
  { join } = require('node:path'),
  { tmpdir } = require('node:os'),
  { execFileSync } = require('node:child_process'),
  assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-autosave-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
dialog.showMessageBox = async () => ({ response: 1 })
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function wait(w, e) {
  for (let i = 0; i < 200; i++) {
    if (await w.webContents.executeJavaScript(e)) return
    await pause(40)
  }
  throw Error(e)
}
const timer = setTimeout(() => app.exit(1), 30000)
;(async () => {
  try {
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((r) => w.webContents.once('did-finish-load', r))
    const port = Number(
      execFileSync('docker', ['port', 'vork-test-ssh-1009', '2222/tcp'], { encoding: 'utf8' })
        .trim()
        .split(':')
        .pop(),
    )
    await w.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="新建连接"]\').click()',
    )
    await wait(w, "Boolean(document.querySelector('[role=dialog] form'))")
    const values = {
      连接名称: 'Autosaved SSH',
      主机: '127.0.0.1',
      端口: String(port),
      用户名: 'vork',
      密码: 'vork_test_only',
    }
    await w.webContents.executeJavaScript(
      `(()=>{const values=${JSON.stringify(values)};for(const [name,value] of Object.entries(values)){const label=[...document.querySelectorAll('[role=dialog] label')].find(el=>el.querySelector('span')?.textContent.trim()===name);const input=label.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))}})()`,
    )
    await pause(100)
    await w.webContents.executeJavaScript(
      "document.querySelector('[role=dialog] form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))",
    )
    await wait(w, 'Boolean(document.querySelector(\'[aria-label="关闭连接 Autosaved SSH"]\'))')
    await wait(w, "Boolean(document.querySelector('.xterm'))")
    await wait(w, 'Boolean(document.querySelector(\'[aria-label="连接 Autosaved SSH"]\'))')
    assert.ok(
      await w.webContents.executeJavaScript(
        "!document.body.textContent.includes('Failed to fetch dynamically imported module')",
      ),
    )
    const profiles = await w.webContents.executeJavaScript('window.vork.profiles()')
    assert.equal(profiles.length, 1)
    assert.equal(profiles[0].name, 'Autosaved SSH')
    assert.ok(
      await w.webContents.executeJavaScript(
        "document.querySelector('[aria-label=\"连接 Autosaved SSH\"]').closest('[data-connected]').dataset.connected==='true'",
      ),
    )
    await w.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="关闭连接 Autosaved SSH"]\').click()',
    )
    w.webContents.reload()
    await new Promise((r) => w.webContents.once('did-finish-load', r))
    await wait(w, 'Boolean(document.querySelector(\'[aria-label="连接 Autosaved SSH"]\'))')
    console.log(
      'New SSH connection auto-saved, sidebar identity/highlight, terminal mount and persistence passed',
    )
    clearTimeout(timer)
    w.destroy()
    await pause(200)
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (e) {
    console.error(e)
    clearTimeout(timer)
    app.exit(1)
  }
})()
