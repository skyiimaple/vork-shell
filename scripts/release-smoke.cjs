const { app, BrowserWindow } = require('electron')
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { createServer } = require('node:net')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-release-smoke-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
require('../out/main/index.js')
let redis, ssh
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function wait(window, expression) {
  for (let i = 0; i < 100; i++) {
    if (await window.webContents.executeJavaScript(expression)) return
    await pause(50)
  }
  throw new Error('UI condition failed: ' + expression)
}
async function select(window, label, text) {
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label=${JSON.stringify(label)}]').focus()`,
  )
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
  await wait(
    window,
    `Array.from(document.querySelectorAll('[role=option]')).some(el=>el.textContent.trim()===${JSON.stringify(text)})`,
  )
  const point = await window.webContents.executeJavaScript(
    `(()=>{const r=Array.from(document.querySelectorAll('[role=option]')).find(el=>el.textContent.trim()===${JSON.stringify(text)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
  )
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await wait(window, `document.querySelector('[role=listbox]')===null`)
}
const timeout = setTimeout(() => {
  console.error('release smoke timeout')
  redis?.kill()
  app.exit(1)
}, 45000)
app.whenReady().then(async () => {
  const window = BrowserWindow.getAllWindows()[0],
    errors = []
  window.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(e.message)
  })
  try {
    if (window.webContents.isLoading())
      await new Promise((r) => window.webContents.once('did-finish-load', r))
    await wait(window, 'document.querySelector(\'[aria-label="查看版本日志"]\')!==null')
    await window.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="查看版本日志"]\').click()',
    )
    await wait(
      window,
      "document.querySelector('[aria-label=\"版本迭代时间线\"]')?.textContent.includes('2026-10-05')",
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        "document.querySelector('[role=dialog]').textContent.includes('v0.1.0')",
      ),
      true,
    )
    const update = await window.webContents.executeJavaScript('window.vork.updateState()')
    assert.equal(update.status, 'disabled')
    await window.webContents.executeJavaScript(
      "(()=>{const el=document.querySelector('[aria-label=\"搜索版本日志\"]');el.value='2026-10-06';el.dispatchEvent(new Event('input',{bubbles:true}))})()",
    )
    await wait(
      window,
      'document.querySelectorAll(\'[aria-label="版本迭代时间线"] article\').length===1',
    )
    await window.webContents.executeJavaScript(
      "(()=>{const el=document.querySelector('[aria-label=\"搜索版本日志\"]');el.value='';el.dispatchEvent(new Event('input',{bubbles:true}))})()",
    )
    await pause(300)
    mkdirSync(resolve('.artifacts'), { recursive: true })
    writeFileSync(
      resolve('.artifacts/release-timeline.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await wait(window, "document.querySelector('[role=dialog]')===null")
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
      let log = ''
      redis.on('error', reject)
      redis.stdout.on('data', (data) => {
        log += data
        if (log.includes('Ready to accept connections')) resolve()
      })
      redis.once('exit', () => reject(new Error('Redis exited')))
    })
    ssh = await require('./ssh-fixture.cjs').createSshFixture()
    ssh.hooks.allowForward = (p) => p === port
    const raw = require('ssh2').utils.parseKey(ssh.key).getPublicSSH()
    const fingerprint =
      'SHA256:' +
      require('node:crypto').createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')
    writeFileSync(
      join(directory, 'known-hosts.json'),
      JSON.stringify({ ['127.0.0.1:' + ssh.port]: fingerprint }),
    )
    await window.webContents.executeJavaScript(
      `window.vork.saveProfile({id:'bastion',name:'测试跳板机',type:'ssh',host:'127.0.0.1',port:${ssh.port},username:'fixture',password:'fixture'})`,
    )
    await window.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="新建连接"]\').click()',
    )
    await wait(window, "document.querySelector('[role=dialog]')!==null")
    await window.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.trim()==='Redis').click()",
    )
    await wait(window, 'document.querySelector(\'[aria-label="数据库 SSH 隧道"]\')!==null')
    await select(window, '数据库 SSH 隧道', '测试跳板机')
    await window.webContents.executeJavaScript(
      `(()=>{for(const [label,value] of [['连接名称','隧道 Redis'],['主机','127.0.0.1'],['端口','${port}']]){const input=Array.from(document.querySelectorAll('[role=dialog] label')).find(el=>el.querySelector('span')?.textContent===label).querySelector('input');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}))}})()`,
    )
    await pause(100)
    await window.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.trim()==='测试连接').click()",
    )
    await wait(
      window,
      "document.querySelector('[role=dialog]').textContent.includes('连接测试成功')",
    )
    await window.webContents.executeJavaScript(
      "document.querySelector('[role=dialog] form').requestSubmit()",
    )
    await wait(window, 'document.querySelector(\'[aria-label="Redis 数据库编号"]\')!==null')
    assert.equal(
      await window.webContents.executeJavaScript(
        "document.body.textContent.includes('经 SSH 测试跳板机')",
      ),
      true,
    )
    const bridge = await window.webContents.executeJavaScript(
      `(async()=>{const config={type:'redis',name:'bridge',host:'127.0.0.1',port:${port},sshProfileId:'bastion'};await window.vork.saveProfile({...config,id:'linked'});const saved=(await window.vork.profiles()).find(p=>p.id==='linked');const session=await window.vork.connect(saved);const pong=await window.vork.execute(session.id,'PING');await window.vork.disconnect(session.id);return {saved:saved.sshProfileId,pong:pong.rows[0][0]}})()`,
    )
    assert.deepEqual(bridge, { saved: 'bastion', pong: 'PONG' })
    writeFileSync(
      resolve('.artifacts/database-tunnel.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    assert.deepEqual(errors, [])
    console.log(
      'Release timeline, disabled dev updates, SSH selection, tunnel test/connect, saved association and real Redis PING passed',
    )
    clearTimeout(timeout)
    window.destroy()
    await pause(100)
    await ssh.close()
    redis.kill()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timeout)
    window.destroy()
    await ssh?.close()
    redis?.kill()
    rmSync(directory, { recursive: true, force: true })
    app.exit(1)
  }
})
