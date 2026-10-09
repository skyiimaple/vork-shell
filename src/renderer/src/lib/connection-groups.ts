import type { ConnectionConfig, ConnectionType } from '../../../shared/contracts'
const types: { type: ConnectionType; name: string }[] = [
  { type: 'ssh', name: 'SSH' },
  { type: 'sqlite', name: 'SQLite' },
  { type: 'mysql', name: 'MySQL' },
  { type: 'postgresql', name: 'PostgreSQL' },
  { type: 'redis', name: 'Redis' },
  { type: 'mongodb', name: 'MongoDB' },
]
export function groupConnectionsByType(profiles: ConnectionConfig[]) {
  return types.map((group) => ({
    ...group,
    items: profiles.filter((profile) => profile.type === group.type),
  }))
}
