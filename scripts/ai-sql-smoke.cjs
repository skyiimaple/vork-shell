const { app, BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path'),
  { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-ai-ui-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
const requests = []
const server = createServer(async (req, res) => {
  let text = ''
  for await (const chunk of req) text += chunk
  const body = JSON.parse(text)
  requests.push(body)
  res.setHeader('content-type', 'application/json')
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: '以下 SQL 需审查：\n```sql\nCREATE TABLE ai_should_not_run(id INTEGER);\n```',
          },
          finish_reason: 'stop',
        },
      ],
    }),
  )
})
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(w, code) {
  for (let i = 0; i < 150; i++) {
    if (await w.webContents.executeJavaScript(code)) return
    await pause(40)
  }
  throw new Error(code)
}
async function button(w, text) {
  await w.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(el=>el.offsetParent!==null && el.textContent.trim()===${JSON.stringify(text)}).click()`,
  )
}
async function input(w, label, value) {
  await w.webContents.executeJavaScript(
    `(()=>{const el=document.querySelector('[aria-label=${JSON.stringify(label)}]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await pause(50)
}
const timer = setTimeout(() => app.exit(1), 30000)
;(async () => {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    await button(w, '打开 SQLite')
    await wait(w, `Boolean(document.querySelector('[aria-label="AI SQL 助手"]'))`)
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="AI SQL 助手"]').click()`,
    )
    await wait(w, `Boolean(document.querySelector('[aria-label="AI 模型名称"]'))`)
    await input(w, 'AI 服务地址', 'http://127.0.0.1:' + server.address().port + '/v1')
    await input(w, 'AI 模型名称', 'local-fixture')
    await button(w, '保存 AI 配置')
    await wait(
      w,
      `!document.querySelector('[aria-label="AI 模型名称"]') && document.body.textContent.includes('local-fixture')`,
    )
    await input(w, 'AI 需求', '生成一个建表语句，等待我审查')
    await button(w, '发送给 AI')
    await wait(w, `Boolean(document.querySelector('[aria-label="AI SQL 建议"]'))`)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].model, 'local-fixture')
    assert.equal(JSON.stringify(requests[0]).includes('password'), false)
    assert.equal(requests[0].max_tokens, 4096)
    await button(w, '替换编辑器内容')
    await wait(
      w,
      `!document.querySelector('[aria-label="AI 回答"]') && document.querySelector('[aria-label="SQL 查询"]').textContent.includes('CREATE TABLE ai_should_not_run')`,
    )
    await pause(500)
    const count = await w.webContents.executeJavaScript(
      `(async()=>{const s=JSON.parse(localStorage.getItem('vork.workspace.v1')).tabs[0].session;return (await window.vork.execute(s.id,"SELECT COUNT(*) FROM sqlite_schema WHERE name='ai_should_not_run'")).rows[0][0]})()`,
    )
    assert.equal(count, 0, 'Applying AI SQL must never execute it')
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="执行 SQL"]').click()`,
    )
    await wait(
      w,
      `Boolean(document.querySelector('[role=dialog]')) && document.body.textContent.includes('确认执行 AI SQL')`,
    )
    await button(w, '取消')
    await wait(w, `!document.querySelector('[role=dialog]')`)
    const stillEmpty = await w.webContents.executeJavaScript(
      `(async()=>{const s=JSON.parse(localStorage.getItem('vork.workspace.v1')).tabs[0].session;return (await window.vork.execute(s.id,"SELECT COUNT(*) FROM sqlite_schema WHERE name='ai_should_not_run'")).rows[0][0]})()`,
    )
    assert.equal(stillEmpty, 0)
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="执行 SQL"]').click()`,
    )
    await wait(w, `Boolean(document.querySelector('[role=dialog]'))`)
    await button(w, '确认执行 AI SQL')
    await wait(
      w,
      `!document.querySelector('[role=dialog]') && document.body.textContent.includes('执行结果')`,
    )
    const exists = await w.webContents.executeJavaScript(
      `(async()=>{const s=JSON.parse(localStorage.getItem('vork.workspace.v1')).tabs[0].session;return (await window.vork.execute(s.id,"SELECT COUNT(*) FROM sqlite_schema WHERE name='ai_should_not_run'")).rows[0][0]})()`,
    )
    assert.equal(exists, 1)
    const settings = await w.webContents.executeJavaScript('window.vork.aiSettings()')
    assert.equal(settings.model, 'local-fixture')
    console.log(
      'AI SQL UI: saved local provider, HTTP request, review and editor replacement passed; SQL runs only after explicit execution confirmation',
    )
    clearTimeout(timer)
    w.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (e) {
    console.error(e)
    const w = BrowserWindow.getAllWindows()[0]
    if (w)
      console.error(await w.webContents.executeJavaScript('document.body.innerText.slice(-4000)'))
    clearTimeout(timer)
    server.closeAllConnections()
    server.close()
    app.exit(1)
  }
})()
