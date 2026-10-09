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
        database: undefined,
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
      .filter((c) => c.port && ['mysql', 'postgresql'].includes(c.type))
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
      if (!['mysql', 'postgresql'].includes(config.type)) continue
      await wait(
        w,
        `Boolean([...document.querySelectorAll('[aria-label="SQL 对象浏览器"] button')].find(b => b.offsetParent!==null && b.title==='vork_test'))`,
      )
      if (config.type === 'mysql') {
        assert.equal(
          await w.webContents.executeJavaScript(
            `Boolean([...document.querySelectorAll('[aria-label="SQL 对象浏览器"] button')].find(b=>b.title==='information_schema' && b.getAttribute('aria-pressed')==='true'))`,
          ),
          false,
          'No default database must not select first listed database',
        )
        await w.webContents.executeJavaScript(
          `[...document.querySelectorAll('[aria-label="SQL 对象浏览器"] button')].find(b=>b.title==='vork_test').click()`,
        )
      }
      await wait(
        w,
        `[...document.querySelectorAll('[aria-label="SQL 对象浏览器"]')].some(el => el.offsetParent!==null && el.textContent.includes('users'))`,
      )
      assert.equal(
        await w.webContents.executeJavaScript(
          `Boolean(document.querySelector('[aria-label="查询数据库"]'))`,
        ),
        false,
      )
      const target = config.type === 'mysql' ? 'information_schema' : 'postgres'
      await w.webContents.executeJavaScript(
        `[...document.querySelectorAll('[aria-label="SQL 对象浏览器"] button')].find(b => b.offsetParent!==null && b.title===${JSON.stringify(target)}).click()`,
      )
      await wait(
        w,
        `[...document.querySelectorAll('[aria-label="SQL 对象浏览器"] button')].some(b => b.offsetParent!==null && b.title===${JSON.stringify(target)} && b.getAttribute('aria-pressed')==='true')`,
      )
      await w.webContents.executeJavaScript(
        `[...document.querySelectorAll('[aria-label="SQL 对象浏览器"] button')].find(b => b.offsetParent!==null && b.title==='vork_test').click()`,
      )
      await wait(
        w,
        `[...document.querySelectorAll('[aria-label="SQL 对象浏览器"]')].some(el => el.offsetParent!==null && el.textContent.includes('users'))`,
      )
      console.log(
        config.type + ': database tree, automatic table load and database switching passed',
      )
    }
    clearTimeout(timer)
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    await pause(200)
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})()
