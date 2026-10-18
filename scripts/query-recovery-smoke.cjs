const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-query-recovery-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
const timeout = setTimeout(() => app.exit(1), 30000)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(w, expression) {
  for (let i = 0; i < 100; i++) {
    if (await w.webContents.executeJavaScript(expression)) return
    await pause(50)
  }
  throw new Error(expression)
}
;(async () => {
  try {
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    const dialect = process.env.VORK_RECOVERY_DB || 'sqlite'
    let profile
    if (dialect !== 'sqlite') {
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
      await w.webContents.executeJavaScript(
        `window.vork.saveProfile(${JSON.stringify({ type: dialect, name: 'Recovery', host: '127.0.0.1', port, username: 'vork', password: 'vork_test_only', database: 'vork_test' })})`,
      )
    }
    if (dialect !== 'sqlite')
      profile = await w.webContents.executeJavaScript(
        '(async()=> (await window.vork.profiles())[0])()',
      )
    const queries = {
      active: 'q2',
      tabs: [
        {
          id: 'q1',
          name: 'Query 1',
          sql: 'SELECT 111 AS first_draft;',
          database: dialect === 'sqlite' ? 'main' : 'vork_test',
        },
        {
          id: 'q2',
          name: 'Query 2',
          sql: 'SELECT 222 AS second_draft;',
          database:
            dialect === 'sqlite' ? 'main' : dialect === 'mysql' ? 'information_schema' : 'postgres',
        },
      ],
    }
    const state = {
      version: 1,
      active: 's',
      tabs: [
        {
          session: {
            id: 's',
            profileId: profile?.id,
            name: 'Recovery',
            type: dialect,
            target: dialect === 'sqlite' ? ':memory:' : '127.0.0.1',
          },
          sql: queries.tabs[1].sql,
          queries,
        },
      ],
    }
    await w.webContents.executeJavaScript(
      `localStorage.setItem('vork.workspace.v1',${JSON.stringify(JSON.stringify(state))});Storage.prototype.setItem=function(){};void 0`,
    )
    w.reload()
    await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    await wait(
      w,
      `document.body.textContent.includes('first_draft') && document.body.textContent.includes('second_draft')`,
    )
    await wait(
      w,
      `Array.from(document.querySelectorAll('[role=tab][data-state=active]')).some(el=>el.textContent==='Query 2')`,
    )
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="重连 Recovery"]').click()`,
    )
    await wait(w, `!document.querySelector('[aria-label="重连 Recovery"]')`)
    await wait(
      w,
      `document.body.textContent.includes('first_draft') && document.body.textContent.includes('second_draft')`,
    )
    if (dialect !== 'sqlite')
      await wait(
        w,
        `[...document.querySelectorAll('[aria-label="SQL 对象浏览器"] button')].some(el=>el.offsetParent!==null && el.title===${JSON.stringify(queries.tabs[1].database)} && el.getAttribute('aria-pressed')==='true')`,
      )
    await pause(500)
    const recovered = await w.webContents.executeJavaScript(
      `JSON.parse(localStorage.getItem('vork.workspace.v1'))`,
    )
    assert.deepEqual(recovered.tabs[0].queries, queries)
    console.log(
      dialect +
        ': Two independent SQL drafts, tab order, active tab and database survive reload and reconnect without execution',
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
        await failed.webContents.executeJavaScript('document.body.innerText.slice(-5000)'),
      )
    clearTimeout(timeout)
    app.exit(1)
  }
})()
