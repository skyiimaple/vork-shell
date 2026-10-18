const { app, BrowserWindow, dialog } = require('electron')
const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } = require('node:fs')
const { join } = require('node:path'),
  { tmpdir } = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-er-ui-')),
  database = join(directory, 'fixture.sqlite')
const db = new DatabaseSync(database)
db.exec(
  'CREATE TABLE parent(a INTEGER,b TEXT,PRIMARY KEY(a,b));CREATE TABLE child(id INTEGER PRIMARY KEY,x INTEGER,y TEXT,FOREIGN KEY(x,y) REFERENCES parent);CREATE TABLE orphan(id INTEGER)',
)
app.setPath('userData', directory)
writeFileSync(
  join(directory, 'connections.json'),
  JSON.stringify([{ id: 'fixture', type: 'sqlite', name: 'ERFixture', path: database }]),
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
    `Array.from(document.querySelectorAll('button')).find(el=>el.offsetParent!==null && el.textContent.trim().startsWith(${JSON.stringify(text)})).click()`,
  )
}
async function click(w, label) {
  await w.webContents.executeJavaScript(
    `document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`,
  )
}
const timer = setTimeout(() => app.exit(1), 45000)
;(async () => {
  try {
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    await wait(w, `Boolean(document.querySelector('[aria-label="连接 ERFixture"]'))`)
    await click(w, '连接 ERFixture')
    await wait(w, `Boolean(document.querySelector('[aria-label="查看结构 main.child"]'))`)
    await click(w, '查看结构 main.child')
    await wait(
      w,
      `document.body.textContent.includes('结构管理') && !Array.from(document.querySelectorAll('button')).find(el=>el.textContent==='ER 关系图')?.disabled`,
    )
    await button(w, 'ER 关系图')
    await wait(
      w,
      `Boolean(document.querySelector('[aria-label="ER 关系图画布"] [aria-label="查看实体 main.parent"]'))`,
    )
    const canvas = '[aria-label="ER 关系图画布"]'
    const selector = canvas + ' [aria-label="查看实体 main.child"]'
    const before = await w.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).getAttribute('transform')`,
    )
    const point = await w.webContents.executeJavaScript(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+20),y:Math.round(r.y+8)}})()`,
    )
    w.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    w.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 30, y: point.y + 20 })
    w.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      x: point.x + 30,
      y: point.y + 20,
    })
    await wait(
      w,
      `document.querySelector(${JSON.stringify(selector)}).getAttribute('transform')!==${JSON.stringify(before)}`,
    )
    const after = await w.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).getAttribute('transform')`,
    )
    const zoom = await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="关系图缩放比例"]').textContent`,
    )
    await click(w, '放大关系图')
    await wait(
      w,
      `document.querySelector('[aria-label="关系图缩放比例"]').textContent!==${JSON.stringify(zoom)}`,
    )
    const path = join(directory, 'diagram.svg')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    await button(w, '导出 SVG')
    await wait(w, `document.body.textContent.includes('已导出：')`)
    const svg = readFileSync(path, 'utf8')
    assert.ok(svg.includes('<svg'))
    assert.ok(svg.includes('main.child'))
    assert.ok(svg.includes(after))
    assert.ok(svg.includes('<path'))
    await click(w, 'ER 选表 main.parent')
    await button(w, '生成关系图')
    await wait(
      w,
      `document.querySelector(${JSON.stringify(canvas)}).textContent.includes('未加载字段')`,
    )
    await w.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(canvas + ' [aria-label="查看实体 main.parent"]')}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
    )
    await wait(
      w,
      `document.querySelector('[aria-label="ER 对象详情"]').textContent.includes('加载该表字段')`,
    )
    await button(w, '加载该表字段')
    await wait(
      w,
      `!document.querySelector(${JSON.stringify(canvas)}).textContent.includes('未加载字段')`,
    )
    await w.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(canvas + ' [aria-label^="外键 "]')}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
    )
    await wait(
      w,
      `document.querySelector('[aria-label="ER 对象详情"]').textContent.includes('x → a') && document.querySelector('[aria-label="ER 对象详情"]').textContent.includes('y → b')`,
    )
    await w.webContents.executeJavaScript(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    )
    mkdirSync(join(process.cwd(), '.artifacts'), { recursive: true })
    writeFileSync(
      join(process.cwd(), '.artifacts/er-diagram.png'),
      (await w.webContents.capturePage()).toPNG(),
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM child').get().n, 0)
    console.log(
      'ER UI: entry, composite relationship, dragging, zoom, external table loading and SVG layout export passed',
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
      console.error(await w.webContents.executeJavaScript('document.body.innerText.slice(-4000)'))
    clearTimeout(timer)
    app.exit(1)
  }
})()
