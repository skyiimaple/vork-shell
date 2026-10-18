import type { Session } from '../../../shared/contracts'
export interface QueryDrafts {
  active: string
  tabs: { id: string; name: string; sql: string; database: string }[]
}
export function cleanQueryDrafts(value: unknown): QueryDrafts | undefined {
  if (!value || typeof value !== 'object') return undefined
  const state = value as QueryDrafts
  if (
    !Array.isArray(state.tabs) ||
    !state.tabs.length ||
    state.tabs.length > 20 ||
    typeof state.active !== 'string'
  )
    return undefined
  const ids = new Set<string>()
  for (const tab of state.tabs) {
    if (
      !tab ||
      typeof tab.id !== 'string' ||
      !tab.id ||
      tab.id.length > 200 ||
      ids.has(tab.id) ||
      typeof tab.name !== 'string' ||
      tab.name.length > 100 ||
      typeof tab.sql !== 'string' ||
      tab.sql.length > 65536 ||
      typeof tab.database !== 'string' ||
      tab.database.length > 1024
    )
      return undefined
    ids.add(tab.id)
  }
  if (!ids.has(state.active)) return undefined
  return {
    active: state.active,
    tabs: state.tabs.map(({ id, name, sql, database }) => ({ id, name, sql, database })),
  }
}
export interface WorkspaceTab {
  session: Session
  sql: string
  queries?: QueryDrafts
}
export interface Workspace {
  version: 1
  tabs: WorkspaceTab[]
  active: string
}
export const workspaceKey = 'vork.workspace.v1'
export function encodeWorkspace(tabs: WorkspaceTab[], active: string): string {
  return JSON.stringify({
    version: 1,
    active,
    tabs: tabs.slice(0, 20).map(({ session, sql, queries }) => ({
      session: {
        id: session.id,
        profileId: session.profileId,
        name: session.name,
        type: session.type,
        target: session.target,
        database: typeof session.database === 'number' ? session.database : undefined,
      },
      queries: ['sqlite', 'mysql', 'postgresql'].includes(session.type)
        ? cleanQueryDrafts(
            queries && {
              active: queries.active,
              tabs: queries.tabs
                .slice(0, 20)
                .map((tab) => ({ ...tab, sql: tab.sql.slice(0, 65536) })),
            },
          )
        : undefined,
      sql: ['sqlite', 'mysql', 'postgresql'].includes(session.type) ? sql.slice(0, 65536) : '',
    })),
  })
}
export function decodeWorkspace(text: string | null): Workspace | null {
  if (!text || text.length > 32 * 1024 * 1024) return null
  try {
    const input = JSON.parse(text)
    if (
      input?.version !== 1 ||
      !Array.isArray(input.tabs) ||
      input.tabs.length > 20 ||
      typeof input.active !== 'string'
    )
      return null
    const ids = new Set<string>()
    for (const tab of input.tabs) {
      const s = tab?.session
      if (
        !s ||
        typeof s.id !== 'string' ||
        !s.id ||
        s.id.length > 200 ||
        ids.has(s.id) ||
        typeof s.name !== 'string' ||
        !s.name ||
        s.name.length > 100 ||
        typeof s.target !== 'string' ||
        !s.target ||
        s.target.length > 16384 ||
        !['sqlite', 'mysql', 'postgresql', 'redis', 'ssh', 'mongodb'].includes(s.type) ||
        typeof tab.sql !== 'string' ||
        tab.sql.length > 65536 ||
        (s.profileId !== undefined && (typeof s.profileId !== 'string' || s.profileId.length > 200))
      )
        return null
      if (
        s.database !== undefined &&
        (!Number.isInteger(s.database) || s.database < 0 || s.database > 2147483647)
      )
        return null
      ids.add(s.id)
    }
    return JSON.parse(encodeWorkspace(input.tabs, input.active))
  } catch {
    return null
  }
}
