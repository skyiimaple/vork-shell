const { app, BrowserWindow, dialog } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-enhancements-'))
app.setPath('userData', directory)
writeFileSync(
  join(directory, 'connections.json'),
  JSON.stringify([
    { id: 'alpha', name: 'Alpha', type: 'sqlite', path: ':memory:', group: '开发' },
    { id: 'beta', name: 'Beta', type: 'sqlite', path: ':memory:', group: '生产' },
  ]),
)
require('./smoke-window.cjs')
require('../out/main/index.js')
const timeout = setTimeout(() => {
  console.error('Enhancements smoke timeout')
  app.exit(1)
}, 30000)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(window, expression) {
  for (let i = 0; i < 100; i++) {
    if (await window.webContents.executeJavaScript(expression)) return
    await pause(50)
  }
  throw new Error('UI condition failed: ' + expression)
}
async function click(window, text) {
  await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`,
  )
}
async function edit(window, selector, text) {
  await pause(200)
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)}).focus()`,
  )
  const nativeInput = await window.webContents.executeJavaScript(
    `(() => {const el=document.querySelector(${JSON.stringify(selector)});if(el instanceof HTMLInputElement){el.select();return true}return false})()`,
  )
  if (!nativeInput)
    await window.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',metaKey:${process.platform === 'darwin'},ctrlKey:${process.platform !== 'darwin'},bubbles:true,cancelable:true}))`,
    )
  await window.webContents.insertText(text)
  await pause(100)
}
app.whenReady().then(async () => {
  const window = BrowserWindow.getAllWindows()[0],
    errors = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message)
  })
  try {
    if (window.webContents.isLoading())
      await new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
    await wait(window, "document.body.textContent.includes('Alpha')")
    // End-to-end worker tools and native file-dialog bridge, with dedicated temporary files.
    const csv = join(directory, 'input.csv'),
      dump = join(directory, 'dump.sql')
    writeFileSync(csv, 'id,text\n1,"hello, CSV"\n2,second\n')
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [csv] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: dump })
    const bridge = await window.webContents.executeJavaScript(`(async () => {
      const config = (await window.vork.profiles())[0]; const session = await window.vork.connect(config);
      await window.vork.execute(session.id,'CREATE TABLE t(id INTEGER PRIMARY KEY,text TEXT)');
      const imported = await window.vork.execute(session.id,'.import t');
      await window.vork.execute(session.id,'.dump');
      await window.vork.recordQuery(session.id,'SELECT 22 AS restored');
      const duplicate = await window.vork.duplicateSession(session.id);
      const independent = await window.vork.execute(duplicate.id,"SELECT count(*) FROM sqlite_schema WHERE name='t'");
      await window.vork.disconnect(duplicate.id); await window.vork.disconnect(session.id);
      return { imported: imported.affectedRows, independent: independent.rows[0][0] };
    })()`)
    assert.deepEqual(bridge, { imported: 2, independent: 0 })
    const restored = new DatabaseSync(':memory:')
    restored.exec(readFileSync(dump, 'utf8'))
    assert.equal(restored.prepare('SELECT count(*) AS n FROM t').get().n, 2)
    restored.close()
    await click(window, '查询历史')
    await wait(window, "document.body.textContent.includes('SELECT 22 AS restored')")
    await window.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('[role=dialog] button')).find(b => b.textContent.includes('SELECT 22 AS restored')).click()",
    )
    await wait(
      window,
      "document.querySelector('[aria-label=\"SQL 查询\"]')?.textContent.includes('SELECT 22 AS restored')",
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        "document.body.textContent.includes('运行第一条查询')",
      ),
      true,
    )
    await edit(window, '[aria-label="SQL 查询"]', 'select 10 as n union all select 2 as n;')
    await window.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('执行') && b.textContent.includes('⌘')).click()",
    )
    await wait(
      window,
      "document.querySelector('[data-slot=table]')?.getAttribute('aria-rowcount') === '3'",
    )
    await window.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="排序 n"]\').click()',
    )
    await wait(
      window,
      "document.querySelector('[data-slot=table] tbody tr td:nth-child(2)')?.textContent === '2'",
    )
    const initial = await window.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="调整列宽 n"]\').parentElement.getBoundingClientRect().width',
    )
    await window.webContents.executeJavaScript(
      "document.querySelector('[aria-label=\"调整列宽 n\"]').dispatchEvent(new PointerEvent('pointerdown',{clientX:200,bubbles:true})); window.dispatchEvent(new PointerEvent('pointermove',{clientX:260})); window.dispatchEvent(new PointerEvent('pointerup'))",
    )
    await wait(
      window,
      `document.querySelector('[aria-label="调整列宽 n"]').parentElement.getBoundingClientRect().width > ${initial + 40}`,
    )
    await click(window, '格式化 SQL')
    await click(window, '快捷键')
    await edit(window, '[aria-label="执行查询/命令快捷键"]', 'Mod-Shift-Enter')
    await click(window, '保存快捷键')
    await wait(
      window,
      "JSON.parse(localStorage.getItem('vork-shortcuts'))?.execute === 'Mod-Shift-Enter'",
    )
    await edit(window, '[aria-label="SQL 查询"]', 'SELECT 33 AS changed')
    await window.webContents.executeJavaScript(
      "document.querySelector('[aria-label=\"SQL 查询\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,shiftKey:true,bubbles:true}))",
    )
    await wait(
      window,
      "document.querySelector('[data-slot=table] tbody tr td:nth-child(2)')?.textContent === '33'",
    )
    // Move connection between folders through the actual sidebar events.
    await window.webContents.executeJavaScript(
      `(() => {const rows=Array.from(document.querySelectorAll('[draggable="true"]')); const a=rows.find(r=>r.textContent.includes('Alpha')),b=rows.find(r=>r.textContent.includes('Beta')); const transfer=new DataTransfer(); a.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer})); b.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));})()`,
    )
    await wait(window, "!document.body.textContent.includes('开发')")
    const profiles = await window.webContents.executeJavaScript('window.vork.profiles()')
    assert.equal(profiles.find((p) => p.id === 'alpha').group, '生产')
    mkdirSync(resolve('.artifacts'), { recursive: true })
    writeFileSync(
      resolve('.artifacts/enhancements.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    assert.deepEqual(errors, [])
    console.log(
      'Enhancements desktop smoke passed: SQLite import/dump, independent duplication, cross-connection history restore without execution, sorting/resizing, custom shortcuts, folder drag move.',
    )
    clearTimeout(timeout)
    window.close()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    console.error(errors)
    console.error(await window.webContents.executeJavaScript('document.body.textContent'))
    clearTimeout(timeout)
    rmSync(directory, { recursive: true, force: true })
    app.exit(1)
  }
})
