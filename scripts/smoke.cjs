const { app, BrowserWindow, nativeTheme, dialog } = require('electron')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const assert = require('node:assert/strict')
let redisProcess, redisSetup, sshFixture
async function redisFixture() {
  const server = require('node:net').createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  redisProcess = require('node:child_process').spawn(process.env.VORK_REDIS_SERVER, [
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
    let output = ''
    redisProcess.on('error', reject)
    redisProcess.stdout.on('data', (data) => {
      output += data
      if (output.includes('Ready to accept connections')) resolve()
    })
    redisProcess.once('exit', (code) => reject(new Error('Redis fixture exited ' + code)))
  })
  redisSetup = require('redis').createClient({
    socket: { host: '127.0.0.1', port, reconnectStrategy: false },
  })
  redisSetup.on('error', () => {})
  await redisSetup.connect()
  await redisSetup.set('demo:welcome', 'Hello, Redis', { EX: 300 })
  await redisSetup.hSet('demo:profile', { name: 'Vork', mode: 'desktop' })
  await redisSetup.set('demo:jobs:id', 'nested')
  await redisSetup.set('demo:jobs:very-long-task-name-that-must-be-truncated-in-the-tree', 'long')
  return port
}
function stopSsh() {
  if (sshFixture) return sshFixture.close()
}
function stopRedis() {
  if (redisSetup?.isOpen) redisSetup.destroy()
  redisProcess?.kill('SIGTERM')
}
const directory = mkdtempSync(join(tmpdir(), 'vork-smoke-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
require('../out/main/index.js')
const timeout = setTimeout(() => {
  console.error('Desktop smoke test timed out')
  stopRedis()
  void stopSsh()
  rmSync(directory, { recursive: true, force: true })
  app.exit(1)
}, 60000)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(window, condition) {
  for (let i = 0; i < 80; i++) {
    if (await window.webContents.executeJavaScript(condition)) return
    await pause(50)
  }
  throw new Error(`UI condition failed: ${condition}`)
}
async function editCode(window, label, text) {
  await pause(150)
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label=${JSON.stringify(label)}]').focus()`,
  )
  await pause(50)
  await window.webContents.executeJavaScript(
    `document.querySelector('[aria-label=${JSON.stringify(label)}]').dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',metaKey:${process.platform === 'darwin'},ctrlKey:${process.platform !== 'darwin'},bubbles:true,cancelable:true}))`,
  )
  await window.webContents.insertText(text)
  await waitFor(
    window,
    `document.querySelector('[aria-label=${JSON.stringify(label)}]').textContent === ${JSON.stringify(text.replace(/\n/g, ''))}`,
  )
}
async function chooseSelect(window, label, option) {
  await window.webContents.executeJavaScript(
    `document.querySelector('[role="combobox"][aria-label=${JSON.stringify(label)}]').focus()`,
  )
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
  await waitFor(
    window,
    `Array.from(document.querySelectorAll('[role="option"]')).some(el => el.textContent.trim() === ${JSON.stringify(option)})`,
  )
  const point = await window.webContents.executeJavaScript(
    `(() => { const el = Array.from(document.querySelectorAll('[role="option"]')).find(el => el.textContent.trim() === ${JSON.stringify(option)}); const rect = el.getBoundingClientRect(); return {x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2)} })()`,
  )
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await waitFor(
    window,
    `document.querySelector('[role="combobox"][aria-label=${JSON.stringify(label)}]')?.textContent.trim() === ${JSON.stringify(option)}`,
  )
  await waitFor(window, `document.querySelector('[role="listbox"]') === null`)
}
app.whenReady().then(async () => {
  console.log('smoke: electron ready')
  const window = BrowserWindow.getAllWindows()[0]

  const execute = window.webContents.executeJavaScript.bind(window.webContents)
  window.webContents.executeJavaScript = async (...args) => {
    try {
      return await execute(...args)
    } catch (error) {
      console.error('Failed UI expression:', args[0])
      throw error
    }
  }
  const rendererErrors = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      rendererErrors.push(event.message)
      console.error('renderer:', event.message)
    }
  })
  try {
    if (window.webContents.isLoading())
      await new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
    console.log('smoke: page loaded')
    await waitFor(window, 'document.querySelector("h1") !== null')
    console.log('smoke: renderer ready')
    const prefs = window.webContents.getLastWebPreferences()
    assert.equal(prefs.sandbox, true)
    assert.equal(prefs.contextIsolation, true)
    assert.equal(prefs.nodeIntegration, false)
    const saveDialog = dialog.showSaveDialog
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: join(directory, 'export.csv'),
    })
    const bridge = await window.webContents.executeJavaScript(
      '(async () => { const session = await window.vork.connect({type:"sqlite",name:"Smoke",path:":memory:"}); const result = await window.vork.execute(session.id, "SELECT sqlite_version() AS version, 9007199254740993 AS big, NULL AS nil"); await window.vork.exportResult(session.id, result); await window.vork.disconnect(session.id); return result })()',
    )
    dialog.showSaveDialog = saveDialog
    assert.ok(readFileSync(join(directory, 'export.csv'), 'utf8').includes('9007199254740993'))
    console.log('smoke: sqlite bridge and CSV export returned')
    assert.equal(bridge.rows[0][1], '9007199254740993')
    assert.equal(bridge.rows[0][2], null)
    assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined')
    mkdirSync(resolve('.artifacts'), { recursive: true })
    for (const mode of ['light', 'dark']) {
      await chooseSelect(window, '主题', mode === 'dark' ? '深色主题' : '亮色主题')
      await pause(150)
      assert.equal(
        await window.webContents.executeJavaScript(
          'document.documentElement.classList.contains("dark")',
        ),
        mode === 'dark',
      )
      writeFileSync(
        resolve(`.artifacts/home-${mode}.png`),
        (await window.webContents.capturePage()).toPNG(),
      )
    }
    await chooseSelect(window, '主题', '跟随系统')
    await waitFor(window, `localStorage.getItem('vork.theme') === 'system'`)
    await pause(150)
    for (const mode of ['light', 'dark']) {
      nativeTheme.themeSource = mode
      await waitFor(
        window,
        `document.documentElement.classList.contains('dark') === ${mode === 'dark'}`,
      )
    }
    assert.equal(
      await window.webContents.executeJavaScript('localStorage.getItem("vork.theme")'),
      'system',
    )
    const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
    window.webContents.reload()
    await reloaded
    await waitFor(
      window,
      `document.querySelector('[role=combobox][aria-label="主题"]')?.textContent.trim() === '跟随系统'`,
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        'document.documentElement.classList.contains("dark")',
      ),
      true,
    )
    await window.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("体验 SQLite")).click()',
    )
    await waitFor(window, 'document.querySelector(".cm-editor") !== null')
    await window.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("执行") && b.textContent.includes("⌘")).click()',
    )
    await waitFor(
      window,
      'document.body.textContent.includes("Hello, Vork") && document.body.textContent.includes("1 行")',
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        `document.querySelectorAll('[data-slot=table] tbody tr').length > 0`,
      ),
      true,
    )
    await waitFor(
      window,
      `document.querySelector('[aria-label="SQL 查询"] .tok-keyword') !== null && document.querySelector('[aria-label="SQL 查询"] .tok-string') !== null`,
    )
    writeFileSync(
      resolve('.artifacts/query-dark.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    await editCode(
      window,
      'SQL 查询',
      'WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<1000) SELECT n AS value, n AS value FROM seq',
    )
    await pause(100)
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="SQL 查询"]').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',metaKey:true,bubbles:true}))`,
    )
    await waitFor(
      window,
      `document.querySelector('[data-slot=table]')?.getAttribute('aria-rowcount') === '1001'`,
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        `document.querySelectorAll('[data-slot=table] tbody tr').length < 100`,
      ),
      true,
    )
    await window.webContents.executeJavaScript(
      `(() => { const scroll = document.querySelector('[data-slot=table-container]').parentElement; scroll.scrollTop = scroll.scrollHeight; scroll.dispatchEvent(new Event('scroll')); })()`,
    )
    await waitFor(
      window,
      `document.querySelector('[data-slot=table] tr[aria-rowindex="1001"]') !== null`,
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        `(() => { const table = document.querySelector('[data-slot=table]'); return Math.abs(table.querySelector('thead').getBoundingClientRect().top - table.parentElement.parentElement.getBoundingClientRect().top) < 2 })()`,
      ),
      true,
    )
    await editCode(
      window,
      'SQL 查询',
      'CREATE TABLE "ui table" (id INTEGER PRIMARY KEY, title TEXT)',
    )
    await pause(100)
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="SQL 查询"]').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',metaKey:true,bubbles:true}))`,
    )
    await waitFor(window, `document.body.textContent.includes('执行成功')`)
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="刷新 SQL 对象"]').click()`,
    )
    await waitFor(window, `document.querySelector('button[title="main.ui table"]') !== null`)
    await chooseSelect(window, 'SQL 数据库或 schema', 'main')
    await waitFor(window, `document.querySelector('button[title="main.ui table"]') !== null`)
    await window.webContents.executeJavaScript(
      `document.querySelector('button[title="main.ui table"]').click()`,
    )
    await waitFor(
      window,
      `document.querySelector('[aria-label="SQL 对象浏览器"]').textContent.includes('title') && document.querySelector('[aria-label="SQL 对象浏览器"]').textContent.includes('INTEGER')`,
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="预览 main.ui table"]').click()`,
    )
    await waitFor(
      window,
      `document.querySelector('[aria-label="SQL 查询"]').textContent === 'SELECT * FROM "main"."ui table" LIMIT 1000;'`,
    )
    await chooseSelect(
      window,
      'SQL 查询历史',
      'CREATE TABLE "ui table" (id INTEGER PRIMARY KEY, title TEXT)',
    )
    await waitFor(
      window,
      `document.querySelector('[aria-label="SQL 查询"]').textContent.startsWith('CREATE TABLE')`,
    )
    await window.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('button[title="main.ui table"]'); b.dispatchEvent(new MouseEvent('click', {bubbles:true,detail:1})); b.dispatchEvent(new MouseEvent('click', {bubbles:true,detail:2})); b.dispatchEvent(new MouseEvent('dblclick', {bubbles:true,detail:2})); })()`,
    )
    await waitFor(
      window,
      `document.querySelector('[aria-label="SQL 查询"]').textContent === 'SELECT * FROM "main"."ui table" LIMIT 1000;' && document.querySelector('button[aria-label="导出 CSV"]') !== null && !document.body.textContent.includes('此会话已有命令正在执行')`,
    )
    await pause(200)
    await window.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('button[title="main.ui table"]'); const r = b.getBoundingClientRect(); b.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,button:2,clientX:r.x+20,clientY:r.y+10})); })()`,
    )
    await waitFor(window, `document.querySelector('[role=menu]') !== null`)
    assert.equal(
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[role=menuitem]')).some(item => item.textContent.includes('管理数据（分页与编辑）'))`,
      ),
      true,
    )
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=menuitem]')).find(b => b.textContent.includes('查询总行数')).click()`,
    )
    await waitFor(
      window,
      `document.querySelector('[role=menu]') === null && document.querySelector('[aria-label="SQL 查询"]').textContent === 'SELECT COUNT(*) AS count FROM "main"."ui table";' && document.body.textContent.includes('count')`,
    )
    console.log('smoke: double-click preview and context menu count query passed')
    writeFileSync(
      resolve('.artifacts/sql-browser-dark.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    const unchangedResult = await window.webContents.executeJavaScript(
      `document.querySelector('[data-slot=table]')?.textContent`,
    )
    await editCode(window, 'SQL 查询', 'SEL')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space', modifiers: ['control'] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await waitFor(
      window,
      `Array.from(document.querySelectorAll('.cm-tooltip-autocomplete li')).some(el => el.textContent.includes('SELECT'))`,
    )
    await pause(150)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await waitFor(
      window,
      `document.querySelector('[aria-label="SQL 查询"]').textContent === 'SELECT'`,
    )
    await editCode(window, 'SQL 查询', 'SELECT * FROM main.')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space', modifiers: ['control'] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await waitFor(
      window,
      `Array.from(document.querySelectorAll('.cm-tooltip-autocomplete li')).some(el => el.textContent.includes('ui table'))`,
    )
    await pause(150)
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await waitFor(
      window,
      `document.querySelector('[aria-label="SQL 查询"]').textContent === 'SELECT * FROM main."ui table"'`,
    )
    await editCode(window, 'SQL 查询', 'SELECT main."ui table".ti')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space', modifiers: ['control'] })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await waitFor(
      window,
      `Array.from(document.querySelectorAll('.cm-tooltip-autocomplete li')).some(el => el.textContent.includes('title'))`,
    )
    await pause(150)
    writeFileSync(
      resolve('.artifacts/sql-completion-dark.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await waitFor(
      window,
      `document.querySelector('[aria-label="SQL 查询"]').textContent === 'SELECT main."ui table"."title"'`,
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        `document.querySelector('[data-slot=table]')?.textContent`,
      ),
      unchangedResult,
    )

    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === '关闭 SQLite 试验台').click()`,
    )
    await waitFor(window, 'document.querySelector(".cm-editor") === null')
    console.log('smoke: query completed and closed')
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="帮助"]').click()`,
    )
    await waitFor(window, `document.querySelector('[data-slot="popover-content"]') !== null`)
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="关闭帮助"]').click()`,
    )
    await waitFor(window, `document.querySelector('[data-slot="popover-content"]') === null`)
    // Test actual dialog rendering, including generated shadcn-vue components.
    await window.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("新建连接") && b.textContent.includes("⌘")).click()',
    )
    await waitFor(window, 'document.querySelector("[role=dialog]") !== null')
    await pause(200)
    writeFileSync(
      resolve('.artifacts/connection-dark.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    if (process.env.VORK_REDIS_SERVER) {
      const port = await redisFixture()
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[role=dialog] button')).find(b => b.textContent.trim() === 'Redis').click()`,
      )
      await waitFor(window, `document.querySelector('[role=checkbox]') !== null`)
      for (const checked of ['true', 'false']) {
        await window.webContents.executeJavaScript(
          `document.querySelector('[role=checkbox]').click()`,
        )
        await waitFor(
          window,
          `document.querySelector('[role=checkbox]').getAttribute('aria-checked') === '${checked}'`,
        )
      }
      await window.webContents.executeJavaScript(
        `(() => { const input = Array.from(document.querySelectorAll('[role=dialog] label')).find(l => l.textContent.trim() === '端口').querySelector('input'); input.value = '${port}'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`,
      )
      await pause(100)
      assert.equal(
        await window.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll('[role=dialog] label')).find(l => l.textContent.trim() === '端口').querySelector('input').value`,
        ),
        String(port),
      )
      await window.webContents.executeJavaScript(
        `document.querySelector('[role=dialog] form').requestSubmit()`,
      )
      await waitFor(window, `document.querySelector('[aria-label="Redis 数据库编号"]') !== null`)
      await waitFor(window, `document.querySelector('[aria-label="展开 demo"]') !== null`)
      assert.equal(
        await window.webContents.executeJavaScript(
          `(() => { const button = document.querySelector('button[title="demo"]'); return button.querySelector('svg').getBoundingClientRect().left - button.getBoundingClientRect().left < 14 })()`,
        ),
        true,
        'folder content must align left beside the disclosure button',
      )
      await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="展开 demo"]').click()`,
      )
      await waitFor(window, `document.querySelector('[aria-label="展开 jobs"]') !== null`)
      await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="展开 jobs"]').click()`,
      )
      await waitFor(window, `document.querySelector('button[title="demo:jobs:id"]') !== null`)
      await window.webContents.executeJavaScript(
        `document.querySelector('button[title="demo:jobs:id"]').click()`,
      )
      await waitFor(window, `document.body.textContent.includes('nested')`)
      assert.equal(
        await window.webContents.executeJavaScript(
          `(() => { const folder = document.querySelector('button[title="jobs"]'); const leaf = document.querySelector('button[title="demo:jobs:id"]'); const long = document.querySelector('button[title="demo:jobs:very-long-task-name-that-must-be-truncated-in-the-tree"] span'); return Math.abs(leaf.querySelector('svg').getBoundingClientRect().left - folder.querySelector('svg').getBoundingClientRect().left - 14) < 2 && long.scrollWidth > long.clientWidth })()`,
        ),
        true,
        'tree depth and long-label truncation',
      )
      writeFileSync(
        resolve('.artifacts/redis-tree-dark.png'),
        (await window.webContents.capturePage()).toPNG(),
      )
      await waitFor(window, `document.querySelector('button[title="demo:welcome"]') !== null`)
      await chooseSelect(window, 'Redis 键类型筛选', 'string')
      await waitFor(
        window,
        `!document.querySelector('button[title="demo:profile"]') && document.querySelector('button[title="demo:welcome"]') !== null`,
      )
      await chooseSelect(window, 'Redis 键类型筛选', '全部类型')
      await waitFor(window, `document.querySelector('button[title="demo:welcome"]') !== null`)
      await window.webContents.executeJavaScript(
        `document.querySelector('button[title="demo:profile"]').click()`,
      )
      await waitFor(
        window,
        `Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === '编辑集合')`,
      )
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '编辑集合').click()`,
      )
      await waitFor(window, `document.querySelector('[aria-label="Redis 新成员"]') !== null`)
      await chooseSelect(window, 'Redis 成员操作', '删除成员')
      await window.webContents.executeJavaScript(
        `document.querySelector('[role=dialog] form').requestSubmit()`,
      )
      await waitFor(
        window,
        `document.querySelector('[role=dialog]').textContent.includes('请选择当前页的成员')`,
      )
      assert.equal(await redisSetup.hGet('demo:profile', 'name'), 'Vork')
      await chooseSelect(window, 'Redis 成员操作', '新增成员')
      await waitFor(window, `document.querySelector('[aria-label="Redis 新成员"]') !== null`)
      await window.webContents.executeJavaScript(
        `(() => { for (const [label,value] of [['Redis 新成员','ui-added'],['Redis 成员值','real mutation']]) { const input = document.querySelector('[aria-label="' + label + '"]'); input.value = value; input.dispatchEvent(new Event('input', {bubbles:true})); } })()`,
      )
      await pause(100)
      await window.webContents.executeJavaScript(
        `document.querySelector('[role=dialog] form').requestSubmit()`,
      )
      await waitFor(
        window,
        `document.querySelector('[role=dialog]') === null && document.body.textContent.includes('real mutation')`,
      )
      assert.equal(await redisSetup.hGet('demo:profile', 'ui-added'), 'real mutation')
      await window.webContents.executeJavaScript(
        `document.querySelector('button[title="demo:welcome"]').click()`,
      )
      await waitFor(
        window,
        `document.body.textContent.includes('Hello, Redis') && document.body.textContent.includes('TTL')`,
      )
      for (const mode of ['dark', 'light']) {
        await chooseSelect(window, '主题', mode === 'dark' ? '深色主题' : '亮色主题')
        await pause(150)
        writeFileSync(
          resolve(`.artifacts/redis-${mode}.png`),
          (await window.webContents.capturePage()).toPNG(),
        )
      }
      // Stage 6: create without overwriting, actual highlighted JSON and collection paging.
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '新建键').click()`,
      )
      await waitFor(window, `document.querySelector('[aria-label="新 Redis 键名"]') !== null`)
      await window.webContents.executeJavaScript(
        `(() => {for (const [label,value] of [['新 Redis 键名','created-json'],['新 Redis 初始值','{"ready":true,"count":42,"name":"<script>"}']]) {const input=document.querySelector('[aria-label="'+label+'"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}))}})()`,
      )
      await pause(100)
      await window.webContents.executeJavaScript(
        `document.querySelector('[role=dialog] form').requestSubmit()`,
      )
      await waitFor(
        window,
        `document.querySelector('[role=dialog]') === null && document.body.textContent.includes('键已创建')`,
      )
      assert.equal(await redisSetup.type('created-json'), 'string')
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'JSON').click()`,
      )
      await waitFor(
        window,
        `document.querySelector('[aria-label="Redis JSON 预览"] .tok-number')?.textContent === '42'`,
      )
      assert.equal(
        await window.webContents.executeJavaScript(
          `document.querySelector('[aria-label="Redis JSON 预览"]').getAttribute('aria-readonly')`,
        ),
        'true',
      )
      await pause(350)
      writeFileSync(
        resolve('.artifacts/redis-json-light.png'),
        (await window.webContents.capturePage()).toPNG(),
      )
      await redisSetup.rPush(
        'paged-list',
        Array.from({ length: 105 }, (_, i) => 'item-' + i),
      )
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '刷新').click()`,
      )
      await waitFor(window, `document.querySelector('button[title="paged-list"]') !== null`)
      await window.webContents.executeJavaScript(
        `document.querySelector('button[title="paged-list"]').click()`,
      )
      await waitFor(window, `document.querySelector('[aria-label="Redis 集合每批数量"]') !== null`)
      await chooseSelect(window, 'Redis 集合每批数量', '50 项 / 批')
      await waitFor(window, `document.body.textContent.includes('第 1 批 · 50 项')`)
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '下一批').click()`,
      )
      await waitFor(
        window,
        `document.body.textContent.includes('第 2 批 · 50 项') && document.body.textContent.includes('item-50')`,
      )
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '下一批').click()`,
      )
      await waitFor(window, `document.body.textContent.includes('第 3 批 · 5 项')`)
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '上一批').click()`,
      )
      await waitFor(window, `document.body.textContent.includes('第 2 批 · 50 项')`)
      console.log('smoke: Redis create, JSON highlighting and collection paging passed')
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '命令控制台').click()`,
      )
      await waitFor(window, `document.querySelector('[aria-label="Redis 命令"]') !== null`)
      await waitFor(
        window,
        `document.querySelector('[aria-label="Redis 命令"] .tok-keyword') !== null`,
      )
      await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="Redis 命令"]').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',metaKey:true,bubbles:true}))`,
      )
      await waitFor(window, `document.body.textContent.includes('PONG')`)
      await window.webContents.executeJavaScript(
        `(() => { const input = document.querySelector('[aria-label="Redis 数据库编号"]'); input.value = '1'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`,
      )
      await pause(100)
      await window.webContents.executeJavaScript(
        `(() => { document.querySelector('[aria-label="Redis 数据库编号"]').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true})); Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '键浏览').click() })()`,
      )
      await waitFor(window, `document.body.textContent.includes('没有匹配的键。')`)
      console.log('smoke: Redis key tree, value, console, DB isolation and themes passed')
      stopRedis()
    }
    // Persist a temporary configuration through the actual form, then exercise AlertDialog cancel/confirm.
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="新建连接"]').click()`,
    )
    await waitFor(window, `document.querySelector('[role=dialog]') !== null`)
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(b => b.textContent.trim() === 'SQLite').click()`,
    )
    await pause(100)
    await window.webContents.executeJavaScript(
      `(() => { for (const [label, value] of [['连接名称', 'UI 审计连接'], ['数据库文件', ':memory:']]) { const input = Array.from(document.querySelectorAll('[role=dialog] label')).find(l => l.textContent.includes(label)).querySelector('input'); input.value = value; input.dispatchEvent(new Event('input', {bubbles:true})); } })()`,
    )
    await pause(100)
    const tabsBeforeTest = await window.webContents.executeJavaScript(
      `document.querySelectorAll('[aria-label^="关闭 "]').length`,
    )
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(b => b.textContent.trim() === '测试连接').click()`,
    )
    await waitFor(
      window,
      `document.querySelector('[role=dialog]').textContent.includes('连接测试成功')`,
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        `document.querySelectorAll('[aria-label^="关闭 "]').length`,
      ),
      tabsBeforeTest,
    )
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(b => b.textContent.trim() === '保存配置').click()`,
    )
    await waitFor(
      window,
      `document.querySelector('[role=dialog]') === null && document.querySelector('[aria-label="删除连接"]') !== null`,
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="搜索连接"]').value = 'UI 审计'; document.querySelector('[aria-label="搜索连接"]').dispatchEvent(new Event('input', {bubbles:true}))`,
    )
    await waitFor(window, `document.body.textContent.includes('UI 审计连接')`)
    const savedBeforeEdit = await window.webContents.executeJavaScript(`window.vork.profiles()`)
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="编辑连接 UI 审计连接"]').click()`,
    )
    await waitFor(window, `document.querySelector('[role=dialog]') !== null`)
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(b => b.textContent.trim() === 'SQLite').click()`,
    )
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(b => b.textContent.trim() === '保存配置').click()`,
    )
    await waitFor(window, `document.querySelector('[role=dialog]') === null`)
    assert.deepEqual(
      await window.webContents.executeJavaScript(`window.vork.profiles()`),
      savedBeforeEdit,
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="复制连接 UI 审计连接"]').click()`,
    )
    await waitFor(window, `document.querySelector('[role=dialog]') !== null`)
    assert.equal(
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[role=dialog] label')).find(l => l.textContent.includes('连接名称')).querySelector('input').value`,
      ),
      'UI 审计连接 副本',
    )
    await pause(200)
    writeFileSync(
      resolve('.artifacts/connection-actions-dark.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(window, `document.querySelector('[role=dialog]') === null`)
    for (const action of ['取消', '确认删除']) {
      await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="删除连接"]').click()`,
      )
      await waitFor(window, `document.querySelector('[role=alertdialog]') !== null`)
      await window.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[role=alertdialog] button')).find(b => b.textContent.trim() === '${action}').click()`,
      )
      await waitFor(window, `document.querySelector('[role=alertdialog]') === null`)
    }
    assert.equal(
      await window.webContents.executeJavaScript(
        `document.querySelector('[aria-label="删除连接"]') === null`,
      ),
      true,
    )
    await chooseSelect(window, '主题', '深色主题')
    sshFixture = await require('./ssh-fixture.cjs').createSshFixture()
    const rawKey = require('ssh2').utils.parseKey(sshFixture.key).getPublicSSH()
    const fingerprint =
      'SHA256:' +
      require('node:crypto').createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')
    writeFileSync(
      join(directory, 'known-hosts.json'),
      JSON.stringify({ ['localhost:' + sshFixture.port]: fingerprint }),
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="新建连接"]').click()`,
    )
    await waitFor(window, `document.querySelector('[role=dialog]') !== null`)
    await window.webContents.executeJavaScript(
      `(() => { for (const [label,value] of [['连接名称','SSH fixture'],['端口','${sshFixture.port}'],['用户名','fixture'],['密码','fixture']]) { const input = Array.from(document.querySelectorAll('[role=dialog] label')).find(l => l.textContent.trim() === label).querySelector('input'); input.value = value; input.dispatchEvent(new Event('input',{bubbles:true})); } })()`,
    )
    await pause(100)
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(b => b.textContent.trim() === '保存配置').click()`,
    )
    await waitFor(window, `document.querySelector('[role=dialog]') === null`)
    await window.webContents.executeJavaScript(
      `(() => { const input = document.querySelector('[aria-label="搜索连接"]'); input.value = ''; input.dispatchEvent(new Event('input', {bubbles:true})); })()`,
    )
    await waitFor(
      window,
      `Array.from(document.querySelectorAll('aside button')).some(b => b.textContent.includes('SSH fixture'))`,
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="编辑连接 SSH fixture"]').click()`,
    )
    await waitFor(
      window,
      `document.querySelector('[role=dialog] input[type=password]')?.value === 'fixture'`,
    )
    // Replace the stored secret to prove connecting updates it, rather than merely retaining the initial save.
    await window.webContents.executeJavaScript(
      `(async () => { const p = (await window.vork.profiles()).find(p => p.name === 'SSH fixture'); await window.vork.saveProfile({...p,password:'old-secret'}); })()`,
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('[role=dialog] form').requestSubmit()`,
    )
    await waitFor(window, `document.querySelector('.xterm') !== null`)
    assert.equal(
      await window.webContents.executeJavaScript(
        `(async () => (await window.vork.profiles()).find(p => p.name === 'SSH fixture').password)()`,
      ),
      'fixture',
    )
    assert.equal(
      readFileSync(join(directory, 'connections.json'), 'utf8').includes('"password"'),
      false,
    )
    await window.webContents.executeJavaScript(
      `(() => { const input = document.querySelector('[aria-label="搜索连接"]'); input.value = ''; input.dispatchEvent(new Event('input', {bubbles:true})); })()`,
    )
    await waitFor(
      window,
      `Array.from(document.querySelectorAll('aside button')).some(b => b.textContent.includes('SSH fixture'))`,
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="编辑连接 SSH fixture"]').click()`,
    )
    await waitFor(
      window,
      `document.querySelector('[role=dialog] input[type=password]')?.value === 'fixture'`,
    )
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(window, `document.querySelector('[role=dialog]') === null`)
    console.log('smoke: encrypted password restored after save and reconnect')
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=tab]')).find(b => b.textContent.trim() === 'SFTP 文件').focus()`,
    )
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await waitFor(
      window,
      `Array.from(document.querySelectorAll('[role=tab]')).find(b => b.textContent.trim() === 'SFTP 文件').getAttribute('aria-selected') === 'true'`,
    )
    await pause(150)
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '读取目录').click()`,
    )
    await waitFor(window, `document.querySelector('[aria-label="下载 hello.txt"]') !== null`)
    const originalSave = dialog.showSaveDialog
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: join(directory, 'sftp-download.txt'),
    })
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="下载 hello.txt"]').click()`,
    )
    await waitFor(window, `document.body.textContent.includes('sftp-download.txt')`)
    assert.equal(readFileSync(join(directory, 'sftp-download.txt'), 'utf8'), 'hello from SFTP\n')
    dialog.showSaveDialog = originalSave
    const originalOpen = dialog.showOpenDialog
    writeFileSync(join(directory, 'ui-upload.txt'), 'desktop SFTP upload')
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [join(directory, 'ui-upload.txt')],
    })
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '多选上传').click()`,
    )
    await waitFor(
      window,
      `document.body.textContent.includes('ui-upload.txt') && document.body.textContent.includes('批量传输完成')`,
    )
    assert.equal(sshFixture.files.get('/ui-upload.txt').toString(), 'desktop SFTP upload')
    dialog.showOpenDialog = originalOpen
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '读取目录').click()`,
    )
    await waitFor(window, `document.querySelector('[aria-label="下载 ui-upload.txt"]') !== null`)
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="重命名 ui-upload.txt"]').click()`,
    )
    await waitFor(window, `document.querySelector('[role=dialog]') !== null`)
    await window.webContents.executeJavaScript(
      `(() => {const input=document.querySelector('[aria-label="SFTP 新目录名"]');input.value='renamed.txt';input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
    )
    await pause(100)
    await window.webContents.executeJavaScript(
      `document.querySelector('[role=dialog] form').requestSubmit()`,
    )
    await waitFor(
      window,
      `document.querySelector('[aria-label="删除 renamed.txt"]') !== null && document.querySelector('[role=dialog]') === null`,
    )
    assert.equal(sshFixture.files.get('/renamed.txt').toString(), 'desktop SFTP upload')
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="删除 renamed.txt"]').click()`,
    )
    await waitFor(
      window,
      `document.querySelector('[role=dialog]').textContent.includes('删除无法恢复')`,
    )
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=dialog] button')).find(b => b.textContent.trim() === '取消').click()`,
    )
    assert.equal(sshFixture.files.has('/renamed.txt'), true)
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="删除 renamed.txt"]').click()`,
    )
    await waitFor(window, `document.querySelector('[role=dialog]') !== null`)
    await window.webContents.executeJavaScript(
      `document.querySelector('[role=dialog] form').requestSubmit()`,
    )
    await waitFor(
      window,
      `document.querySelector('[aria-label="删除 renamed.txt"]') === null && document.querySelector('[role=dialog]') === null`,
    )
    assert.equal(sshFixture.files.has('/renamed.txt'), false)
    sshFixture.files.set('/slow.bin', Buffer.alloc(4 * 1024 * 1024, 65))
    sshFixture.hooks.readDelay = 150
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '读取目录').click()`,
    )
    await waitFor(window, `document.querySelector('[aria-label="下载 slow.bin"]') !== null`)
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: join(directory, 'slow.bin') })
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="下载 slow.bin"]').click()`,
    )
    await waitFor(window, `document.querySelector('[aria-label="文件传输进度"]') !== null`)
    await waitFor(
      window,
      `Number(document.querySelector('[aria-label="文件传输进度"]').getAttribute('aria-valuenow')) > 0`,
    )
    writeFileSync(
      resolve('.artifacts/sftp-progress.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '取消传输').click()`,
    )
    await waitFor(window, `document.body.textContent.includes('传输已取消，SSH 连接仍可使用')`)
    assert.equal(require('node:fs').existsSync(join(directory, 'slow.bin')), false)
    assert.equal(
      require('node:fs')
        .readdirSync(directory)
        .some((name) => name.includes('slow.bin.vork-')),
      false,
    )
    sshFixture.hooks.readDelay = 0
    dialog.showSaveDialog = originalSave
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '读取目录').click()`,
    )
    await waitFor(window, `document.querySelector('[aria-label="下载 hello.txt"]') !== null`)
    console.log(
      'smoke: SFTP rename/delete confirmation, progress and cancel retaining session passed',
    )
    await pause(200)
    writeFileSync(
      resolve('.artifacts/sftp-dark.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('[role=tab]')).find(b => b.textContent.trim() === 'SSH 隧道').focus()`,
    )
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
    await waitFor(
      window,
      `Array.from(document.querySelectorAll('[role=tab]')).find(b => b.textContent.trim() === 'SSH 隧道').getAttribute('aria-selected') === 'true'`,
    )
    await pause(150)
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '新建隧道').click()`,
    )
    await waitFor(window, `document.querySelector('[aria-label="隧道目标端口"]') !== null`)
    await window.webContents.executeJavaScript(
      `(() => { const input = document.querySelector('[aria-label="隧道目标端口"]'); input.value = '${sshFixture.echoPort}'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`,
    )
    await pause(100)
    await window.webContents.executeJavaScript(
      `document.querySelector('[role=dialog] form').requestSubmit()`,
    )
    await waitFor(
      window,
      `Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === '关闭隧道')`,
    )
    await waitFor(window, `document.querySelector('[role=dialog]') === null`)
    await pause(200)
    writeFileSync(
      resolve('.artifacts/ssh-tunnel-dark.png'),
      (await window.webContents.capturePage()).toPNG(),
    )
    await window.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '关闭隧道').click()`,
    )
    await waitFor(
      window,
      `!Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === '关闭隧道')`,
    )
    await window.webContents.executeJavaScript(
      `document.querySelector('[aria-label="关闭 SSH fixture"]').click()`,
    )
    await stopSsh()
    sshFixture = undefined
    assert.deepEqual(rendererErrors, [])
    console.log(
      JSON.stringify(
        {
          desktop: 'passed',
          sqliteVersion: bridge.rows[0][0],
          bridge: 'passed',
          isolation: 'passed',
          themes: ['light', 'dark', 'system'],
          themePersistence: 'passed',
          queryUi: 'passed',
          dialog: 'passed',
          sshTools: 'passed (real SSH, SFTP download/upload, tunnel UI)',
          sqlObjectBrowser: 'passed (objects, fields, quoted preview, manual execution)',
          componentUi:
            'passed (1000-row virtual table, duplicate headers, sticky header, ARIA,  popover, search, profile form, delete confirmation)',
          redisUi: process.env.VORK_REDIS_SERVER ? 'passed' : 'not run',
          screenshots: '.artifacts',
        },
        null,
        2,
      ),
    )
    clearTimeout(timeout)
    window.destroy()
    await pause(100)
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    stopRedis()
    await stopSsh()
    clearTimeout(timeout)
    window.destroy()
    rmSync(directory, { recursive: true, force: true })
    app.exit(1)
  }
})
