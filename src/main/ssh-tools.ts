import type { Client, FileEntry, SFTPWrapper, Stats } from 'ssh2'
import { createServer, type Server, type Socket } from 'node:net'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat, rename, rm, link } from 'node:fs/promises'
import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Transform, type Stream } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SshRequest, SshResponse, Tunnel, TransferProgress } from '../shared/contracts'
export interface TransferOptions {
  noOverwrite?: boolean
  onProgress?: (progress: TransferProgress) => void
}
const MAX_FILE = 100 * 1024 * 1024
export function remotePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > 4096 ||
    /[\0\uFFFD]/.test(value) ||
    Buffer.from(value).toString('utf8') !== value
  )
    throw new Error('远端路径无效或无法无损编码')
  return value
}
export class SshTools {
  private closed = false
  private sftpPromise?: Promise<SFTPWrapper>
  private tunnels = new Map<string, { server: Server; info: Tunnel; sockets: Set<Socket> }>()
  private streams = new Set<Stream & { destroy(): unknown }>()
  private transferBusy = false
  private transferAbort?: AbortController
  private committing = false
  cancelTransfer() {
    if (!this.committing) this.transferAbort?.abort()
  }
  private uploadTemporary?: string
  constructor(private client: Client) {}
  private async sftp() {
    if (this.closed) throw new Error('SSH 会话已关闭')
    if (!this.sftpPromise)
      this.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) =>
        this.client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp))),
      ).catch((error) => {
        this.sftpPromise = undefined
        throw error
      })
    return this.sftpPromise
  }
  private async timed<T>(action: () => Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        action(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.close()
            this.client.destroy()
            reject(
              new Error(
                'SSH 操作超时，连接已关闭' +
                  (this.uploadTemporary ? `；远端可能残留临时文件：${this.uploadTemporary}` : ''),
              ),
            )
          }, milliseconds)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async request(request: SshRequest): Promise<SshResponse> {
    return this.timed(() => this.perform(request), 30000)
  }
  private async perform(request: SshRequest): Promise<SshResponse> {
    if (!request || typeof request !== 'object' || this.closed)
      throw new Error('SSH 操作无效或会话已关闭')
    if (request.kind === 'tunnels')
      return { kind: 'tunnels', tunnels: [...this.tunnels.values()].map((entry) => entry.info) }
    if (request.kind === 'tunnel-stop') {
      if (typeof request.id !== 'string' || !this.tunnels.has(request.id))
        throw new Error('隧道不存在')
      this.stop(request.id)
      return { kind: 'done' }
    }
    if (request.kind === 'tunnel-start') {
      if (
        typeof request.host !== 'string' ||
        !/^[a-zA-Z0-9.:-]{1,253}$/.test(request.host) ||
        !Number.isInteger(request.port) ||
        request.port < 1 ||
        request.port > 65535 ||
        !Number.isInteger(request.localPort) ||
        request.localPort < 0 ||
        request.localPort > 65535
      )
        throw new Error('隧道地址或端口无效')
      if (this.tunnels.size >= 4) throw new Error('每个会话最多 4 条隧道')
      const id = randomUUID(),
        sockets = new Set<Socket>(),
        info: Tunnel = { id, localPort: 0, host: request.host, port: request.port }
      const server = createServer((socket) => {
        if (this.closed || sockets.size >= 64) {
          socket.destroy()
          return
        }
        sockets.add(socket)
        socket.on('error', () => {})
        socket.once('close', () => sockets.delete(socket))
        this.client.forwardOut(
          '127.0.0.1',
          socket.remotePort || 0,
          request.host,
          request.port,
          (error, channel) => {
            if (error || socket.destroyed || this.closed) {
              channel?.destroy()
              socket.destroy()
              return
            }
            channel.on('error', () => socket.destroy())
            channel.once('close', () => socket.destroy())
            socket.once('close', () => channel.destroy())
            socket.pipe(channel).pipe(socket)
          },
        )
      })
      this.tunnels.set(id, { server, info, sockets })
      try {
        await new Promise<void>((resolve, reject) => {
          const stopped = () => reject(new Error('隧道监听已关闭'))
          server.once('close', stopped)
          server.once('error', reject)
          server.listen(request.localPort, '127.0.0.1', () => {
            server.removeListener('close', stopped)
            server.removeListener('error', reject)
            server.on('error', () => this.stop(id))
            resolve()
          })
        })
        if (this.closed || !this.tunnels.has(id)) throw new Error('SSH 会话已关闭')
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('隧道监听失败')
        info.localPort = address.port
        return { kind: 'tunnels', tunnels: [...this.tunnels.values()].map((entry) => entry.info) }
      } catch (error) {
        this.stop(id)
        throw error
      }
    }
    if (
      request.kind !== 'list' &&
      request.kind !== 'mkdir' &&
      request.kind !== 'rename' &&
      request.kind !== 'delete'
    )
      throw new Error('SSH 操作无效')
    const path = remotePath(request.path),
      sftp = await this.sftp()
    if (request.kind === 'rename' || request.kind === 'delete') {
      if (this.transferBusy) throw new Error('传输正在进行，请稍后修改文件')
      const normalized = posix.normalize(path)
      if (['/', '.', '..'].includes(normalized) || ['.', '..'].includes(posix.basename(path)))
        throw new Error('不能操作根目录或上级目录')
      if (request.kind === 'rename') {
        const name = request.newName
        if (
          typeof name !== 'string' ||
          !name ||
          /[/\\\0\u0000-\u001f\u007f]/.test(name) ||
          ['.', '..'].includes(name) ||
          Buffer.byteLength(name) > 255
        )
          throw new Error('新名称无效')
        remotePath(name)
        const target = posix.join(posix.dirname(path), name)
        const exists = await new Promise<boolean>((resolve, reject) =>
          sftp.lstat(target, (error) =>
            error
              ? Number((error as Error & { code?: number }).code) === 2
                ? resolve(false)
                : reject(error)
              : resolve(true),
          ),
        )
        if (exists) throw new Error('目标已存在，未覆盖')
        await new Promise<void>((resolve, reject) =>
          sftp.rename(path, target, (error) => (error ? reject(error) : resolve())),
        )
      } else {
        const attrs = await new Promise<Stats>((resolve, reject) =>
          sftp.lstat(path, (error, value) => (error ? reject(error) : resolve(value))),
        )
        await new Promise<void>((resolve, reject) =>
          sftp[attrs.isDirectory() ? 'rmdir' : 'unlink'](path, (error) =>
            error ? reject(error) : resolve(),
          ),
        )
      }
      return { kind: 'done' }
    }
    if (request.kind === 'mkdir') {
      await new Promise<void>((resolve, reject) =>
        sftp.mkdir(path, { mode: 0o755 }, (error) => (error ? reject(error) : resolve())),
      )
      return { kind: 'done' }
    }
    const absolute = await new Promise<string>((resolve, reject) =>
      sftp.realpath(path, (error, value) => (error ? reject(error) : resolve(value))),
    )
    const handle = await new Promise<Buffer>((resolve, reject) =>
      sftp.opendir(absolute, (error, value) => (error ? reject(error) : resolve(value))),
    )
    const entries: Extract<SshResponse, { kind: 'listing' }>['entries'] = []
    let truncated = false
    try {
      for (let batch = 0; batch < 1000; batch++) {
        const values = await new Promise<FileEntry[] | false>((resolve, reject) =>
          sftp.readdir(handle, (error, value) =>
            error
              ? Number((error as Error & { code?: number }).code) === 1
                ? resolve(false)
                : reject(error)
              : resolve(value),
          ),
        )
        if (values === false) break
        for (const value of values) {
          if (value.filename === '.' || value.filename === '..') continue
          if (entries.length >= 2000) {
            truncated = true
            break
          }
          entries.push({
            name: value.filename,
            directory: (value.attrs.mode & 0o170000) === 0o040000,
            regularFile: (value.attrs.mode & 0o170000) === 0o100000,
            size: value.attrs.size,
            modified: value.attrs.mtime,
          })
        }
        if (truncated) break
        if (batch === 999) truncated = true
      }
    } finally {
      await new Promise<void>((resolve) => sftp.close(handle, () => resolve()))
    }
    entries.sort(
      (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
    )
    return { kind: 'listing', path: absolute, entries, truncated }
  }
  async transfer(
    kind: 'upload' | 'download',
    remote: string,
    local: string,
    options: TransferOptions = {},
  ) {
    return this.timed(() => this.performTransfer(kind, remote, local, options), 120000)
  }
  private async performTransfer(
    kind: 'upload' | 'download',
    remote: string,
    local: string,
    options: TransferOptions,
  ) {
    remotePath(remote)
    if (this.transferBusy || this.closed) throw new Error('文件传输正在进行或 SSH 已关闭')
    this.transferBusy = true
    const controller = (this.transferAbort = new AbortController())
    this.committing = false
    let total = 0,
      lastProgress = 0
    const progress = (state: TransferProgress['state'], force = false) => {
      if (force || Date.now() - lastProgress >= 80) {
        lastProgress = Date.now()
        options.onProgress?.({ file: remote, direction: kind, bytes, total, state })
      }
    }
    let temporary: string | undefined,
      remoteTemporary: string | undefined,
      remoteCreated = false,
      sftp: SFTPWrapper | undefined
    let bytes = 0
    const tracked: (Stream & { destroy(): unknown })[] = []
    try {
      sftp = await this.sftp()
      const attrs =
        kind === 'upload'
          ? await stat(local)
          : await new Promise<Stats>((resolve, reject) =>
              sftp![options.noOverwrite ? 'lstat' : 'stat'](remote, (error, attrs) =>
                error ? reject(error) : resolve(attrs),
              ),
            )
      if (!attrs.isFile() || attrs.size > MAX_FILE)
        throw new Error('仅支持不超过 100 MiB 的普通文件')
      total = attrs.size
      progress('transferring', true)
      controller.signal.throwIfAborted()
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          progress('transferring')
          callback(bytes > MAX_FILE ? new Error('文件超过 100 MiB') : null, chunk)
        },
      })
      if (kind === 'upload') {
        const existing = await new Promise<boolean>((resolve, reject) =>
          sftp!.lstat(remote, (error) =>
            error
              ? Number((error as Error & { code?: number }).code) === 2
                ? resolve(false)
                : reject(error)
              : resolve(true),
          ),
        )
        if (existing) throw new Error('远端目标已存在，未覆盖')
        remoteTemporary = posix.join(posix.dirname(remote), '.vork-' + randomUUID() + '.part')
        this.uploadTemporary = remoteTemporary
      }
      controller.signal.throwIfAborted()
      if (kind === 'download') temporary = local + '.vork-' + randomUUID() + '.part'
      const input = kind === 'upload' ? createReadStream(local) : sftp.createReadStream(remote)
      const output =
        kind === 'upload'
          ? sftp.createWriteStream(remoteTemporary!, { flags: 'wx', mode: 0o600 })
          : createWriteStream(temporary!, { flags: 'wx', mode: 0o600 })
      if (kind === 'upload') output.once('open', () => (remoteCreated = true))
      tracked.push(input, output, limiter)
      for (const stream of tracked) this.streams.add(stream)
      await pipeline(input, limiter, output, { signal: controller.signal })
      controller.signal.throwIfAborted()
      if (this.closed) throw new Error('SSH 会话已关闭')
      this.committing = true
      progress('committing', true)
      if (remoteTemporary) {
        await new Promise<void>((resolve, reject) =>
          sftp!.rename(remoteTemporary!, remote, (error) => (error ? reject(error) : resolve())),
        )
        remoteTemporary = undefined
        this.uploadTemporary = undefined
      }
      if (temporary) {
        if (options.noOverwrite) {
          await link(temporary, local)
          await rm(temporary)
        } else await rename(temporary, local)
        temporary = undefined
      }
      progress('complete', true)
      return {
        kind: 'transfer' as const,
        bytes,
        file: kind === 'upload' ? remote : local,
        canceled: false,
      }
    } catch (error) {
      if (kind === 'upload' && remoteCreated && remoteTemporary && sftp && !this.closed)
        await new Promise<void>((resolve) => sftp!.unlink(remoteTemporary!, () => resolve()))
      if (kind === 'upload' && this.closed && remoteTemporary)
        throw new Error(`上传未完成；远端可能残留临时文件：${remoteTemporary}`, { cause: error })
      if (controller.signal.aborted && !this.closed) {
        progress('canceled', true)
        return {
          kind: 'transfer' as const,
          bytes,
          file: kind === 'upload' ? remote : local,
          canceled: true,
        }
      }
      throw error
    } finally {
      this.transferAbort = undefined
      this.committing = false
      for (const stream of tracked) this.streams.delete(stream)
      if (temporary) await rm(temporary, { force: true })
      this.transferBusy = false
      this.uploadTemporary = undefined
    }
  }
  private stop(id: string) {
    const entry = this.tunnels.get(id)
    if (!entry) return
    this.tunnels.delete(id)
    for (const socket of entry.sockets) socket.destroy()
    entry.server.close()
  }
  close() {
    this.closed = true
    for (const id of this.tunnels.keys()) this.stop(id)
    for (const stream of this.streams) stream.destroy()
    void this.sftpPromise?.then((sftp) => sftp.end()).catch(() => {})
  }
}
