const { app, BrowserWindow, clipboard, dialog } = require('electron')
const { mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-result-export-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
const timeout = setTimeout(() => app.exit(1), 30000)
;(async () => {
  try {
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    for (const format of ['csv', 'json', 'markdown', 'sql', 'xlsx']) {
      const path = join(directory, `result.${format}`)
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      await w.webContents.executeJavaScript(
        `(async()=>{const s=await window.vork.connect({type:'sqlite',name:'Export',path:':memory:'});try{const r=await window.vork.execute(s.id,"SELECT 'x|y' AS a, NULL AS b");await window.vork.exportResult(s.id,r,${JSON.stringify(format)},'export_target')}finally{await window.vork.disconnect(s.id)}})()`,
      )
      if (format === 'xlsx') {
        const ExcelJS = require('exceljs')
        const book = new ExcelJS.Workbook()
        await book.xlsx.readFile(path)
        assert.equal(book.worksheets[0].getCell('A2').value, 'x|y')
        continue
      }
      const text = readFileSync(path, 'utf8')
      if (format === 'sql') {
        const { DatabaseSync } = require('node:sqlite')
        const db = new DatabaseSync(':memory:')
        db.exec('CREATE TABLE export_target (a, b)')
        db.exec(text)
        assert.equal(db.prepare('SELECT a FROM export_target').get().a, 'x|y')
        db.close()
        continue
      }
      if (format === 'json') assert.deepEqual(JSON.parse(text).rows, [['x|y', null]])
      else assert.ok(text.includes(format === 'markdown' ? 'x\\|y' : 'x|y'))
    }
    const wait = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await w.webContents.executeJavaScript(expression)) return
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error(expression)
    }
    await w.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(el=>el.textContent.includes('打开 SQLite')).click()`,
    )
    await wait(
      `Boolean(document.querySelector('[aria-label="执行 SQL"]')) && !document.querySelector('[aria-label="执行 SQL"]').disabled`,
    )
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="执行 SQL"]').click()`,
    )
    await wait(`Boolean(document.querySelector('[aria-label="导出结果"]'))`)
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="设置结果列"]').click()`,
    )
    await wait(`Boolean(document.querySelector('[aria-label="显示第 2 列 version"]'))`)
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="显示第 2 列 version"]').click()`,
    )
    assert.equal(
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="显示第 1 列 message"]').disabled`,
      ),
      true,
    )
    await w.webContents.executeJavaScript(
      `document.querySelector('[data-slot="dialog-close"]').click()`,
    )
    await wait(`!document.querySelector('[aria-label="搜索结果列"]')`)
    assert.equal(
      await w.webContents.executeJavaScript(
        `Boolean(document.querySelector('[aria-label="排序 version"]'))`,
      ),
      false,
    )
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="查看 message 第 1 行"]').click()`,
    )
    await wait(`Boolean(document.querySelector('[aria-label="单元格原值"]'))`)
    assert.equal(
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="单元格原值"]').textContent`,
      ),
      'Hello, Vork',
    )
    await w.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(el=>el.textContent.includes('复制原值')).click()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(await clipboard.readText(), 'Hello, Vork')
    await w.webContents.executeJavaScript(
      `document.querySelector('[data-slot="dialog-close"]').click()`,
    )
    await wait(`!document.querySelector('[aria-label="单元格原值"]')`)
    await assert.rejects(
      w.webContents.executeJavaScript(`window.vork.copyText('x'.repeat(4*1024*1024+1))`),
    )
    await assert.rejects(w.webContents.executeJavaScript(`window.vork.copyText({invalid:true})`))
    console.log('Column visibility, last-column guard, full cell inspection and clipboard passed')
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="导出结果"]').click()`,
    )
    await wait(
      `Array.from(document.querySelectorAll('[role=menuitem]')).some(el=>el.textContent.includes('INSERT'))`,
    )
    await w.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=menuitem]')).find(el=>el.textContent.includes('INSERT')).click()`,
    )
    await wait(`Boolean(document.querySelector('[aria-label="INSERT 目标表名"]'))`)
    await w.webContents.executeJavaScript(
      `(()=>{const el=document.querySelector('[aria-label="INSERT 目标表名"]');el.value='ui_target';el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    const uiPath = join(directory, 'ui-export.sql')
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: uiPath })
    await w.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(el=>el.textContent.includes('导出 SQL 文件')).click()`,
    )
    await wait(`!document.querySelector('[aria-label="INSERT 目标表名"]')`)
    assert.ok(readFileSync(uiPath, 'utf8').includes('INSERT INTO "ui_target"'))
    for (const label of ['带表头 TSV', 'CSV', 'JSON', 'Markdown', 'INSERT SQL…']) {
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="复制结果"]').click()`,
      )
      await wait(
        `Array.from(document.querySelectorAll('[role=menuitem]')).some(el=>el.textContent.trim()===${JSON.stringify(label)})`,
      )
      await w.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[role=menuitem]')).find(el=>el.textContent.trim()===${JSON.stringify(label)}).click()`,
      )
      if (label.startsWith('INSERT')) {
        await wait(`Boolean(document.querySelector('[aria-label="INSERT 目标表名"]'))`)
        await w.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('[role=dialog] button')).find(el=>el.textContent.trim()==='复制 SQL').click()`,
        )
        await wait(`!document.querySelector('[aria-label="INSERT 目标表名"]')`)
        assert.ok((await clipboard.readText()).includes('INSERT INTO "ui_target"'))
      } else {
        await new Promise((resolve) => setTimeout(resolve, 150))
        const text = await clipboard.readText()
        if (label === 'JSON') {
          assert.equal(JSON.parse(text).rows[0][0], 'Hello, Vork')
          assert.equal(JSON.parse(text).columns.length, 2)
        } else assert.ok(text.includes('message'))
      }
    }
    console.log('Result export and five clipboard formats, including INSERT target dialog passed')
    if (process.env.VORK_EXPORT_DOCKER === '1')
      for (const dialect of ['mysql', 'postgresql']) {
        const { execFileSync } = require('node:child_process')
        const service = dialect === 'mysql' ? 'mysql' : 'postgres'
        const port = Number(
          execFileSync(
            'docker',
            ['port', `vork-test-${service}-1009`, dialect === 'mysql' ? '3306/tcp' : '5432/tcp'],
            { encoding: 'utf8' },
          )
            .trim()
            .split(':')
            .pop(),
        )
        const config = {
          type: dialect,
          name: 'Export',
          host: '127.0.0.1',
          port,
          username: 'vork',
          password: 'vork_test_only',
          database: 'vork_test',
        }
        const path = join(directory, dialect + '.sql')
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
        const source =
          dialect === 'mysql'
            ? "SELECT CAST(CONCAT('O''Reilly', CHAR(92), 'path') AS CHAR) AS a, NULL AS b"
            : "SELECT 'O''Reilly' || chr(92) || 'path' AS a, NULL AS b"
        const id = await w.webContents.executeJavaScript(
          `(async()=>{const s=await window.vork.connect(${JSON.stringify(config)});const r=await window.vork.execute(s.id,${JSON.stringify(source)});await window.vork.exportResult(s.id,r,'sql','export_target');return s.id})()`,
        )
        const sql = readFileSync(path, 'utf8')
        const rows = await w.webContents.executeJavaScript(
          `(async()=>{try{await window.vork.execute(${JSON.stringify(id)},'CREATE TEMPORARY TABLE export_target (a TEXT, b TEXT)');await window.vork.execute(${JSON.stringify(id)},${JSON.stringify(sql)});return (await window.vork.execute(${JSON.stringify(id)},'SELECT * FROM export_target')).rows}finally{await window.vork.disconnect(${JSON.stringify(id)})}})()`,
        )
        assert.deepEqual(rows, [["O'Reilly\\path", null]])
        console.log(dialect + ': generated INSERT round trip passed')
      }
    dialog.showSaveDialog = async () => ({ canceled: true })
    const canceled = await w.webContents.executeJavaScript(
      `(async()=>{const s=await window.vork.connect({type:'sqlite',name:'Cancel',path:':memory:'});try{return await window.vork.exportResult(s.id,await window.vork.execute(s.id,'SELECT 1'),'json')}finally{await window.vork.disconnect(s.id)}})()`,
    )
    assert.equal(canceled, null)
    console.log(
      'SQLite result CSV/JSON/Markdown/INSERT/XLSX files and canceled export passed through isolated preload/IPC',
    )
    clearTimeout(timeout)
    w.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    const failed = BrowserWindow.getAllWindows()[0]
    if (failed)
      console.error(
        await failed.webContents.executeJavaScript('document.body.innerText.slice(-2000)'),
      )
    clearTimeout(timeout)
    app.exit(1)
  }
})()
