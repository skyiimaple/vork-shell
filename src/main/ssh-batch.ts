import { basename, join, posix } from 'node:path'
import type { SshBatchTransferResult, SshTransferResult } from '../shared/contracts'
import type { SessionManager } from './sessions'
import { remotePath } from './ssh-tools'

export function safeRemoteBasename(name: string): string {
  remotePath(name)
  if (
    name === '.' ||
    name === '..' ||
    /[/\\:\u0000-\u001f\u007f]/.test(name) ||
    Buffer.byteLength(name) > 255
  )
    throw new Error('文件名无效，不能安全保存到目标目录')
  return name
}
type Transfer = (
  kind: 'upload' | 'download',
  remote: string,
  local: string,
  options: { noOverwrite: true },
) => Promise<SshTransferResult>
export async function runTransferBatch(
  kind: 'upload' | 'download',
  files: string[],
  destination: string,
  transfer: Transfer,
): Promise<SshBatchTransferResult> {
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.length > 100 ||
    files.some((file) => typeof file !== 'string')
  )
    throw new Error('每批请选择 1 至 100 个文件')
  if (typeof destination !== 'string' || !destination) throw new Error('目标目录无效')
  const results: SshBatchTransferResult['results'] = [],
    used = new Set<string>()
  for (const source of files) {
    let name = kind === 'upload' ? basename(source) : posix.basename(source)
    try {
      if (kind === 'download') remotePath(source)
      name = safeRemoteBasename(name)
      if (used.has(name)) throw new Error('本批次包含重复文件名，未覆盖')
      used.add(name)
      const remote = kind === 'upload' ? posix.join(remotePath(destination), name) : source
      const local = kind === 'upload' ? source : join(destination, name)
      const result = await transfer(kind, remote, local, { noOverwrite: true })
      if (result.canceled) {
        results.push({ name, file: result.file, ok: false, bytes: result.bytes, error: '已取消' })
        return { kind: 'batch-transfer', canceled: true, results }
      }
      results.push({ name, file: result.file, ok: true, bytes: result.bytes })
    } catch (error) {
      results.push({
        name,
        file: source,
        ok: false,
        bytes: 0,
        error: error instanceof Error ? error.message : '传输失败',
      })
    }
  }
  return { kind: 'batch-transfer', canceled: false, results }
}
// Electron IPC payloads are untyped. Callers narrow each argument.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Register = (channel: string, action: (owner: number, ...args: any[]) => unknown) => void
export function registerSshBatch(
  handle: Register,
  sessions: Pick<SessionManager, 'getSsh'> & Partial<Pick<SessionManager, 'transferProgress'>>,
  pickFiles: () => Promise<string[] | null>,
  pickDirectory: () => Promise<string | null>,
) {
  const busy = new Set<string>()
  handle('vork:ssh-transfer-batch', async (owner, id, kind, selection) => {
    sessions.getSsh(owner, id)
    if (kind !== 'upload' && kind !== 'download') throw new Error('文件传输类型无效')
    if (kind === 'upload') remotePath(selection)
    else if (
      !Array.isArray(selection) ||
      !selection.length ||
      selection.length > 100 ||
      selection.some((path) => {
        remotePath(path)
        return !safeRemoteBasename(posix.basename(path))
      })
    )
      throw new Error('每批请选择 1 至 100 个普通文件')
    if (busy.has(id)) throw new Error('批量文件传输正在进行')
    busy.add(id)
    try {
      const chosen = kind === 'upload' ? await pickFiles() : await pickDirectory()
      if (!chosen || (Array.isArray(chosen) && !chosen.length))
        return { kind: 'batch-transfer', canceled: true, results: [] }
      sessions.getSsh(owner, id)
      return await runTransferBatch(
        kind,
        kind === 'upload' ? (chosen as string[]) : selection,
        kind === 'upload' ? selection : (chosen as string),
        (direction, remote, local, options) =>
          sessions.getSsh(owner, id).tools.transfer(direction, remote, local, {
            ...options,
            onProgress: (progress) => sessions.transferProgress?.(owner, id, progress),
          }),
      )
    } finally {
      busy.delete(id)
    }
  })
}
