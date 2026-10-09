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
      {
        name: 'Docker MySQL',
        type: 'mysql',
        port: process.env.VORK_DOCKER_SKIP_MYSQL ? 0 : port('mysql', 3306),
        database: 'vork_test',
        username: 'vork',
        password: 'vork_test_only',
      },
      {
        name: 'Docker PostgreSQL',
        type: 'postgresql',
        port: port('postgres', 5432),
        database: 'vork_test',
        username: 'vork',
        password: 'vork_test_only',
      },
      { name: 'Docker Redis', type: 'redis', port: port('redis', 6379) },
      {
        name: 'Docker SSH',
        type: 'ssh',
        port: port('ssh', 2222),
        username: 'vork',
        password: 'vork_test_only',
      },
    ]
      .filter((c) => c.port)
      .map((c) => ({ ...c, host: '127.0.0.1' }))
    for (const config of configs)
      await w.webContents.executeJavaScript(`window.vork.saveProfile(${JSON.stringify(config)})`)
    w.webContents.reload()
    await new Promise((r) => w.webContents.once('did-finish-load', r))
    for (const config of configs) {
      const selector = JSON.stringify(`[aria-label="连接 ${config.name}"]`)
      await wait(w, `Boolean(document.querySelector(${selector}))`)
      await w.webContents.executeJavaScript(`document.querySelector(${selector}).click()`)
      await wait(w, `Boolean(document.querySelector('[aria-label="关闭连接 ${config.name}"]'))`)
      await w.webContents.executeJavaScript(
        `[...document.querySelectorAll('[aria-label="查看当前连接详情"]')].find(button=>button.offsetParent!==null).click()`,
      )
      const marker = {
        mysql: 'character_set',
        postgresql: 'server_address',
        redis: 'redis_version',
        ssh: 'SSH 会话',
      }[config.type]
      await wait(
        w,
        `document.querySelector('[role=dialog]')?.textContent.includes(${JSON.stringify(marker)})`,
      )
      assert.ok(
        await w.webContents.executeJavaScript(
          `!document.querySelector('[role=dialog]').textContent.includes('运行信息读取失败')`,
        ),
      )
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await pause(100)
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="关闭连接 ${config.name}"]').click()`,
      )
      await wait(w, `Boolean(document.querySelector('[aria-label="重连 ${config.name}"]'))`)
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="重连 ${config.name}"]').click()`,
      )
      await wait(w, `Boolean(document.querySelector('[aria-label="关闭连接 ${config.name}"]'))`)
      console.log(
        config.type + ': desktop connect, type-specific details, disconnect and reconnect passed',
      )
    }
    await w.webContents.executeJavaScript(
      `window.dockerEvents=[];window.vork.onEvent(e=>window.dockerEvents.push(e));true`,
    )
    const ssh = await w.webContents.executeJavaScript(
      `window.vork.connect(${JSON.stringify(configs.find((c) => c.type === 'ssh'))})`,
    )
    await w.webContents.executeJavaScript(`window.vork.ack('${ssh.id}',0);true`)
    await w.webContents.executeJavaScript(
      `window.vork.write('${ssh.id}', "printf 'VORK_%s\\n' 'SSH_REAL_OK'\\r")`,
    )
    await wait(
      w,
      `window.dockerEvents.filter(e=>e.sessionId==='${ssh.id}'&&e.type==='data').map(e=>e.data).join('').includes('VORK_SSH_REAL_OK')`,
    )
    const sshApi = async (request) =>
      w.webContents.executeJavaScript(
        `window.vork.sshRequest('${ssh.id}',${JSON.stringify(request)})`,
      )
    const initial = await sshApi({ kind: 'list', path: '.' })
    assert.equal(initial.kind, 'listing')
    const path = initial.path + '/vork-smoke-dir'
    await sshApi({ kind: 'mkdir', path })
    await sshApi({ kind: 'rename', path, newName: 'vork-smoke-renamed' })
    await sshApi({ kind: 'delete', path: initial.path + '/vork-smoke-renamed' })
    const profiles = await w.webContents.executeJavaScript('window.vork.profiles()'),
      bastion = profiles.find((c) => c.type === 'ssh')
    for (const type of ['mysql', 'postgresql', 'redis']) {
      const original = configs.find((c) => c.type === type)
      if (!original) continue
      const internal = { mysql: 3306, postgresql: 5432, redis: 6379 }[type]
      const session = await w.webContents.executeJavaScript(
        `window.vork.connect(${JSON.stringify({ ...original, name: 'Tunnel ' + type, host: `vork-test-${type === 'postgresql' ? 'postgres' : type}-1009`, port: internal, sshProfileId: bastion.id })})`,
      )
      const result = await w.webContents.executeJavaScript(
        `window.vork.execute('${session.id}',${JSON.stringify(type === 'redis' ? 'PING' : 'SELECT 42 AS value')})`,
      )
      assert.ok(JSON.stringify(result.rows).includes(type === 'redis' ? 'PONG' : '42'))
      await w.webContents.executeJavaScript(`window.vork.disconnect('${session.id}')`)
      console.log(type + ': real SSH database tunnel query and cleanup passed')
    }
    await w.webContents.executeJavaScript(`window.vork.disconnect('${ssh.id}')`)
    const rejected = await w.webContents.executeJavaScript(
      `window.vork.connect(${JSON.stringify({ ...configs.find((c) => c.type === 'ssh'), password: 'invalid_test_password' })}).then(()=>false,()=>true)`,
    )
    assert.equal(rejected, true)
    const logs = await w.webContents.executeJavaScript('window.vork.activityLogs()')
    assert.ok(logs.entries.some((row) => row.level === 'error' && row.action === 'connect'))
    assert.ok(!JSON.stringify(logs).includes('invalid_test_password'))
    console.log('Real Docker SSH PTY and SFTP mkdir/rename/delete passed')
    clearTimeout(timer)
    w.destroy()
    await pause(200)
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (e) {
    console.error(e)
    clearTimeout(timer)
    app.exit(1)
  }
})()
