// Isolated SSH/SFTP protocol fixture. Uses in-memory remote files and ephemeral loopback ports.
const { Server } = require('ssh2')
const { createServer, connect } = require('node:net')
const { generateKeyPairSync } = require('node:crypto')
const { posix } = require('node:path')
async function createSshFixture() {
  const hooks = {}
  const clients = new Set(),
    echoSockets = new Set()
  const files = new Map([['/hello.txt', Buffer.from('hello from SFTP\n')]])
  const folders = new Set(['/', '/files'])
  const echo = createServer((socket) => {
    echoSockets.add(socket)
    socket.on('error', () => {})
    socket.on('data', (data) => socket.write(data))
    socket.on('close', () => echoSockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    echo.once('error', reject)
    echo.listen(0, '127.0.0.1', () => {
      echo.removeListener('error', reject)
      resolve()
    })
  })
  const echoPort = echo.address().port
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  })
  const attrs = (path) => ({
    mode: folders.has(path) ? 0o040755 : 0o100600,
    size: files.get(path)?.length || 0,
    uid: 1,
    gid: 1,
    atime: 1700000000,
    mtime: 1700000000,
  })
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) =>
      ctx.username === 'fixture' && ctx.method === 'password' && ctx.password === 'fixture'
        ? ctx.accept()
        : ctx.reject(),
    )
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        if (
          info.destIP !== '127.0.0.1' ||
          (info.destPort !== echoPort && !hooks.allowForward?.(info.destPort))
        )
          return reject()
        const socket = connect(info.destPort, '127.0.0.1', () => {
          const channel = accept()
          channel.on('error', () => socket.destroy())
          channel.on('close', () => socket.destroy())
          socket.on('close', () => channel.destroy())
          socket.pipe(channel).pipe(socket)
        })
        socket.on('error', () => reject())
      })
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (accept) => accept?.())
        session.on('window-change', (accept) => accept?.())
        session.on('shell', (accept) => {
          const channel = accept()
          channel.write('fixture terminal ready\r\n')
          channel.on('data', (data) => channel.write(data))
        })
        session.on('sftp', (accept) => {
          const sftp = accept(),
            handles = new Map()
          let serial = 0
          sftp.on('error', () => {})
          const handle = (id, value) => {
            const key = String(++serial)
            handles.set(key, value)
            sftp.handle(id, Buffer.from(key))
          }
          const exists = (path) => files.has(path) || folders.has(path)
          sftp.on('REALPATH', (id, path) => {
            const absolute = posix.resolve('/', path)
            if (!exists(absolute)) return sftp.status(id, 2)
            sftp.name(id, [{ filename: absolute, longname: absolute, attrs: attrs(absolute) }])
          })
          for (const event of ['STAT', 'LSTAT'])
            sftp.on(event, (id, path) =>
              exists(path) ? sftp.attrs(id, attrs(path)) : sftp.status(id, 2),
            )
          sftp.on('FSTAT', (id, h) => {
            const value = handles.get(h.toString())
            value ? sftp.attrs(id, attrs(value.path)) : sftp.status(id, 4)
          })
          sftp.on('OPENDIR', (id, path) =>
            folders.has(path)
              ? handle(id, { path, directory: true, done: false })
              : sftp.status(id, 2),
          )
          sftp.on('READDIR', (id, h) => {
            const value = handles.get(h.toString())
            if (!value?.directory) return sftp.status(id, 4)
            if (value.done) return sftp.status(id, 1)
            value.done = true
            const entries = [...new Set([...folders, ...files.keys()])]
              .filter((path) => path !== value.path && posix.dirname(path) === value.path)
              .map((path) => ({
                filename: posix.basename(path),
                longname: posix.basename(path),
                attrs: attrs(path),
              }))
            entries.length ? sftp.name(id, entries) : sftp.status(id, 1)
          })
          sftp.on('OPEN', (id, path, flags) => {
            if (flags & 2) {
              if (flags & 32 && exists(path)) return sftp.status(id, 4)
              if (!folders.has(posix.dirname(path)) || folders.has(path)) return sftp.status(id, 4)
              if (!files.has(path) || flags & 16) files.set(path, Buffer.alloc(0))
            } else if (!files.has(path)) return sftp.status(id, 2)
            handle(id, { path, directory: false })
          })
          sftp.on('READ', (id, h, offset, length) => {
            const value = handles.get(h.toString()),
              data = files.get(value?.path)
            if (!data) return sftp.status(id, 4)
            const reply = () =>
              offset >= data.length
                ? sftp.status(id, 1)
                : sftp.data(id, data.subarray(offset, offset + length))
            hooks.readDelay ? setTimeout(reply, hooks.readDelay) : reply()
          })
          sftp.on('WRITE', (id, h, offset, data) => {
            const value = handles.get(h.toString())
            if (!value || offset + data.length > 1048576) return sftp.status(id, 4)
            const old = files.get(value.path),
              next = Buffer.alloc(Math.max(old.length, offset + data.length))
            old.copy(next)
            data.copy(next, offset)
            files.set(value.path, next)
            hooks.onWrite?.()
            sftp.status(id, 0)
          })
          sftp.on('CLOSE', (id, h) => {
            handles.delete(h.toString())
            sftp.status(id, 0)
          })
          sftp.on('MKDIR', (id, path) => {
            if (exists(path) || !folders.has(posix.dirname(path))) return sftp.status(id, 4)
            folders.add(path)
            sftp.status(id, 0)
          })
          sftp.on('RENAME', (id, oldPath, newPath) => {
            hooks.beforeRename?.(oldPath, newPath)
            if (!files.has(oldPath) || exists(newPath)) return sftp.status(id, 4)
            files.set(newPath, files.get(oldPath))
            files.delete(oldPath)
            sftp.status(id, 0)
          })
          sftp.on('RMDIR', (id, path) => {
            if (
              path === '/' ||
              !folders.has(path) ||
              [...folders, ...files.keys()].some((p) => p !== path && posix.dirname(p) === path)
            )
              return sftp.status(id, 4)
            folders.delete(path)
            sftp.status(id, 0)
          })
          sftp.on('REMOVE', (id, path) =>
            files.delete(path) ? sftp.status(id, 0) : sftp.status(id, 2),
          )
          sftp.on('FSETSTAT', (id) => sftp.status(id, 0))
          sftp.on('SETSTAT', (id) => sftp.status(id, 0))
        })
      })
    })
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await new Promise((resolve) => echo.close(resolve))
    throw error
  }
  return {
    port: server.address().port,
    echoPort,
    files,
    folders,
    key,
    hooks,
    disconnect() {
      for (const client of clients) client.end()
    },
    async close() {
      for (const client of clients) client.end()
      for (const socket of echoSockets) socket.destroy()
      await Promise.all([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => echo.close(resolve)),
      ])
    },
  }
}
module.exports = { createSshFixture }
