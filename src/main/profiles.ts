import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConnectionConfig } from '../shared/contracts'
import { validateConnection } from './validation'
import { duplicateConnection } from '../shared/connection-identity'
import { profileIdentity } from './connection-import'

interface CredentialCipher {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
type StoredProfile = ConnectionConfig & { encryptedCredentials?: string }

export class ProfileStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private directory: string,
    private cipher?: CredentialCipher,
  ) {}
  private async read(): Promise<StoredProfile[]> {
    try {
      return JSON.parse(await readFile(join(this.directory, 'connections.json'), 'utf8'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
  }
  async projectSeeds() {
    return (await this.read()).map(({ id, group }) => ({ id, group }))
  }
  async list(): Promise<ConnectionConfig[]> {
    return (await this.read()).map(({ encryptedCredentials, ...profile }) => {
      if (!encryptedCredentials) return profile
      if (!this.cipher?.isEncryptionAvailable())
        throw new Error('系统凭据加密不可用，无法读取已保存的密码')
      const secrets = JSON.parse(
        this.cipher.decryptString(Buffer.from(encryptedCredentials, 'base64')),
      )
      return { ...profile, password: secrets.password, passphrase: secrets.passphrase }
    })
  }
  private update(fn: (items: StoredProfile[]) => StoredProfile[]) {
    const operation = this.queue.then(async () => {
      const items = fn(await this.read())
      await mkdir(this.directory, { recursive: true })
      const destination = join(this.directory, 'connections.json')
      const temp = destination + '.' + randomUUID() + '.tmp'
      await writeFile(temp, JSON.stringify(items, null, 2), { mode: 0o600 })
      await rename(temp, destination)
    })
    this.queue = operation.catch(() => {})
    return operation
  }
  private encode(input: ConnectionConfig): StoredProfile {
    const c = validateConnection(input)
    // Only encrypted credential material may reach disk.
    const safe: StoredProfile = {
      id: c.id || randomUUID(),
      name: c.name,
      group: c.group,
      favorite: c.favorite,
      connectedColor: c.connectedColor,
      type: c.type,
      host: c.host,
      port: c.port,
      username: c.username,
      database: c.database,
      authSource: c.authSource,
      path: c.path,
      privateKey: c.privateKey,
      sshProfileId: c.sshProfileId,
      tls: c.tls,
    }
    if (this.cipher && (c.password || c.passphrase)) {
      if (!this.cipher.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法保存密码')
      safe.encryptedCredentials = this.cipher
        .encryptString(JSON.stringify({ password: c.password, passphrase: c.passphrase }))
        .toString('base64')
    }
    return safe
  }
  save(input: ConnectionConfig) {
    const safe = this.encode(input)
    return this.update((items) => {
      const duplicate = duplicateConnection(safe, items)
      if (duplicate) throw new Error('连接已存在：' + duplicate.name)
      return items.some((item) => item.id === safe.id)
        ? items.map((item) => (item.id === safe.id ? safe : item))
        : [...items, safe]
    })
  }

  async importProfiles(inputs: ConnectionConfig[]): Promise<{ imported: number; skipped: number }> {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 500)
      throw new Error('请选择 1–500 条连接')
    if (inputs.some((c) => c.password || c.passphrase) && !this.cipher?.isEncryptionAvailable())
      throw new Error('系统凭据加密不可用，无法导入密码')
    const incoming = inputs.map((input) => ({ ...input }))
    let imported = 0
    await this.update((items) => {
      const identities = new Set(items.map(profileIdentity))
      const next = [...items]
      const idMap = new Map<string, string>()
      const accepted: ConnectionConfig[] = []
      for (const input of incoming) {
        const key = profileIdentity(input)
        const existing = items.find((item) => profileIdentity(item) === key)
        if (existing) {
          if (input.id) idMap.set(input.id, existing.id!)
          continue
        }
        if (identities.has(key)) continue
        identities.add(key)
        const profile = { ...input, id: randomUUID() }
        if (input.id) idMap.set(input.id, profile.id)
        accepted.push(profile)
      }
      for (const profile of accepted) {
        if (profile.sshProfileId) {
          const target =
            idMap.get(profile.sshProfileId) ||
            items.find((item) => item.id === profile.sshProfileId && item.type === 'ssh')?.id
          if (
            !target ||
            ![...accepted, ...items].some((item) => item.id === target && item.type === 'ssh')
          )
            throw new Error('SSH 隧道配置缺失，请同时导入关联的 SSH 连接')
          profile.sshProfileId = target
        }
        next.push(this.encode(profile))
        imported++
      }
      return next
    })
    return { imported, skipped: inputs.length - imported }
  }
  setColor(id: string, color: string) {
    if (
      typeof id !== 'string' ||
      typeof color !== 'string' ||
      (color && !/^#[0-9a-f]{6}$/i.test(color))
    )
      throw new Error('请输入六位十六进制颜色')
    return this.update((items) => {
      if (!items.some((item) => item.id === id)) throw new Error('连接不存在')
      return items.map((item) =>
        item.id === id ? { ...item, connectedColor: color || undefined } : item,
      )
    })
  }
  favorite(id: string, value: boolean) {
    if (typeof id !== 'string' || typeof value !== 'boolean') throw new Error('收藏参数无效')
    return this.update((items) => {
      if (!items.some((item) => item.id === id)) throw new Error('连接配置不存在')
      return items.map((item) => (item.id === id ? { ...item, favorite: value } : item))
    })
  }
  reorder(ids: unknown, move?: { id: string; group?: string }) {
    return this.update((items) => {
      if (
        !Array.isArray(ids) ||
        ids.length !== items.length ||
        ids.some((id) => typeof id !== 'string') ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !items.some((item) => item.id === id))
      )
        throw new Error('连接列表已变化，请刷新后重试排序')
      if (
        move !== undefined &&
        (!move ||
          typeof move.id !== 'string' ||
          !ids.includes(move.id) ||
          (move.group !== undefined &&
            (typeof move.group !== 'string' ||
              move.group.length > 100 ||
              /[\0\r\n]/.test(move.group))))
      )
        throw new Error('目标文件夹无效')
      return ids.map((id) => {
        const item = items.find((item) => item.id === id)!
        return move && move.id === id ? { ...item, group: move.group?.trim() || undefined } : item
      })
    })
  }
  remove(id: string) {
    return this.update((items) => items.filter((item) => item.id !== id))
  }
}
