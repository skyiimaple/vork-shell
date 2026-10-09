import type { ConnectionConfig } from './contracts'
export function profileIdentity(c: ConnectionConfig): string {
  const host = c.host?.trim().toLowerCase()
  return JSON.stringify([
    c.type,
    host === 'localhost' || host === '::1' ? '127.0.0.1' : host,
    c.port,
    c.username || '',
    c.database || (c.type === 'redis' ? '0' : ''),
    Boolean(c.tls),
    c.path || '',
    c.sshProfileId || '',
    ...(c.type === 'mongodb' ? [c.authSource || 'admin'] : []),
  ])
}
export function duplicateConnection(config: ConnectionConfig, profiles: ConnectionConfig[]) {
  if (config.type === 'sqlite' && config.path === ':memory:') return undefined
  return profiles.find((p) => p.id !== config.id && profileIdentity(p) === profileIdentity(config))
}
