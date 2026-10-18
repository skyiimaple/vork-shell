const { app, BrowserWindow } = require('electron')
const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-column-edit-'))
app.setPath('userData', directory)
require('./smoke-window.cjs')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(w, expression) {
  for (let i = 0; i < 160; i++) {
    if (await w.webContents.executeJavaScript(expression)) return
    await pause(50)
  }
  throw Error(expression)
}
async function click(w, expression) {
  return w.webContents.executeJavaScript(expression)
}
async function button(w, text) {
  return click(
    w,
    `Array.from(document.querySelectorAll('[role=dialog] button')).find(el=>el.textContent.trim()===${JSON.stringify(text)}).click()`,
  )
}
async function input(w, label, value) {
  await click(
    w,
    `(()=>{const el=document.querySelector('[aria-label=${JSON.stringify(label)}]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  )
  await pause(50)
}
async function nativeClick(w, expression) {
  const point = await click(
    w,
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
const fixtures = []
let w
const timeout = setTimeout(() => {
  console.error('Column edit desktop timeout')
  app.exit(1)
}, 60000)
;(async () => {
  let failed = false
  try {
    for (const type of ['mysql', 'postgresql']) {
      const service = type === 'mysql' ? 'mysql' : 'postgres'
      const port = Number(
        execFileSync(
          'docker',
          ['port', `vork-test-${service}-1009`, type === 'mysql' ? '3306/tcp' : '5432/tcp'],
          { encoding: 'utf8' },
        )
          .trim()
          .split(':')
          .pop(),
      )
      const config = {
        type,
        name: 'Native ' + type,
        host: '127.0.0.1',
        port,
        username: 'vork',
        password: 'vork_test_only',
        database: 'vork_test',
      }
      const name = 'ui_col_' + randomUUID().replaceAll('-', ''),
        schema = type === 'mysql' ? 'vork_test' : 'public'
      let connection, query, close
      if (type === 'mysql') {
        connection = await require('mysql2/promise').createConnection({
          host: config.host,
          port: config.port,
          user: config.username,
          password: config.password,
          database: config.database,
        })
        query = async (sql, parameters = []) => {
          const [rows] = await connection.query(sql, parameters)
          return Array.isArray(rows)
            ? rows.map((row) =>
                Object.fromEntries(
                  Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]),
                ),
              )
            : rows
        }
        close = () => connection.end()
      } else {
        connection = new (require('pg').Client)({ ...config, user: config.username })
        await connection.connect()
        query = async (sql, parameters = []) => (await connection.query(sql, parameters)).rows
        close = () => connection.end()
      }
      const qualified = type === 'mysql' ? '`vork_test`.`' + name + '`' : '"public"."' + name + '"'
      fixtures.push({ config, type, name, schema, qualified, query, close })
      await query(
        `CREATE TABLE ${qualified}(id INTEGER PRIMARY KEY,title VARCHAR(40) ${type === 'mysql' ? "CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'old' COMMENT 'keep me'" : "NOT NULL DEFAULT 'old'"},numeric_text TEXT)`,
      )
      await query(`INSERT INTO ${qualified}(id,numeric_text) VALUES(1,'42')`)
    }
    await import('../out/main/index.js')
    await app.whenReady()
    w = BrowserWindow.getAllWindows()[0]
    if (w.webContents.isLoading())
      await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    for (const fixture of fixtures)
      await click(w, `window.vork.saveProfile(${JSON.stringify(fixture.config)})`)
    w.webContents.reload()
    await new Promise((resolve) => w.webContents.once('did-finish-load', resolve))
    for (const f of fixtures) {
      const { type, name, schema, qualified, query, config } = f
      const label = '连接 ' + config.name
      await wait(w, `Boolean(document.querySelector('[aria-label=${JSON.stringify(label)}]'))`)
      await click(w, `document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`)
      const inspect = '查看结构 ' + schema + '.' + name
      await wait(
        w,
        `Boolean(document.querySelector('[aria-label=${JSON.stringify(inspect)}]')) && !document.querySelector('[aria-label=${JSON.stringify(inspect)}]').disabled`,
      )
      await click(w, `document.querySelector('[aria-label=${JSON.stringify(inspect)}]').click()`)
      await wait(
        w,
        `document.querySelector('[role=dialog]')?.textContent.includes('结构管理') && !document.body.textContent.includes('正在读取或执行')`,
      )
      await nativeClick(
        w,
        `Array.from(document.querySelectorAll('[role=tab]')).find(el=>el.textContent.trim()==='字段')`,
      )
      async function edit(label) {
        await wait(
          w,
          `Boolean(document.querySelector('[aria-label=${JSON.stringify(label)}]')) && !document.querySelector('[aria-label=${JSON.stringify(label)}]').disabled`,
        )
        await click(w, `document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`)
      }
      async function preview() {
        await button(w, '预览字段变更')
        await wait(w, `document.body.textContent.includes('待执行结构变更')`)
      }
      async function commit() {
        await button(w, '确认执行结构变更')
        await wait(
          w,
          `!document.body.textContent.includes('待执行结构变更') && !document.body.textContent.includes('正在读取或执行')`,
        )
      }
      async function metadata() {
        return (
          await query(
            "SELECT column_name,data_type,character_maximum_length,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$SCHEMA AND table_name=$TABLE AND column_name='title'"
              .replace('$SCHEMA', type === 'mysql' ? '?' : '$1')
              .replace('$TABLE', type === 'mysql' ? '?' : '$2'),
            [schema, name],
          )
        )[0]
      }
      await edit('修改字段类型 title')
      await input(w, '字段类型', 'VARCHAR(80)')
      await preview()
      assert.equal(Number((await metadata()).character_maximum_length), 40)
      await commit()
      assert.equal(Number((await metadata()).character_maximum_length), 80)
      await edit('修改字段可空 title')
      await click(w, `document.querySelector('[aria-label="字段允许 NULL"]').click()`)
      await preview()
      await commit()
      assert.equal((await metadata()).is_nullable, 'YES')
      await edit('修改字段默认值 title')
      await select(w, '字段默认值类型', '文本')
      await input(w, '字段默认值', "next ' \\value")
      await preview()
      await commit()
      await query(`INSERT INTO ${qualified}(id) VALUES(2)`)
      assert.equal(
        (await query(`SELECT title FROM ${qualified} WHERE id=2`))[0].title,
        "next ' \\value",
      )
      await edit('修改字段默认值 title')
      await preview()
      await wait(w, `document.body.textContent.includes('DROP DEFAULT')`)
      await commit()
      assert.equal((await metadata()).column_default, null)
      await edit('修改字段可空 title')
      await click(w, `document.querySelector('[aria-label="字段允许 NULL"]').click()`)
      await preview()
      mkdirSync(join(process.cwd(), '.artifacts'), { recursive: true })
      await pause(200)
      writeFileSync(
        join(process.cwd(), '.artifacts/schema-edit-' + type + '.png'),
        (await w.webContents.capturePage()).toPNG(),
      )
      await commit()
      assert.equal((await metadata()).is_nullable, 'NO')
      if (type === 'postgresql') {
        await edit('修改字段类型 numeric_text')
        await input(w, '字段类型', 'INTEGER')
        await click(w, `document.querySelector('[aria-label="显式类型转换"]').click()`)
        await preview()
        await wait(w, `document.body.textContent.includes('USING')`)
        await commit()
        assert.equal(
          (await query(`SELECT numeric_text FROM ${qualified} WHERE id=1`))[0].numeric_text,
          42,
        )
      } else {
        const row = (
          await query(
            "SELECT column_comment AS column_comment,collation_name AS collation_name FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name='title'",
            [schema, name],
          )
        )[0]
        assert.equal(row.column_comment, 'keep me')
        assert.equal(row.collation_name, 'utf8mb4_bin')
      }
      assert.equal((await query(`SELECT title FROM ${qualified} WHERE id=1`))[0].title, 'old')
      const refName = name + '_ref',
        refQualified =
          type === 'mysql'
            ? '`' + schema + '`.`' + refName + '`'
            : '"' + schema + '"."' + refName + '"',
        fkName = name + '_fk'
      f.referenceQualified = refQualified
      await query(
        `CREATE TABLE ${refQualified}(a INTEGER,b VARCHAR(40) ${type === 'mysql' ? 'CHARACTER SET utf8mb4 COLLATE utf8mb4_bin' : ''},PRIMARY KEY(a,b))`,
      )
      await query(`INSERT INTO ${refQualified}(a,b)VALUES(${type === 'mysql' ? '?,?' : '$1,$2'})`, [
        1,
        'old',
      ])
      await query(`INSERT INTO ${refQualified}(a,b)VALUES(${type === 'mysql' ? '?,?' : '$1,$2'})`, [
        2,
        "next ' \\value",
      ])
      await nativeClick(
        w,
        `Array.from(document.querySelectorAll('[role=tab]')).find(el=>el.textContent.trim()==='外键')`,
      )
      await wait(
        w,
        `Array.from(document.querySelectorAll('button')).some(el=>el.textContent.trim()==='新建外键'&&!el.disabled)`,
      )
      await button(w, '新建外键')
      await input(w, '外键名称', fkName)
      await input(w, '外键目标表', refName)
      await button(w, '读取目标字段')
      await wait(
        w,
        `Boolean(document.querySelector('[aria-label="外键源字段 1"]')) && !document.querySelector('[aria-label="外键源字段 1"]').disabled`,
      )
      await select(w, '外键源字段 1', 'id')
      await select(w, '外键目标字段 1', 'a')
      await button(w, '添加字段映射')
      await select(w, '外键源字段 2', 'title')
      await select(w, '外键目标字段 2', 'b')
      await select(w, '外键更新规则', '级联（CASCADE）')
      await select(w, '外键删除规则', '限制（RESTRICT）')
      await button(w, '预览创建外键')
      await wait(w, `document.body.textContent.includes('待执行结构变更')`)
      const countForeign = async () =>
        Number(
          (
            await query(
              `SELECT COUNT(*) AS n FROM information_schema.table_constraints WHERE table_schema=${type === 'mysql' ? '?' : '$1'} AND table_name=${type === 'mysql' ? '?' : '$2'} AND constraint_type='FOREIGN KEY'`,
              [schema, name],
            )
          )[0].n,
        )
      assert.equal(await countForeign(), 0)
      await pause(200)
      writeFileSync(
        join(process.cwd(), '.artifacts/foreign-key-' + type + '.png'),
        (await w.webContents.capturePage()).toPNG(),
      )
      await commit()
      await wait(
        w,
        `Boolean(document.querySelector('[aria-label=${JSON.stringify('删除外键 ' + fkName)}]')) && !document.querySelector('[aria-label=${JSON.stringify('删除外键 ' + fkName)}]').disabled`,
      )
      assert.equal(await countForeign(), 1)
      await assert.rejects(query(`INSERT INTO ${qualified}(id,title) VALUES(99,'bad')`))
      await query(`UPDATE ${refQualified} SET a=3 WHERE a=1`)
      assert.equal((await query(`SELECT title FROM ${qualified} WHERE id=3`))[0].title, 'old')
      await click(
        w,
        `document.querySelector('[aria-label=${JSON.stringify('删除外键 ' + fkName)}]').click()`,
      )
      await wait(w, `document.body.textContent.includes('待执行结构变更')`)
      await commit()
      await wait(
        w,
        `!document.querySelector('[aria-label=${JSON.stringify('删除外键 ' + fkName)}]') && !document.body.textContent.includes('正在读取或执行')`,
      )
      assert.equal(await countForeign(), 0)
      await query(`DELETE FROM ${refQualified} WHERE a=3`)
      assert.equal((await query(`SELECT title FROM ${qualified} WHERE id=3`))[0].title, 'old')
      console.log(
        type +
          ': desktop composite foreign-key mapping, create/drop, rules, cascade and invalid row rejection passed',
      )

      await click(w, `document.querySelector('[data-slot="dialog-close"]').click()`)
      await wait(w, `!document.querySelector('[role=dialog]')`)
      console.log(
        type +
          ': desktop field type, nullable, set/drop default, preserved attributes and actual data passed',
      )
    }
  } catch (error) {
    failed = true
    console.error(error)
    if (w) console.error(await click(w, 'document.body.innerText.slice(-4000)'))
  } finally {
    clearTimeout(timeout)
    if (w) w.destroy()
    for (const fixture of fixtures) {
      try {
        await fixture.query(`DROP TABLE IF EXISTS ${fixture.qualified}`)
        if (fixture.referenceQualified)
          await fixture.query(`DROP TABLE IF EXISTS ${fixture.referenceQualified}`)
      } catch (error) {
        failed = true
        console.error(error)
      } finally {
        await fixture.close()
      }
    }
    rmSync(directory, { recursive: true, force: true })
    app.exit(failed ? 1 : 0)
  }
})()
