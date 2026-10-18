import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiProgress,
  DesktopApi,
  Reply,
  SessionEvent,
  StructureProgress,
} from '../shared/contracts'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: Reply<T> = await ipcRenderer.invoke(channel, ...args)
  if (!result.ok) throw new Error(result.error)
  return result.data
}
const api: DesktopApi = {
  structureSources: () => invoke('vork:structure-sources'),
  compareStructure: (input) => invoke('vork:structure-compare', input),
  cancelStructure: (id) => invoke('vork:structure-cancel', id),
  exportStructure: (id) => invoke('vork:structure-export', id),
  onStructureProgress(callback) {
    const listener = (_: Electron.IpcRendererEvent, value: StructureProgress) => callback(value)
    ipcRenderer.on('vork:structure-progress', listener)
    return () => ipcRenderer.removeListener('vork:structure-progress', listener)
  },
  erRequest: (id, request) => invoke('vork:er-request', id, request),
  exportErSvg: (id, snapshotId, positions, full) =>
    invoke('vork:er-export', id, snapshotId, positions, full),
  queryPlan: (id, sql) => invoke('vork:query-plan', id, sql),
  aiSettings: () => invoke('vork:ai-settings'),
  saveAiSettings: (config) => invoke('vork:ai-save-settings', config),
  aiComplete: (id, request) => invoke('vork:ai-complete', id, request),
  aiCancel: (id) => invoke('vork:ai-cancel', id),
  onAiProgress(callback) {
    const listener = (_: Electron.IpcRendererEvent, value: AiProgress) => callback(value)
    ipcRenderer.on('vork:ai-progress', listener)
    return () => ipcRenderer.removeListener('vork:ai-progress', listener)
  },
  onWindowState(callback) {
    const listener = (
      _: Electron.IpcRendererEvent,
      state: { fullscreen: boolean; platform: string },
    ) => callback(state)
    ipcRenderer.on('vork:window-state', listener)
    return () => {
      ipcRenderer.removeListener('vork:window-state', listener)
    }
  },
  createQuerySession: (id, database) => invoke('vork:query-session', id, database),
  setConnectionColor: (id, color) => invoke('vork:connection-color', id, color),
  activityLogs: () => invoke('vork:activity-logs'),
  exportActivityLogs: () => invoke('vork:export-logs'),
  exportConnections: () => invoke('vork:export-connections'),
  openProject: () => invoke('vork:open-project'),
  projects: () => invoke('vork:projects'),
  createProject: (name, ids) => invoke('vork:create-project', name, ids),
  updateProject: (id, name, ids) => invoke('vork:update-project', id, name, ids),
  deleteProject: (id) => invoke('vork:delete-project', id),
  assignConnectionProjects: (id, ids) => invoke('vork:assign-projects', id, ids),
  connectionDetails: (id) => invoke('vork:connection-details', id),
  previewConnectionImport: () => invoke('vork:import-preview'),
  confirmConnectionImport: (token, indices) => invoke('vork:import-confirm', token, indices),
  cancelConnectionImport: () => invoke('vork:import-cancel'),
  updateState: () => invoke('vork:update-state'),
  updateAction: (action) => invoke('vork:update-action', action),
  schemaRequest: (id, request) => invoke('vork:schema-request', id, request),
  tableRequest: (id, request) => invoke('vork:table-request', id, request),
  reconnectSession: (id) => invoke('vork:reconnect', id),
  favoriteProfile: (id, value) => invoke('vork:favorite-profile', id, value),
  connect: (config) => invoke('vork:connect', config),
  duplicateSession: (id) => invoke('vork:duplicate-session', id),
  disconnect: (id) => invoke('vork:disconnect', id),
  executeScript: (id, sql) => invoke('vork:execute-script', id, sql),
  execute: (id, command) => invoke('vork:execute', id, command),
  mongoRequest: (id, request) => invoke('vork:mongo-request', id, request),
  redisRequest: (id, request) => invoke('vork:redis-request', id, request),
  sshRequest: (id, request) => invoke('vork:ssh-request', id, request),
  sshTransferBatch: (id, kind, selection) => invoke('vork:ssh-transfer-batch', id, kind, selection),
  sshTerminalOpen: (id, preferred) => invoke('vork:ssh-terminal-open', id, preferred),
  sshTerminalClose: (id, channelId) => invoke('vork:ssh-terminal-close', id, channelId),
  sshTransferCancel: (id) => invoke('vork:ssh-transfer-cancel', id),
  sshTransfer: (id, kind, path) => invoke('vork:ssh-transfer', id, kind, path),
  exportResult: (id, result, format, table) =>
    invoke('vork:export-result', id, result, format, table),
  copyText: (text) => invoke('vork:copy-text', text),
  copyResult: (id, result, format, table) => invoke('vork:copy-result', id, result, format, table),
  cancel: (id) => invoke('vork:cancel', id),
  write: (id, data, channelId) => ipcRenderer.send('vork:write', id, data, channelId),
  resize: (id, cols, rows, channelId) => ipcRenderer.send('vork:resize', id, cols, rows, channelId),
  ack: (id, bytes, channelId) => ipcRenderer.send('vork:ack', id, bytes, channelId),
  onEvent(callback) {
    const listener = (_: Electron.IpcRendererEvent, event: SessionEvent) => callback(event)
    ipcRenderer.on('vork:event', listener)
    return () => ipcRenderer.removeListener('vork:event', listener)
  },
  pickFile: (kind) => invoke('vork:pick-file', kind),
  reorderProfiles: (ids, move) => invoke('vork:reorder-profiles', ids, move),
  queryHistory: () => invoke('vork:query-history'),
  recordQuery: (id, sql) => invoke('vork:record-query', id, sql),
  profiles: () => invoke('vork:profiles'),
  saveProfile: (config) => invoke('vork:save-profile', config),
  deleteProfile: (id) => invoke('vork:delete-profile', id),
}
contextBridge.exposeInMainWorld('vork', api)
