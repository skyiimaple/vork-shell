const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os'),
  { join } = require('node:path')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-projects-smoke-'))
app.setPath('userData', directory)
writeFileSync(
  join(directory, 'connections.json'),
  JSON.stringify([
    {
      id: 'a',
      type: 'ssh',
      name: 'Project SSH',
      host: 'localhost',
      port: 22,
      username: 'fixture',
      group: 'Legacy Project',
    },
    {
      id: 'b',
      type: 'redis',
      name: 'Project Redis',
      host: 'localhost',
      port: 6379,
      group: 'Legacy Project',
    },
    {
      id: 'c',
      type: 'mysql',
      name: 'Other MySQL',
      host: 'localhost',
      port: 3306,
      username: 'fixture',
    },
  ]),
)
let releaseProjects
const projectsReady = new Promise((resolve) => {
  releaseProjects = resolve
})
const register = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  register(
    channel,
    channel === 'vork:projects'
      ? async (event, ...args) => {
          await projectsReady
          return listener(event, ...args)
        }
      : listener,
  )
require('./smoke-window.cjs')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(w, e) {
  for (let i = 0; i < 100; i++) {
    if (await w.webContents.executeJavaScript(e)) return
    await pause(40)
  }
  throw new Error('Project UI condition failed: ' + e)
}
async function clickText(w, text) {
  await w.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('[role=dialog] button')).find(el=>el.textContent.includes(${JSON.stringify(text)})).click()`,
  )
}
async function input(w, label, value) {
  await w.webContents.executeJavaScript(
    `(()=>{const el=document.querySelector('[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await pause(80)
}
const timeout = setTimeout(() => {
  console.error('Projects smoke timeout')
  app.exit(1)
}, 30000)
;(async () => {
  try {
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((r) => w.webContents.once('did-finish-load', r))
    await wait(w, 'Boolean(document.querySelector(\'[aria-label="连接 Project Redis"]\'))')
    await w.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="管理项目"]\').click()',
    )
    assert.equal(
      await w.webContents.executeJavaScript("document.querySelector('[role=dialog]')===null"),
      true,
    )
    releaseProjects()
    await pause(100)
    const migrated = await w.webContents.executeJavaScript('window.vork.projects()')
    assert.equal(migrated[0].name, 'Legacy Project')
    assert.deepEqual(migrated[0].connectionIds, ['a', 'b'])
    for (const name of ['SSH', 'MySQL', 'Redis'])
      assert.ok(
        await w.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('aside button[aria-expanded]')).some(el=>el.textContent.includes(${JSON.stringify(name)}))`,
        ),
      )
    await w.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="管理项目"]\').click()',
    )
    await input(w, '项目名称', 'Mixed Project')
    for (const name of ['Project SSH', 'Project Redis'])
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="项目成员 ${name}"]').click()`,
      )
    await pause(100)
    await clickText(w, '创建项目')
    await wait(
      w,
      "Array.from(document.querySelectorAll('[role=dialog] button')).some(el=>el.textContent.includes('Mixed Project'))",
    )
    const projects = await w.webContents.executeJavaScript('window.vork.projects()')
    const mixed = projects.find((p) => p.name === 'Mixed Project')
    assert.deepEqual(mixed.connectionIds, ['a', 'b'])
    await input(w, '项目名称', 'Renamed Project')
    await clickText(w, '保存项目')
    await wait(
      w,
      "Array.from(document.querySelectorAll('[role=dialog] button')).some(el=>el.textContent.includes('Renamed Project'))",
    )
    await wait(w, `Boolean(document.querySelector('[aria-label="选择保存方式"]'))`)
    async function saveMode(label) {
      await w.webContents.executeJavaScript(
        `document.querySelector('[aria-label="选择保存方式"]').click()`,
      )
      await wait(
        w,
        `Array.from(document.querySelectorAll('[role=menuitem]')).some(el=>el.textContent.trim()===${JSON.stringify(label)})`,
      )
      await w.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[role=menuitem]')).find(el=>el.textContent.trim()===${JSON.stringify(label)}).click()`,
      )
    }
    await saveMode('保存并关闭')
    await wait(w, "!document.querySelector('[role=dialog]')")
    assert.ok(
      await w.webContents.executeJavaScript(
        `Boolean(document.querySelector('[aria-label="连接 Other MySQL"]'))`,
      ),
    )
    await w.webContents.executeJavaScript(
      `document.querySelector('[aria-label="管理项目"]').click()`,
    )
    await clickText(w, 'Renamed Project')
    await pause(80)
    await saveMode('保存并关闭后切换到当前项目')
    await wait(w, "!document.querySelector('[role=dialog]')")
    await wait(
      w,
      `document.querySelector('[aria-label="筛选连接项目"]').textContent.includes('Renamed Project')`,
    )
    assert.equal(
      await w.webContents.executeJavaScript(
        'Boolean(document.querySelector(\'[aria-label="连接 Other MySQL"]\'))',
      ),
      false,
    )
    await w.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="管理项目"]\').click()',
    )
    await w.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="删除项目 Renamed Project"]\').click()',
    )
    await wait(w, "Boolean(document.querySelector('[role=alertdialog]'))")
    await w.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('[role=alertdialog] button')).find(el=>el.textContent.includes('确认删除项目')).click()",
    )
    await wait(w, "!document.querySelector('[role=alertdialog]')")
    assert.equal((await w.webContents.executeJavaScript('window.vork.profiles()')).length, 3)
    assert.equal((await w.webContents.executeJavaScript('window.vork.projects()')).length, 1)
    console.log(
      'Fixed five type groups, legacy migration, cross-type creation, rename, project filtering and deletion preserving connections passed',
    )
    clearTimeout(timeout)
    w.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    clearTimeout(timeout)
    app.exit(1)
  }
})()
