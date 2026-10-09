const { app, BrowserWindow, dialog } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path'),
  { tmpdir } = require('node:os')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-docker-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
dialog.showMessageBox = async () => ({ response: 1 })
const port = (type, internal) =>
  Number(
    execFileSync('docker', ['port', `vork-test-${type}-1009`, `${internal}/tcp`], {
      encoding: 'utf8',
    })
      .trim()
      .split(':')
      .pop(),
  )
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
    const configs = [
      { name: 'Docker Redis', type: 'redis', host: '127.0.0.1', port: port('redis', 6379) },
    ]
    const client = require('redis').createClient({
      url: `redis://127.0.0.1:${port('redis', 6379)}`,
    })
    client.on('error', () => {})
    await client.connect()
    const prefix = 'vork_bulk_' + Date.now()
    const testKeys = [prefix + 'a', prefix + 'b', prefix + 'c']
    for (const key of testKeys) await client.set(key, 'test')
    for (const config of configs)
      await w.webContents.executeJavaScript(`window.vork.saveProfile(${JSON.stringify(config)})`)
    w.webContents.reload()
    await new Promise((r) => w.webContents.once('did-finish-load', r))
    for (const config of configs) {
      const selector = JSON.stringify(`[aria-label="连接 ${config.name}"]`)
      await wait(w, `Boolean(document.querySelector(${selector}))`)
      await w.webContents.executeJavaScript(`document.querySelector(${selector}).click()`)
      await wait(w, `Boolean(document.querySelector('[aria-label="关闭连接 ${config.name}"]'))`)
      for (const key of testKeys) {
        await wait(w, `Boolean(document.querySelector('[aria-label="选择 Redis 键 ${key}"]'))`)
        await w.webContents.executeJavaScript(
          `document.querySelector('[aria-label="选择 Redis 键 ${key}"]').click()`,
        )
      }
      await w.webContents.executeJavaScript(
        `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='设置 TTL').click()`,
      )
      await wait(w, `Boolean(document.querySelector('[role=alertdialog]'))`)
      await w.webContents.executeJavaScript(
        `[...document.querySelectorAll('[role=alertdialog] button')].find(b=>b.textContent.trim()==='确认修改').click()`,
      )
      await pause(1000)
      for (const key of testKeys)
        assert.ok((await client.ttl(key)) > 0, 'Confirm button must apply TTL')
      console.log('Bulk TTL confirmation persisted to Redis')
      await wait(w, `!document.querySelector('[role=alertdialog]')`)
      await w.webContents.executeJavaScript(
        `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='永久保留').click()`,
      )
      await wait(w, `Boolean(document.querySelector('[role=alertdialog]'))`)
      await w.webContents.executeJavaScript(
        `[...document.querySelectorAll('[role=alertdialog] button')].find(b=>b.textContent.trim()==='确认修改').click()`,
      )
      await pause(1000)
      for (const key of testKeys) assert.equal(await client.ttl(key), -1)
      await wait(w, `!document.querySelector('[role=alertdialog]')`)
      await w.webContents.executeJavaScript(
        `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='删除已选').click()`,
      )
      await wait(w, `Boolean(document.querySelector('[role=alertdialog]'))`)
      await w.webContents.executeJavaScript(
        `[...document.querySelectorAll('[role=alertdialog] button')].find(b=>b.textContent.trim()==='确认修改').click()`,
      )
      await pause(1000)
      for (const key of testKeys) assert.equal(await client.exists(key), 0)
      console.log('Three selected keys deleted through confirmation')
      await client.del(testKeys)
      await client.quit()
      console.log('Redis batch TTL confirmation passed')
    }
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
