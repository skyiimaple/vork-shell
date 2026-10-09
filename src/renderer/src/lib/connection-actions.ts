import { duplicateConnection } from '../../../shared/connection-identity'
import type { ConnectionConfig, DesktopApi } from '../../../shared/contracts'

export function duplicateProfile(profile: ConnectionConfig): ConnectionConfig {
  const { id: _id, password: _password, passphrase: _passphrase, ...settings } = profile
  return { ...settings, name: `${profile.name} 副本` }
}

export async function testConnection(
  bridge: Pick<DesktopApi, 'connect' | 'disconnect'>,
  config: ConnectionConfig,
): Promise<void> {
  const session = await bridge.connect(config)
  await bridge.disconnect(session.id)
}

export async function connectProfile(
  bridge: Pick<DesktopApi, 'connect' | 'disconnect' | 'saveProfile' | 'profiles'>,
  config: ConnectionConfig,
) {
  const duplicate = duplicateConnection(config, await bridge.profiles())
  if (duplicate) throw new Error('连接已存在：' + duplicate.name)
  const persistent = { ...config, id: config.id || crypto.randomUUID() }
  const session = await bridge.connect(persistent)
  try {
    await bridge.saveProfile(persistent)
  } catch (error) {
    try {
      await bridge.disconnect(session.id)
    } catch {
      /* Preserve the save failure. */
    }
    throw error
  }
  return session
}
