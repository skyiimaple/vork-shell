import { expect, test } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SshTools } from '../src/main/ssh-tools'
test('batch download atomically refuses an existing local destination and cleans temporary file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vork-batch-'))
  const fake = {
    sftp(callback: any) {
      callback(null, {
        stat(_path: any, cb: any) {
          cb(null, { size: 6, isFile: () => true })
        },
        lstat(_path: any, cb: any) {
          cb(null, { size: 6, isFile: () => true })
        },
        createReadStream: () => Readable.from(['remote']),
        end() {},
      })
    },
  }
  const tools = new SshTools(fake as any)
  try {
    const target = join(dir, 'local.txt')
    await writeFile(target, 'original')
    await expect(
      tools.transfer('download', '/remote', target, { noOverwrite: true }),
    ).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('original')
    expect(await readdir(dir)).toEqual(['local.txt'])
    const fresh = join(dir, 'fresh.txt')
    await tools.transfer('download', '/remote', fresh, { noOverwrite: true })
    expect(await readFile(fresh, 'utf8')).toBe('remote')
    expect((await readdir(dir)).sort()).toEqual(['fresh.txt', 'local.txt'])
  } finally {
    tools.close()
    await rm(dir, { recursive: true, force: true })
  }
})
test('batch download refuses symlinks and other nonordinary remote entries', async () => {
  const fake = {
    sftp(callback: any) {
      callback(null, {
        lstat(_path: any, cb: any) {
          cb(null, { size: 1, isFile: () => false })
        },
        stat(_path: any, cb: any) {
          cb(null, { size: 1, isFile: () => true })
        },
        createReadStream() {
          throw new Error('must not open')
        },
        end() {},
      })
    },
  }
  const tools = new SshTools(fake as any)
  try {
    await expect(
      tools.transfer('download', '/symlink', '/unused', { noOverwrite: true }),
    ).rejects.toThrow('普通文件')
  } finally {
    tools.close()
  }
})
