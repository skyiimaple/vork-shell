export type ConnectionType = 'ssh' | 'sqlite' | 'mysql' | 'postgresql' | 'redis' | 'mongodb'
export type Cell = string | number | boolean | null
export interface ConnectionConfig {
  id?: string
  name: string
  group?: string
  connectedColor?: string
  favorite?: boolean
  type: ConnectionType
  host?: string
  port?: number
  username?: string
  password?: string
  database?: string
  authSource?: string
  path?: string
  privateKey?: string
  passphrase?: string
  sshProfileId?: string
  tls?: boolean
}
export interface Session {
  profileId?: string
  id: string
  name: string
  type: ConnectionType
  target: string
  database?: number
}
export type SqliteToolRequest =
  { kind: 'import'; table: string; csv: string } | { kind: 'dump'; table?: string }
export interface QueryHistoryEntry {
  id: string
  profileId?: string
  identity: string
  name: string
  type: 'sqlite' | 'mysql' | 'postgresql'
  target: string
  sql: string
  timestamp: number
}
export interface SqlBatchResult {
  notice?: string
  results: { index: number; sql: string; result: QueryResult }[]
  error?: string
  failedIndex?: number
  elapsedMs: number
}
export interface QueryResult {
  columns: string[]
  rows: Cell[][]
  affectedRows: number
  elapsedMs: number
  truncated: boolean
}
export interface SessionEvent {
  channelId?: string
  sessionId: string
  type: 'data' | 'closed' | 'error' | 'transfer'
  data: string
}
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string }
export type UpdateAction = 'check' | 'download' | 'install'
export interface UpdateState {
  currentVersion: string
  status:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'latest'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error'
  version?: string
  percent?: number
  error?: string
}
export interface ConnectionImportPreview {
  token: string
  fileName: string
  rows: {
    index: number
    name: string
    host?: string
    port?: number
    hasPassword: boolean
    status: 'ready' | 'duplicate' | 'invalid'
    error?: string
  }[]
}
export type ConnectionDetails = Pick<
  ConnectionConfig,
  | 'name'
  | 'type'
  | 'host'
  | 'port'
  | 'username'
  | 'database'
  | 'authSource'
  | 'path'
  | 'tls'
  | 'sshProfileId'
>
export interface ConnectionProject {
  id: string
  name: string
  connectionIds: string[]
}
export interface ActivityEntry {
  time: string
  level: 'info' | 'error'
  action: string
  connection: string
  message: string
}
export interface DesktopApi {
  onWindowState(callback: (state: { fullscreen: boolean; platform: string }) => void): () => void
  createQuerySession(id: string, database?: string): Promise<Session>
  setConnectionColor(id: string, color: string): Promise<void>
  activityLogs(): Promise<{ path: string; entries: ActivityEntry[] }>
  exportActivityLogs(): Promise<string | null>
  exportConnections(): Promise<string | null>
  openProject(): Promise<void>
  projects(): Promise<ConnectionProject[]>
  createProject(name: string, connectionIds?: string[]): Promise<ConnectionProject>
  updateProject(id: string, name: string, connectionIds: string[]): Promise<void>
  deleteProject(id: string): Promise<void>
  assignConnectionProjects(connectionId: string, projectIds: string[]): Promise<void>
  connectionDetails(id: string): Promise<ConnectionDetails>
  previewConnectionImport(): Promise<ConnectionImportPreview | null>
  confirmConnectionImport(
    token: string,
    indices: number[],
  ): Promise<{ imported: number; skipped: number }>
  cancelConnectionImport(): Promise<void>
  updateState(): Promise<UpdateState>
  updateAction(action: UpdateAction): Promise<UpdateState>
  tableRequest(id: string, request: TableRequest): Promise<TableResponse>
  connect(config: ConnectionConfig): Promise<Session>
  reconnectSession(id: string): Promise<Session>
  favoriteProfile(id: string, value: boolean): Promise<void>
  duplicateSession(id: string): Promise<Session>
  disconnect(id: string): Promise<void>
  executeScript(id: string, sql: string): Promise<SqlBatchResult>
  execute(id: string, command: string): Promise<QueryResult>
  mongoRequest(id: string, request: MongoRequest): Promise<MongoResponse>
  redisRequest(id: string, request: RedisRequest): Promise<RedisResponse>
  sshRequest(id: string, request: SshRequest): Promise<SshResponse>
  sshTransferBatch(
    id: string,
    kind: 'upload' | 'download',
    selection: string | string[],
  ): Promise<SshBatchTransferResult>
  sshTerminalOpen(id: string, preferred?: 'default'): Promise<string>
  sshTerminalClose(id: string, channelId: string): Promise<void>
  sshTransferCancel(id: string): Promise<void>
  sshTransfer(
    id: string,
    kind: 'upload' | 'download',
    remotePath: string,
  ): Promise<SshTransferResult>
  exportResult(id: string, result: QueryResult): Promise<string | null>
  cancel(id: string): Promise<void>
  write(id: string, data: string, channelId?: string): void
  resize(id: string, cols: number, rows: number, channelId?: string): void
  ack(id: string, bytes: number, channelId?: string): void
  onEvent(callback: (event: SessionEvent) => void): () => void
  pickFile(kind: 'sqlite' | 'key'): Promise<string | null>
  reorderProfiles(ids: string[], move?: { id: string; group?: string }): Promise<void>
  queryHistory(): Promise<QueryHistoryEntry[]>
  recordQuery(id: string, sql: string): Promise<void>
  profiles(): Promise<ConnectionConfig[]>
  saveProfile(config: ConnectionConfig): Promise<void>
  deleteProfile(id: string): Promise<void>
}

