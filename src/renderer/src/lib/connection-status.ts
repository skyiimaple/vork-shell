import type { Session } from '../../../shared/contracts'
export function connectionStatuses(
  sessions: Session[],
  closed: Record<string, string>,
  active: string,
) {
  const states = new Map<string, { connected: boolean; active: boolean }>()
  for (const session of sessions) {
    if (!session.profileId || closed[session.id]) continue
    const previous = states.get(session.profileId)
    states.set(session.profileId, {
      connected: true,
      active: Boolean(previous?.active || session.id === active),
    })
  }
  return states
}
