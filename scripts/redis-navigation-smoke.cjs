const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path'),
  { tmpdir } = require('node:os')
const { spawn } = require('node:child_process'),
  { createServer } = require('node:net')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-redis-navigation-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
let redis, client
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const timeout = setTimeout(() => {
  redis?.kill()
  console.error('Redis navigation smoke timeout')
  app.exit(1)
}, 30000)
async function wait(w, e) {
  for (let i = 0; i < 150; i++) {
    if (await w.webContents.executeJavaScript(e)) return
    await pause(40)
  }
  throw new Error('Redis UI condition failed: ' + e)
}
;(async () => {
  try {
    const server = createServer()
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    await new Promise((r) => server.close(r))
    redis = spawn(process.env.VORK_REDIS_SERVER, [
      '--bind',
      '127.0.0.1',
      '--port',
      String(port),
      '--save',
      '',
      '--appendonly',
      'no',
      '--dir',
      directory,
    ])
    await new Promise((resolve, reject) => {
      redis.on('error', reject)
      redis.stdout.on('data', (data) => {
        if (data.toString().includes('Ready to accept connections')) resolve()
      })
    })
    client = require('redis').createClient({ url: `redis://127.0.0.1:${port}` })
    client.on('error', () => {})
    await client.connect()
    await client.mSet({ 'fpsb:one': '1', 'fpsb:two': '2', unrelated: '3' })
    await client.select(1)
    await client.set('db-one-key', 'one')
    await client.select(0)
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((r) => w.webContents.once('did-finish-load', r))
    await w.webContents.executeJavaScript(
      `window.vork.saveProfile({name:'Navigation Redis',type:'redis',host:'127.0.0.1',port:${port}})`,
    )
    w.webContents.reload()
    await new Promise((r) => w.webContents.once('did-finish-load', r))
    await wait(w, 'Boolean(document.querySelector(\'[aria-label="连接 Navigation Redis"]\'))')
    await w.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="连接 Navigation Redis"]\').click()',
    )
    await wait(w, 'Boolean(document.querySelector(\'[aria-label="Redis 数据库切换"]\'))')
    await w.webContents.executeJavaScript(
      "(()=>{const input=document.querySelector('[aria-label=\"Redis 键匹配模式\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'fpsb');input.dispatchEvent(new Event('input',{bubbles:true}));})()",
    )
    await pause(100)
    await w.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="搜索 Redis 键"]\').click()',
    )
    await wait(
      w,
      "document.querySelector('[aria-label=\"Redis 键匹配模式\"]').value==='fpsb' && document.body.textContent.includes('2 已加载')",
    )
    await w.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="Redis 数据库切换"]\').focus()',
    )
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await pause(100)
    await wait(
      w,
      "Array.from(document.querySelectorAll('[role=option]')).some(el=>el.textContent.includes('db1 ·'))",
    )
    const point = await w.webContents.executeJavaScript(
      "(()=>{const el=Array.from(document.querySelectorAll('[role=option]')).find(el=>el.textContent.includes('db1 ·'));const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
    )
    w.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    w.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await wait(
      w,
      "document.querySelector('[aria-label=\"Redis 数据库切换\"]').textContent.includes('db1 ·')",
    )
    await w.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="查看当前连接详情"]\').click()',
    )
    await wait(
      w,
      "document.querySelector('[role=dialog]')?.textContent.includes('Navigation Redis')",
    )
    assert.ok(
      await w.webContents.executeJavaScript(
        "document.querySelector('[role=dialog]').textContent.includes('数据库1')",
      ),
    )
    await wait(w, "document.querySelector('[role=dialog]')?.textContent.includes('redis_version')")
    assert.ok(
      await w.webContents.executeJavaScript(
        "document.querySelector('[role=dialog]').textContent.includes('数据库键统计') && document.querySelector('[role=dialog]').textContent.includes('Redis 信息全集')",
      ),
    )
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await wait(w, "!document.querySelector('[role=dialog]')")
    await wait(w, 'Boolean(document.querySelector(\'[aria-label="关闭连接 Navigation Redis"]\'))')
    await w.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="关闭连接 Navigation Redis"]\').click()',
    )
    await wait(w, 'Boolean(document.querySelector(\'[aria-label="重连 Navigation Redis"]\'))')
    assert.ok(
      await w.webContents.executeJavaScript(
        "document.querySelector('[aria-label=\"连接 Navigation Redis\"]').closest('[data-connected]').dataset.connected === 'false'",
      ),
    )
    assert.ok(
      await w.webContents.executeJavaScript(
        "document.body.textContent.includes('未连接') && !document.body.textContent.includes('加载键列表') && !document.querySelector('[aria-label=\"Redis 数据库切换\"]')",
      ),
    )

    await w.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="重连 Navigation Redis"]\').click()',
    )
    await wait(w, 'Boolean(document.querySelector(\'[aria-label="关闭连接 Navigation Redis"]\'))')
    console.log(
      'Redis search, database switch, sanitized details, disconnect with retained tab and reconnect passed',
    )
    clearTimeout(timeout)
    await client.quit()
    redis.kill()
    w.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    redis?.kill()
    clearTimeout(timeout)
    app.exit(1)
  }
})()
