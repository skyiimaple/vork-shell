import { Client, type ClientChannel } from 'ssh2'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { SshTools } from './ssh-tools'
import type { ConnectionConfig } from '../shared/contracts'

export interface SshSession {
  tools: SshTools
  openTerminal(preferred?: 'default'): Promise<string>
  closeTerminal(channelId: string): Promise<void>
  write(data: string, channelId?: string): void
  resize(cols: number, rows: number, channelId?: string): void
  ack(bytes: number, channelId?: string): void
  close(): Promise<void>
}
interface Pty {
  stream: ClientChannel
  decoder: StringDecoder
  queued: string
  ready: boolean
  inFlight: number
}

export async function openSsh(
  config: ConnectionConfig,
  verify: (hash: string) => Promise<boolean>,
  emit: (type: 'data' | 'error' | 'closed', data: string, channelId?: string) => void,
  terminal = true,
): Promise<SshSession> {
  const client = new Client(),
    tools = new SshTools(client)
  const privateKey = config.privateKey ? await readFile(config.privateKey) : undefined
  const channels = new Map<string, Pty>()
  let started = false,
    closed = false,
    opening = 0
  let defaultOpening: Promise<string> | undefined
  const get = (id = 'default') => {
    const pty = channels.get(id)
    if (typeof id !== 'string' || closed || !pty) throw new Error('终端已关闭或不存在')
    return pty
  }
  const flush = (id: string, pty: Pty) => {
    if (!pty.ready || !pty.queued || closed || !channels.has(id) || pty.inFlight >= 128 * 1024)
      return
    const data = pty.queued
    pty.queued = ''
    pty.inFlight += Buffer.byteLength(data)
    emit('data', data, id)
    if (pty.inFlight >= 128 * 1024) pty.stream.pause()
  }
  const openTerminal = async (id: string = randomUUID()): Promise<string> => {
    if (closed) throw new Error('SSH 会话已关闭')
    if (channels.size + opening >= 4) throw new Error('每个 SSH 会话最多 4 个终端')
    opening++
    try {
      const stream = await new Promise<ClientChannel>((resolve, reject) =>
        client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (error, stream) =>
          error ? reject(error) : resolve(stream),
        ),
      )
      if (closed) {
        stream.close()
        throw new Error('SSH 会话已关闭')
      }
      const pty: Pty = {
        stream,
        decoder: new StringDecoder('utf8'),
        queued: '',
        ready: false,
        inFlight: 0,
      }
      channels.set(id, pty)
      const collect = (chunk: Buffer) => {
        if (!channels.has(id) || closed) return
        pty.queued += pty.decoder.write(chunk)
        if (Buffer.byteLength(pty.queued) > 256 * 1024) {
          emit('error', '终端接收缓冲区已满，此分屏已关闭', id)
          channels.delete(id)
          stream.close()
          return
        }
        flush(id, pty)
        if (
          (!pty.ready && Buffer.byteLength(pty.queued) >= 128 * 1024) ||
          pty.inFlight >= 128 * 1024
        )
          stream.pause()
      }
      stream.on('data', collect)
      stream.stderr.on('data', collect)
      stream.on('error', (error: Error) => {
        if (!closed && channels.has(id)) {
          emit('error', error.message, id)
          channels.delete(id)
          stream.close()
        }
      })
      stream.on('close', () => {
        const existed = channels.delete(id)
        if (!closed && existed) emit('closed', '终端已结束', id)
      })
      return id
    } finally {
      opening--
    }
  }
  await new Promise<void>((resolve, reject) => {
    client.on('error', (error) => {
      if (started) emit('error', error.message)
      else reject(error)
    })
    client.on('close', () => {
      closed = true
      channels.clear()
      tools.close()
      if (started) emit('closed', 'SSH 会话已结束')
      else reject(new Error('SSH 连接已关闭'))
    })
    client.on('ready', () => {
      if (!terminal) {
        started = true
        resolve()
        return
      }
      void openTerminal('default').then(() => {
        started = true
        resolve()
      }, reject)
    })
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      privateKey,
      passphrase: config.passphrase,
      readyTimeout: 15000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, callback: (accepted: boolean) => void) => {
        const fingerprint =
          'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
        verify(fingerprint)
          .then(callback)
          .catch(() => callback(false))
      },
    })
  }).catch((error) => {
    client.destroy()
    throw error
  })
  return {
    tools,
    openTerminal(preferred) {
      if (preferred !== undefined && preferred !== 'default')
        return Promise.reject(new Error('终端标识无效'))
      if (!preferred) return openTerminal()
      if (closed) return Promise.reject(new Error('SSH 会话已关闭'))
      if (channels.has('default')) return Promise.resolve('default')
      if (!defaultOpening)
        defaultOpening = openTerminal('default').finally(() => {
          defaultOpening = undefined
        })
      return defaultOpening
    },
    async closeTerminal(id) {
      const pty = get(id)
      channels.delete(id)
      emit('closed', '终端已结束', id)
      pty.stream.close()
    },
    write(data, id) {
      get(id).stream.write(data)
    },
    resize(cols, rows, id) {
      get(id).stream.setWindow(rows, cols, 0, 0)
    },
    // Zero-byte acknowledgement is the renderer attach handshake; discard old renderer credit on remount.
    ack(bytes, id = 'default') {
      const pty = get(id)
      pty.ready = true
      pty.inFlight = bytes === 0 ? 0 : Math.max(0, pty.inFlight - bytes)
      flush(id, pty)
      if (pty.inFlight < 64 * 1024) pty.stream.resume()
    },
    async close() {
      closed = true
      tools.close()
      for (const pty of channels.values()) pty.stream.close()
      channels.clear()
      client.destroy()
    },
  }
}
