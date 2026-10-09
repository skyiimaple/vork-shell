const { app, BrowserWindow, dialog } = require('electron')
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-import-smoke-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
const good = join(directory, 'connections.ano'),
  bad = join(directory, 'bad.ano')
const one = { name: 'Imported One', host: 'localhost', port: '6379', auth: 'fixture-import-secret' }
writeFileSync(
  good,
  Buffer.from(
    JSON.stringify([
      one,
      { ...one, name: 'Imported Two', port: 6380 },
      one,
      { ...one, cluster: true },
    ]),
  ).toString('base64'),
)
writeFileSync(bad, 'invalid-file-content')
let file = good
const originalPicker = dialog.showOpenDialog
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(window, expression) {
  for (let i = 0; i < 100; i++) {
    if (await window.webContents.executeJavaScript(expression)) return
    await pause(50)
  }
  throw new Error('Import UI condition failed')
}
async function click(window, text) {
  await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('[role=dialog] button')).find(el=>el.textContent.trim()===${JSON.stringify(text)}).click()`,
  )
}
const timeout = setTimeout(() => {
  console.error('Import smoke timed out')
  app.exit(1)
}, 30000)
;(async () => {
  try {
    await import('../out/main/index.js')
    await app.whenReady()
    const window = BrowserWindow.getAllWindows()[0]
    if (window.webContents.isLoading())
      await new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
    const open = async () => {
      await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="设置"]').click()`,
      )
      await wait(window, `Boolean(document.querySelector('[role=dialog]'))`)
      await window.webContents.executeJavaScript(
        `[...document.querySelectorAll('[role=dialog] button')].find(el=>el.textContent.trim()==='导入配置').click()`,
      )
      await wait(
        window,
        `document.querySelector('[role=dialog]')?.textContent.includes('选择配置文件')`,
      )
    }
    await open()
    await click(window, '选择配置文件')
    await wait(
      window,
      "document.querySelector('[role=dialog]').textContent.includes('可导入 2 条')",
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        "document.querySelector('[role=dialog]').textContent.includes('fixture-import-secret')",
      ),
      false,
    )
    await click(window, '取消')
    await wait(window, "!document.querySelector('[role=dialog]')")
    assert.deepEqual(await window.webContents.executeJavaScript('window.vork.profiles()'), [])
    await open()
    await click(window, '选择配置文件')
    await wait(
      window,
      "document.querySelector('[role=dialog]').textContent.includes('可导入 2 条')",
    )
    await click(window, '确认导入 2 条')
    await wait(window, "!document.querySelector('[role=dialog]')")
    const profiles = await window.webContents.executeJavaScript(
      'window.vork.profiles().then(rows=>rows.map(row=>({name:row.name,hasPassword:Boolean(row.password)})))',
    )
    assert.equal(profiles.length, 2)
    assert.ok(profiles.every((row) => row.hasPassword))
    assert.ok(
      !readFileSync(join(directory, 'connections.json'), 'utf8').includes('fixture-import-secret'),
    )
    await wait(window, 'document.querySelector(\'[aria-label="连接 Imported One"]\')!==null')
    assert.ok(
      await window.webContents.executeJavaScript(
        "document.body.textContent.includes('0 个活动连接')",
      ),
    )
    await open()
    await click(window, '选择配置文件')
    await wait(
      window,
      "document.querySelector('[role=dialog]').textContent.includes('可导入 0 条')",
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        "Array.from(document.querySelectorAll('[role=dialog] button')).find(el=>el.textContent.trim()==='确认导入 0 条').disabled",
      ),
      true,
    )
    await click(window, '取消')
    await wait(window, "!document.querySelector('[role=dialog]')")
    file = bad
    await open()
    await click(window, '选择配置文件')
    await wait(window, "document.querySelector('[role=dialog]').textContent.includes('无法识别')")
    console.log(
      'Import preview, cancel, encrypted atomic save, sidebar refresh, duplicate skip, unsupported mode and error UI passed; no servers connected',
    )
    clearTimeout(timeout)
    dialog.showOpenDialog = originalPicker
    window.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  }
})()
