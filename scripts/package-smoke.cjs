// Run the actual macOS bundle with isolated user data, without opening a visible window.
const { spawn } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const directory = mkdtempSync(join(tmpdir(), 'vork-packaged-smoke-'))
const executable = resolve(
  process.argv[2] || 'release/mac-arm64/Vork Shell.app/Contents/MacOS/Vork Shell',
)
const child = spawn(
  executable,
  ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
  {
    env: { ...process.env, VORK_TEST_WINDOW: '1', VORK_TEST_USER_DATA: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let output = '',
  socket,
  counter = 0
const pending = new Map()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
child.stderr.on('data', (data) => {
  output += data.toString()
})
child.stdout.on('data', (data) => {
  output += data.toString()
})
function send(method, params) {
  const id = ++counter
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails))
  return reply.result?.value
}
const timeout = setTimeout(() => {
  console.error('Packaged smoke timed out')
  child.kill('SIGKILL')
  process.exitCode = 1
}, 45000)
;(async () => {
  try {
    let port
    for (let i = 0; i < 200; i++) {
      port = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1]
      if (port) break
      if (child.exitCode !== null) throw new Error('Packaged application exited: ' + output)
      await pause(50)
    }
    assert.ok(port, 'Packaged app exposes isolated test debugger')
    let target
    for (let i = 0; i < 100; i++) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = targets.find((item) => item.type === 'page' && item.url.startsWith('file:'))
      if (target) break
      await pause(50)
    }
    assert.ok(target, 'Packaged renderer loaded from bundle')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    socket.addEventListener('message', (event) => {
      const response = JSON.parse(event.data),
        task = pending.get(response.id)
      if (!task) return
      pending.delete(response.id)
      response.error
        ? task.reject(new Error(response.error.message))
        : task.resolve(response.result)
    })
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    for (let i = 0; i < 100; i++) {
      if (
        await evaluate(
          'Boolean(window.vork && document.querySelector(\'[aria-label="查看版本日志"]\'))',
        )
      )
        break
      await pause(50)
    }
    assert.deepEqual(await evaluate('window.vork.profiles()'), [])
    const state = await evaluate('window.vork.updateState()')
    assert.equal(state.status, 'disabled')
    assert.equal(state.currentVersion, '0.1.0')
    const result = await evaluate(
      '(async()=>{const s=await window.vork.connect({type:"sqlite",name:"Packaged smoke",path:":memory:"});try{return await window.vork.execute(s.id,"SELECT 42 AS value")}finally{await window.vork.disconnect(s.id)}})()',
    )
    assert.equal(result.rows[0][0], 42)
    console.log(
      'Packaged application startup, isolated profile, SQLite worker and disabled unsigned updates: passed',
    )
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    socket?.close()
    child.kill('SIGTERM')
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), pause(3000)])
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(directory, { recursive: true, force: true })
  }
})()
