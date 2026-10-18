const { app, BrowserWindow, dialog } = require('electron')
const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } = require('node:fs')
const { join } = require('node:path'),
  { tmpdir } = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-compare-ui-')),
  a = join(directory, 'left.sqlite'),
  b = join(directory, 'right.sqlite')
const left = new DatabaseSync(a),
  right = new DatabaseSync(b)
left.exec(
  "CREATE TABLE items(id INTEGER PRIMARY KEY,title VARCHAR(40) NOT NULL DEFAULT 'old');CREATE INDEX title_idx ON items(title)",
)
right.exec('CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT,extra INTEGER)')
app.setPath('userData', directory)
writeFileSync(
  join(directory, 'connections.json'),
  JSON.stringify([
    { id: 'left', name: 'Left', type: 'sqlite', path: a },
    { id: 'right', name: 'Right', type: 'sqlite', path: b },
  ]),
)
require('./smoke-window.cjs')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(w, code) {
  for (let i = 0; i < 150; i++) {
    if (await w.webContents.executeJavaScript(code)) return
    await pause(50)
  }
  throw new Error(code)
}
async function button(w, text) {
  await w.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(el=>el.offsetParent!==null&&el.textContent.trim()===${JSON.stringify(text)}).click()`,
  )
}
async function select(w, label, text) {
  await w.webContents.executeJavaScript(
    `document.querySelector('[aria-label=${JSON.stringify(label)}]').focus()`,
  )
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
  await wait(
    w,
    `Array.from(document.querySelectorAll('[role=option]')).some(el=>el.textContent.includes(${JSON.stringify(text)}))`,
  )
  const point = await w.webContents.executeJavaScript(
    `(()=>{const r=Array.from(document.querySelectorAll('[role=option]')).find(el=>el.textContent.includes(${JSON.stringify(text)})).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
  )
  w.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  w.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await wait(w, `!document.querySelector('[role=listbox]')`)
}
const timer = setTimeout(() => app.exit(1), 45000)
;(async () => {
  try {
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    await wait(w, `Boolean(document.querySelector('[aria-label="连接 Left"]'))`)
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="连接 Left"]').click()`,
    )
    await wait(w, `Boolean(document.querySelector('[aria-label="查看结构 main.items"]'))`)
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="查看结构 main.items"]').click()`,
    )
    await wait(
      w,
      `Array.from(document.querySelectorAll('button')).some(el=>el.textContent==='结构对比'&&!el.disabled)`,
    )
    await button(w, '结构对比')
    await wait(
      w,
      `Boolean(document.querySelector('[aria-label="结构对比目标连接"]')) && !document.querySelector('[aria-label="结构对比目标连接"]').disabled`,
    )
    const before = await w.webContents.executeJavaScript(
      `(async()=> (await window.vork.structureSources()).filter(item=>item.kind==='session').length)()`,
    )
    await select(w, '结构对比目标连接', 'Right')
    await button(w, '开始对比')
    await wait(
      w,
      `document.querySelector('[aria-label="结构差异列表"]')?.textContent.includes('title')`,
    )
    await w.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[aria-label="结构差异列表"] button')).find(el=>el.textContent.includes('items · title')&&!el.textContent.includes('title_idx')).click()`,
    )
    await wait(
      w,
      `document.querySelector('[aria-label="结构差异源值"]').textContent.includes('VARCHAR(40)') && document.querySelector('[aria-label="结构差异目标值"]').textContent.includes('TEXT')`,
    )
    const after = await w.webContents.executeJavaScript(
      `(async()=> (await window.vork.structureSources()).filter(item=>item.kind==='session').length)()`,
    )
    assert.equal(after, before, 'Saved-profile temporary connections must be released')
    const path = join(directory, 'report.json')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    await button(w, '导出报告 JSON')
    await wait(w, `document.body.textContent.includes('已导出报告：')`)
    const report = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(report.source.name, 'Left')
    assert.equal(report.target.name, 'Right')
    assert.ok(
      report.differences.some(
        (row) => row.kind === 'index' && row.name === 'title_idx' && row.change === 'source-only',
      ),
    )
    assert.ok(
      report.differences.some(
        (row) => row.kind === 'column' && row.name === 'extra' && row.change === 'target-only',
      ),
    )
    assert.equal(left.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0)
    assert.equal(right.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0)
    await pause(200)
    await w.webContents.executeJavaScript(
      `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
    )
    mkdirSync(join(process.cwd(), '.artifacts'), { recursive: true })
    writeFileSync(
      join(process.cwd(), '.artifacts/structure-compare.png'),
      (await w.webContents.capturePage()).toPNG(),
    )
    console.log(
      'Structure compare UI: connected/saved sources, exact field/index differences, temporary cleanup, JSON export and no data writes passed',
    )
    clearTimeout(timer)
    w.destroy()
    left.close()
    right.close()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (e) {
    console.error(e)
    const w = BrowserWindow.getAllWindows()[0]
    if (w)
      console.error(await w.webContents.executeJavaScript('document.body.innerText.slice(-5000)'))
    clearTimeout(timer)
    app.exit(1)
  }
})()
