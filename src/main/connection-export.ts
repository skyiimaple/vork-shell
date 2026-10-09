import type { ConnectionConfig } from '../shared/contracts'
export function exportConnections(profiles: ConnectionConfig[]) {
  return JSON.stringify(
    {
      format: 'vork-shell',
      version: 1,
      connections: profiles.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        host: c.host,
        port: c.port,
        username: c.username,
        database: c.database,
        authSource: c.authSource,
        path: c.path,
        tls: c.tls,
        sshProfileId: c.sshProfileId,
        favorite: c.favorite,
        connectedColor: c.connectedColor,
      })),
    },
    null,
    2,
  )
}
