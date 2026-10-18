const { app, BrowserWindow } = require('electron')
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-schema-')),
  database = join(directory, 'test.sqlite')
const db = new DatabaseSync(database)
db.exec(
  "CREATE TABLE items(id INTEGER PRIMARY KEY,title TEXT UNIQUE); INSERT INTO items VALUES(1,'original')",
)
app.setPath('userData', directory)
writeFileSync(
  join(directory, 'connections.json'),
  JSON.stringify([{ id: 's', name: 'Schema', type: 'sqlite', path: database }]),
)
require('./smoke-window.cjs')
const timeout = setTimeout(() => app.exit(1), 60000)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(w, code) {
  for (let i = 0; i < 100; i++) {
    if (await w.webContents.executeJavaScript(code)) return
    await pause(50)
  }
  throw new Error(code)
}
async function click(w, code) {
  return w.webContents.executeJavaScript(code)
}
async function button(w, text) {
  await click(
    w,
    `Array.from(document.querySelectorAll('[role=dialog] button')).find(el=>el.textContent.trim()===${JSON.stringify(text)}).click()`,
  )
}
async function input(w, label, value) {
  await click(
    w,
    `(()=>{const el=document.querySelector('[aria-label=${JSON.stringify(label)}]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await pause(60)
}
async function nativeClick(w, expression) {
  const point = await w.webContents.executeJavaScript(
    `(()=>{const el=${expression};const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
  )
  w.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  w.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  w.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
}
async function select(w, label, text) {
  await click(w, `document.querySelector('[aria-label=${JSON.stringify(label)}]').focus()`)
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
  await wait(
    w,
    `Array.from(document.querySelectorAll('[role=option]')).some(el=>el.textContent.trim()===${JSON.stringify(text)})`,
  )
  await nativeClick(
    w,
    `Array.from(document.querySelectorAll('[role=option]')).find(el=>el.textContent.trim()===${JSON.stringify(text)})`,
  )
  await wait(w, `!document.querySelector('[role=listbox]')`)
}
;(async () => {
  try {
    await import('../out/main/index.js')
    await app.whenReady()
    const w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    await wait(w, `Boolean(document.querySelector('[aria-label="连接 Schema"]'))`)
    await click(w, `document.querySelector('[aria-label="连接 Schema"]').click()`)
    await wait(
      w,
      `Boolean(document.querySelector('[aria-label="查看结构 main.items"]')) && !document.querySelector('[aria-label="查看结构 main.items"]').disabled`,
    )
    await click(w, `document.querySelector('[aria-label="查看结构 main.items"]').click()`)
    await wait(w, `document.body.textContent.includes('sqlite_autoindex_items_1')`)
    await button(w, '新建索引')
    await wait(w, `Boolean(document.querySelector('[aria-label="索引字段 title"]'))`)
    await click(w, `document.querySelector('[aria-label="索引字段 title"]').click()`)
    await pause(80)
    await button(w, '预览创建索引')
    await wait(w, `document.body.textContent.includes('待执行结构变更')`)
    assert.equal(
      db.prepare("SELECT name FROM sqlite_schema WHERE name='idx_items'").get(),
      undefined,
    )
    await button(w, '确认执行结构变更')
    await wait(w, `Boolean(document.querySelector('[aria-label="删除索引 idx_items"]'))`)
    assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE name='idx_items'").get())
    await click(w, `document.querySelector('[aria-label="删除索引 idx_items"]').click()`)
    await wait(w, `document.body.textContent.includes('DROP INDEX')`)
    await button(w, '取消变更')
    assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE name='idx_items'").get())
    await click(w, `document.querySelector('[aria-label="删除索引 idx_items"]').click()`)
    await wait(w, `document.body.textContent.includes('DROP INDEX')`)
    await button(w, '确认执行结构变更')
    await wait(w, `!document.querySelector('[aria-label="删除索引 idx_items"]')`)
    assert.equal(
      db.prepare("SELECT name FROM sqlite_schema WHERE name='idx_items'").get(),
      undefined,
    )
    await nativeClick(
      w,
      `Array.from(document.querySelectorAll('[role=tab]')).find(el=>el.textContent.trim()==='字段')`,
    )
    await wait(
      w,
      `Array.from(document.querySelectorAll('button')).some(el=>el.textContent.trim()==='新增字段')`,
    )
    await button(w, '新增字段')
    await input(w, '字段名称', 'extra')
    await input(w, '字段类型', 'VARCHAR(60)')
    await select(w, '字段默认值类型', '文本')
    await input(w, '字段默认值', "desktop ' quote")
    await button(w, '预览字段变更')
    await wait(w, `document.body.textContent.includes('ADD COLUMN')`)
    assert.equal(db.prepare('PRAGMA table_info(items)').all().length, 2)
    await button(w, '确认执行结构变更')
    await wait(w, `Boolean(document.querySelector('[aria-label="重命名字段 extra"]'))`)
    assert.equal(db.prepare('SELECT extra FROM items').get().extra, "desktop ' quote")
    await click(w, `document.querySelector('[aria-label="重命名字段 extra"]').click()`)
    await input(w, '字段名称', 'renamed')
    await button(w, '预览字段变更')
    await wait(w, `document.body.textContent.includes('RENAME COLUMN')`)
    mkdirSync(join(process.cwd(), '.artifacts'), { recursive: true })
    await pause(200)
    writeFileSync(
      join(process.cwd(), '.artifacts/schema-columns.png'),
      (await w.webContents.capturePage()).toPNG(),
    )
    await button(w, '确认执行结构变更')
    await wait(w, `Boolean(document.querySelector('[aria-label="删除字段 renamed"]'))`)
    assert.equal(db.prepare('SELECT renamed FROM items').get().renamed, "desktop ' quote")
    await click(w, `document.querySelector('[aria-label="删除字段 renamed"]').click()`)
    await button(w, '预览字段变更')
    await wait(w, `document.body.textContent.includes('DROP COLUMN')`)
    await button(w, '取消变更')
    assert.equal(db.prepare('PRAGMA table_info(items)').all().length, 3)
    await button(w, '预览字段变更')
    await wait(w, `document.body.textContent.includes('DROP COLUMN')`)
    await button(w, '确认执行结构变更')
    await wait(w, `!document.querySelector('[aria-label="删除字段 renamed"]')`)
    assert.equal(db.prepare('PRAGMA table_info(items)').all().length, 2)
    assert.equal(db.prepare('SELECT title FROM items').get().title, 'original')
    db.exec(
      "ALTER TABLE items ADD COLUMN score TEXT DEFAULT '42';CREATE INDEX score_idx ON items(score);CREATE TABLE child(id INTEGER REFERENCES items(id) ON DELETE CASCADE);INSERT INTO child VALUES(1);CREATE TABLE audit(value TEXT);CREATE TRIGGER original_trigger AFTER INSERT ON items BEGIN INSERT INTO audit VALUES(NEW.title);END;CREATE VIEW original_view AS SELECT id,title,score FROM items",
    )
    await button(w, '刷新结构')
    await wait(
      w,
      `Boolean(document.querySelector('[aria-label="修改字段默认值 score"]')) && !document.querySelector('[aria-label="修改字段默认值 score"]').disabled`,
    )
    async function edit(label) {
      await click(w, `document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`)
    }
    async function previewField() {
      await button(w, '预览字段变更')
      await wait(
        w,
        `document.body.textContent.includes('待执行结构变更') && document.body.textContent.includes('BEGIN IMMEDIATE')`,
      )
    }
    async function commitField() {
      assert.ok(
        await click(
          w,
          `(()=>{const parent=document.querySelector('[aria-label="结构变更预览"]');const button=Array.from(parent.querySelectorAll('button')).find(el=>el.textContent.trim()==='确认执行结构变更');const r=button.getBoundingClientRect(),p=parent.getBoundingClientRect();return r.top>=p.top && r.bottom<=p.bottom && r.bottom<=innerHeight})()`,
        ),
      )
      await nativeClick(
        w,
        `Array.from(document.querySelectorAll('[role=dialog] button')).find(el=>el.textContent.trim()==='确认执行结构变更')`,
      )
      await wait(
        w,
        `!document.body.textContent.includes('待执行结构变更') && !document.body.textContent.includes('正在读取或执行')`,
      )
    }
    await edit('修改字段默认值 score')
    await select(w, '字段默认值类型', '数字')
    await input(w, '字段默认值', '7')
    await previewField()
    assert.equal(
      db
        .prepare('PRAGMA table_info(items)')
        .all()
        .find((row) => row.name === 'score').dflt_value,
      "'42'",
    )
    await commitField()
    assert.equal(db.prepare('SELECT score FROM items').get().score, '42')
    db.exec('UPDATE items SET score=NULL')
    await edit('修改字段可空 score')
    await click(w, `document.querySelector('[aria-label="字段允许 NULL"]').click()`)
    await previewField()
    await commitField()
    await wait(w, `document.body.textContent.includes('NOT NULL constraint failed')`)
    assert.equal(db.prepare('SELECT score FROM items').get().score, null)
    assert.equal(
      db
        .prepare('PRAGMA table_info(items)')
        .all()
        .find((row) => row.name === 'score').notnull,
      0,
    )
    db.exec("UPDATE items SET score='42'")
    await button(w, '刷新结构')
    await wait(w, `!document.body.textContent.includes('正在读取或执行')`)
    await edit('修改字段可空 score')
    await click(w, `document.querySelector('[aria-label="字段允许 NULL"]').click()`)
    await previewField()
    await commitField()
    assert.equal(
      db
        .prepare('PRAGMA table_info(items)')
        .all()
        .find((row) => row.name === 'score').notnull,
      1,
    )
    await edit('修改字段类型 score')
    await input(w, '字段类型', 'INTEGER')
    await previewField()
    await commitField()
    await wait(w, `document.body.textContent.includes('复制会改变未授权的原值')`)
    assert.equal(db.prepare('SELECT score FROM items').get().score, '42')
    await click(w, `document.querySelector('[aria-label="显式类型转换"]').click()`)
    await previewField()
    await pause(200)
    writeFileSync(
      join(process.cwd(), '.artifacts/sqlite-rebuild.png'),
      (await w.webContents.capturePage()).toPNG(),
    )
    await commitField()
    assert.equal(db.prepare('SELECT score FROM items').get().score, 42)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM child').get().n, 1)
    assert.equal(db.prepare('SELECT title FROM original_view').get().title, 'original')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0)
    assert.ok(db.prepare("SELECT name FROM sqlite_schema WHERE name='score_idx'").get())
    await edit('修改字段默认值 score')
    await previewField()
    await commitField()
    assert.equal(
      db
        .prepare('PRAGMA table_info(items)')
        .all()
        .find((row) => row.name === 'score').dflt_value,
      null,
    )
    db.exec("INSERT INTO items(id,title,score) VALUES(2,'next',9)")
    assert.equal(db.prepare('SELECT value FROM audit').get().value, 'next')
    assert.equal(
      db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '__vork_rebuild_%'").all().length,
      0,
    )

    db.exec(
      "CREATE TABLE parent_pair(a INTEGER,b TEXT,PRIMARY KEY(a,b));INSERT INTO parent_pair VALUES(42,'original'),(9,'next')",
    )
    await nativeClick(
      w,
      `Array.from(document.querySelectorAll('[role=tab]')).find(el=>el.textContent.trim()==='外键')`,
    )
    await wait(
      w,
      `Array.from(document.querySelectorAll('button')).some(el=>el.textContent.trim()==='新建外键'&&!el.disabled)`,
    )
    await button(w, '新建外键')
    await input(w, '外键名称', 'fk_gui_pair')
    await input(w, '外键目标表', 'parent_pair')
    await button(w, '读取目标字段')
    await wait(
      w,
      `Boolean(document.querySelector('[aria-label="外键源字段 1"]')) && !document.querySelector('[aria-label="外键源字段 1"]').disabled`,
    )
    await select(w, '外键源字段 1', 'score')
    await select(w, '外键目标字段 1', 'a')
    await button(w, '添加字段映射')
    await select(w, '外键源字段 2', 'title')
    await select(w, '外键目标字段 2', 'b')
    await select(w, '外键更新规则', '级联（CASCADE）')
    await select(w, '外键删除规则', '限制（RESTRICT）')
    await button(w, '预览创建外键')
    await wait(w, `document.body.textContent.includes('待执行结构变更')`)
    assert.equal(db.prepare('PRAGMA foreign_key_list(items)').all().length, 0)
    await pause(200)
    writeFileSync(
      join(process.cwd(), '.artifacts/foreign-key-sqlite.png'),
      (await w.webContents.capturePage()).toPNG(),
    )
    await commitField()
    await wait(
      w,
      `Boolean(document.querySelector('[aria-label="删除外键 fk_gui_pair"]')) && !document.querySelector('[aria-label="删除外键 fk_gui_pair"]').disabled`,
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2)
    assert.equal(db.prepare('PRAGMA foreign_key_list(items)').all().length, 2)
    assert.throws(() => db.exec("INSERT INTO items(id,title,score)VALUES(99,'invalid',999)"))
    db.exec('UPDATE parent_pair SET a=43 WHERE a=42')
    assert.equal(db.prepare('SELECT score FROM items WHERE id=1').get().score, 43)
    await click(w, `document.querySelector('[aria-label="删除外键 fk_gui_pair"]').click()`)
    await wait(w, `document.body.textContent.includes('待执行结构变更')`)
    await commitField()
    await wait(
      w,
      `!document.querySelector('[aria-label="删除外键 fk_gui_pair"]') && !document.body.textContent.includes('正在读取或执行')`,
    )
    db.exec('DELETE FROM parent_pair WHERE a=43')
    assert.equal(db.prepare('SELECT score FROM items WHERE id=1').get().score, 43)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 1)
    console.log(
      'SQLite desktop composite foreign-key mapping, SQL preview, cascade, invalid row rejection and non-destructive drop passed',
    )

    console.log(
      'Schema UI: metadata, protected index, create preview/commit, drop cancellation/commit and SQLite transactional field rebuild/default/type/nullability, rollback and dependency preservation passed',
    )
    clearTimeout(timeout)
    w.destroy()
    db.close()
    rmSync(directory, { recursive: true, force: true })
    app.exit(0)
  } catch (e) {
    console.error(e)
    const w = BrowserWindow.getAllWindows()[0]
    if (w)
      console.error(await w.webContents.executeJavaScript('document.body.innerText.slice(-3000)'))
    clearTimeout(timeout)
    app.exit(1)
  }
})()