export type RedisRequest = { database: number } & (
  | {
      kind: 'create'
      key: string
      type: 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream'
      value: string
      member?: string
      score?: string
      seconds?: number
    }
  | { kind: 'delete-batch'; keys: string[] }
  | { kind: 'ttl-batch'; keys: string[] }
  | { kind: 'expire-batch'; keys: string[]; operation: 'expire'; seconds: number }
  | { kind: 'expire-batch'; keys: string[]; operation: 'persist' }
  | {
      kind: 'member'
      collection: 'hash' | 'list' | 'set' | 'zset'
      operation: 'add' | 'update' | 'remove' | 'push-head' | 'push-tail' | 'pop-head' | 'pop-tail'
      key: string
      member?: string
      value?: string
      score?: string
      index?: number
      expected?: string
    }
  | { kind: 'scan'; cursor?: string; match?: string; count?: number; type?: string }
  | { kind: 'read'; key: string; cursor?: string; count?: number }
  | { kind: 'select' }
  | { kind: 'info' }
  | { kind: 'command'; command: string }
  | { kind: 'expire'; key: string; seconds: number }
  | { kind: 'persist' | 'delete'; key: string }
  | { kind: 'rename'; key: string; newKey: string }
  | { kind: 'set-string'; key: string; value: string; expected: string }
)
export interface RedisKeyPage {
  kind: 'scan'
  cursor: string
  keys: string[]
}
export interface RedisKeyDetail {
  kind: 'read'
  key: string
  type: string
  ttl: number
  size: number
  columns: string[]
  rows: Cell[][]
  text?: string
  encoding?: 'text' | 'hex'
  nextCursor: string | null
  truncated: boolean
  binaryMembers?: boolean
}
export interface RedisOverview {
  databaseCount?: number
  kind: 'info'
  keyCount: number
  info: Record<string, string>
  databases: { database: number; keys: number; expires: number; avgTtl: number }[]
}
export interface RedisBulkTtlResult {
  kind: 'ttl-batch'
  results: ({ key: string; ok: true; ttl: number } | { key: string; ok: false; error: string })[]
}
export interface RedisBulkMutationResult {
  kind: 'bulk-mutation'
  results: (
    { key: string; ok: true; affected: number } | { key: string; ok: false; error: string }
  )[]
}
export type RedisResponse =
  | RedisKeyPage
  | RedisKeyDetail
  | RedisOverview
  | RedisBulkTtlResult
  | RedisBulkMutationResult
  | { kind: 'command'; result: QueryResult }
  | { kind: 'mutation'; affected: number; newKey?: string }

export interface Tunnel {
  id: string
  localPort: number
  host: string
  port: number
}
export interface TransferProgress {
  file: string
  direction: 'upload' | 'download'
  bytes: number
  total: number
  state: 'transferring' | 'committing' | 'complete' | 'canceled'
}
export type SshRequest =
  | { kind: 'rename'; path: string; newName: string }
  | { kind: 'delete'; path: string }
  | { kind: 'list' | 'mkdir'; path: string }
  | { kind: 'tunnels' }
  | { kind: 'tunnel-start'; host: string; port: number; localPort: number }
  | { kind: 'tunnel-stop'; id: string }
export interface SshTransferResult {
  kind: 'transfer'
  file: string
  bytes: number
  canceled: boolean
}
export interface SshBatchTransferResult {
  kind: 'batch-transfer'
  canceled: boolean
  results: { name: string; file: string; ok: boolean; bytes: number; error?: string }[]
}
export type SshResponse =
  | {
      kind: 'listing'
      path: string
      entries: {
        name: string
        directory: boolean
        regularFile?: boolean
        size: number
        modified: number
      }[]
      truncated: boolean
    }
  | { kind: 'tunnels'; tunnels: Tunnel[] }
  | { kind: 'done' }

export interface DataTable {
  schema: string
  name: string
}
export interface DataColumn {
  name: string
  type: string
  primaryKey: number
  editable: boolean
}
export type TableRequest =
  | {
      kind: 'browse'
      table: DataTable
      page: number
      pageSize: number
      sort?: { column: string; descending: boolean }
      filter?: {
        column: string
        operator: 'eq' | 'contains' | 'is-null' | 'not-null'
        value?: string
      }
    }
  | { kind: 'edit'; snapshotId: string; rowIndex: number; column: string; value: Cell }
export interface TablePage {
  kind: 'page'
  result: QueryResult
  columns: DataColumn[]
  page: number
  pageSize: number
  hasNext: boolean
  snapshotId?: string
  readOnlyReason?: string
}
export type TableResponse = TablePage | { kind: 'edited'; affectedRows: number }

export type MongoRequest =
  | { kind: 'databases' }
  | { kind: 'info' }
  | { kind: 'collections'; database: string }
  | { kind: 'indexes'; database: string; collection: string }
  | {
      kind: 'find'
      database: string
      collection: string
      filter: string
      sort?: string
      page: number
      pageSize: number
    }
  | { kind: 'insert'; database: string; collection: string; document: string }
  | { kind: 'replace'; snapshotId: string; rowIndex: number; document: string }
  | { kind: 'delete'; snapshotId: string; rowIndex: number }
export interface MongoDocuments {
  kind: 'documents'
  documents: string[]
  snapshotId: string
  page: number
  pageSize: number
  hasNext: boolean
  truncated: boolean
  elapsedMs: number
}
export type MongoResponse =
  | {
      kind: 'databases' | 'collections'
      names: string[]
      truncated: boolean
      defaultDatabase?: string
    }
  | { kind: 'info'; version: string; database: string }
  | { kind: 'indexes'; documents: string[]; truncated: boolean }
  | MongoDocuments
  | { kind: 'mutation'; affected: number }
