const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path'),
  { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-ai-ui-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
const requests = []
let releaseStream = () => {}
const streamGate = new Promise((resolve) => {
  releaseStream = resolve
})
const upstream = http.createServer(async (req, res) => {
  let text = ''
  for await (const chunk of req) text += chunk
  requests.push({ body: JSON.parse(text), proxy: req.headers['x-test-proxy'] || '' })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'STREAMING_PARTIAL\n' } }] })}\n\n`,
  )
  await streamGate
  res.write(
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            content: '以下 SQL 需审查：\n```sql\nCREATE TABLE ai_should_not_run(id INTEGER);\n```',
          },
          finish_reason: 'stop',
        },
      ],
    })}\n\n`,
  )
  res.write('data: [DONE]\n\n')
  res.end()
})
let proxyHits = 0
const proxy = http.createServer((req, res) => {
  proxyHits += 1
  let target
  try {
    target = new URL(req.url || '')
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  const headers = { ...req.headers, host: target.host, 'x-test-proxy': '1' }
  delete headers['proxy-authorization']
  delete headers['proxy-connection']
  const forwarded = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    },
  )
  forwarded.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
  req.pipe(forwarded)
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
async function closeServers() {
  releaseStream()
  upstream.closeAllConnections()
  proxy.closeAllConnections()
  await new Promise((resolve) => upstream.close(resolve))
  await new Promise((resolve) => proxy.close(resolve))
}
const timer = setTimeout(() => app.exit(1), 45000)
;(async () => {
  try {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
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
    await input(w, 'AI 服务地址', 'http://127.0.0.1:' + upstream.address().port + '/v1')
    await input(w, 'AI 模型名称', 'local-fixture')
    await input(w, 'AI 代理地址', 'http://127.0.0.1:' + proxy.address().port)
    await button(w, '保存 AI 配置')
    await wait(
      w,
      `!document.querySelector('[aria-label="AI 模型名称"]') && document.body.textContent.includes('local-fixture')`,
    )
    await input(w, 'AI 需求', '生成一个建表语句，等待我审查')
    await button(w, '发送给 AI')
    await wait(w, `document.body.textContent.includes('STREAMING_PARTIAL')`)
    assert.equal(
      await w.webContents.executeJavaScript(
        `Boolean(document.querySelector('[aria-label="AI SQL 建议"]'))`,
      ),
      false,
    )
    releaseStream()
    await wait(w, `Boolean(document.querySelector('[aria-label="AI SQL 建议"]'))`)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body.model, 'local-fixture')
    assert.equal(requests[0].body.stream, true)
    assert.equal(requests[0].body.max_tokens, 4096)
    assert.equal(requests[0].proxy, '1')
    assert.equal(proxyHits, 1)
    assert.equal(JSON.stringify(requests[0].body).includes('password'), false)
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
    assert.equal(settings.proxyUrl, 'http://127.0.0.1:' + proxy.address().port)
    assert.equal(settings.hasProxyPassword, false)
    assert.equal(JSON.stringify(settings).includes('proxy-secret'), false)
    console.log(
      'AI SQL UI: streamed local provider through HTTP proxy, review and editor replacement passed; SQL runs only after explicit execution confirmation',
    )
    clearTimeout(timer)
    w.destroy()
    await closeServers()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (e) {
    console.error(e)
    const w = BrowserWindow.getAllWindows()[0]
    if (w)
      console.error(await w.webContents.executeJavaScript('document.body.innerText.slice(-4000)'))
    clearTimeout(timer)
    await closeServers().catch(() => {})
    app.exit(1)
  }
})()
