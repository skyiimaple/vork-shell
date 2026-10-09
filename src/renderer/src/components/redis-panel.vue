<script setup lang="ts">
import { notifications } from '@/composables/use-notifications'
import { TreeRow } from '@/components/ui/tree'
import { redisSearchPattern, canContinueRedisScan } from '@/lib/redis-search'
import ConnectionDetails from './connection-details.vue'
import RedisCreateKey from './redis-create-key.vue'
import CodeEditor from './code-editor.vue'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { computed, ref, watch } from 'vue'
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/vue-query'
import { useVirtualizer } from '@tanstack/vue-virtual'
import {
  KeyRound,
  Folder,
  RefreshCw,
  Search,
  Terminal,
  Database,
  LoaderCircle,
  Play,
  Clock3,
  Trash2,
  ArrowLeft,
  ArrowRight,
  Copy,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import ResultTable from './result-table.vue'
import RedisCollectionEditor from './redis-collection-editor.vue'
import { buildKeyTree, flattenKeyTree, type KeyRow } from '@/lib/redis-tree'
import type {
  Session,
  RedisRequest,
  RedisKeyDetail,
  RedisKeyPage,
  RedisOverview,
  QueryResult,
  RedisBulkTtlResult,
  RedisBulkMutationResult,
} from '../../../shared/contracts'

const props = defineProps<{ session: Session; closed: boolean }>()
const client = useQueryClient()
const database = ref(props.session.database || 0),
  dbDraft = ref(String(database.value))
const pattern = ref('*'),
  patternDraft = ref(''),
  typeFilter = ref('all')
const selectedKeys = ref<string[]>([]),
  bulkResult = ref<RedisBulkTtlResult | RedisBulkMutationResult>(),
  bulkRevision = ref(0),
  bulkResultOpen = ref(false)
const bulkAction = ref<'expire' | 'persist' | 'delete' | null>(null),
  bulkSeconds = ref('300')
const bulkSnapshot = ref<{ database: number; keys: string[]; revision: number }>()
const selectedKey = ref<string | null>(null),
  readCursor = ref('0'),
  history = ref<string[]>([]),
  pageSize = ref('200')
const mode = ref<'browser' | 'command'>('browser'),
  expanded = ref(new Set<string>())
const scrollElement = ref<HTMLElement | null>(null),
  notice = ref('')
const keysQuery = useInfiniteQuery({
  queryKey: computed(() => [
    'redis-keys',
    props.session.id,
    database.value,
    pattern.value,
    typeFilter.value,
  ]),
  initialPageParam: '0',
  enabled: computed(() => !props.closed),
  gcTime: 0,
  retry: false,
  queryFn: async ({ pageParam, queryKey }) => {
    const reply = await window.vork.redisRequest(queryKey[1] as string, {
      kind: 'scan',
      database: queryKey[2] as number,
      cursor: pageParam,
      match: queryKey[3] as string,
      type: queryKey[4] === 'all' ? undefined : (queryKey[4] as string),
      count: 200,
    })
    if (reply.kind !== 'scan') throw new Error('键扫描响应无效')
    return reply as RedisKeyPage
  },
  getNextPageParam: (last) => (last.cursor === '0' ? undefined : last.cursor),
})
const infoQuery = useQuery({
  queryKey: computed(() => ['redis-info', props.session.id, database.value]),
  enabled: computed(() => !props.closed),
  gcTime: 0,
  retry: false,
  queryFn: async ({ queryKey }) => {
    const reply = await window.vork.redisRequest(queryKey[1] as string, {
      kind: 'info',
      database: queryKey[2] as number,
    })
    if (reply.kind !== 'info') throw new Error('服务器信息响应无效')
    return reply as RedisOverview
  },
})
const detailQuery = useQuery({
  queryKey: computed(() => [
    'redis-key',
    props.session.id,
    database.value,
    selectedKey.value,
    readCursor.value,
    pageSize.value,
  ]),
  enabled: computed(() => !props.closed && selectedKey.value !== null),
  gcTime: 0,
  retry: false,
  queryFn: async ({ queryKey }) => {
    const reply = await window.vork.redisRequest(queryKey[1] as string, {
      kind: 'read',
      database: queryKey[2] as number,
      key: queryKey[3] as string,
      cursor: queryKey[4] as string,
      count: Number(queryKey[5]),
    })
    if (reply.kind !== 'read') throw new Error('键详情响应无效')
    return reply as RedisKeyDetail
  },
})
const selectedTtlQuery = useQuery({
  queryKey: computed(() => [
    'redis-selected-ttl',
    props.session.id,
    database.value,
    ...selectedKeys.value,
  ]),
  enabled: computed(() => !props.closed && selectedKeys.value.length > 0 && !bulkAction.value),
  retry: false,
  gcTime: 0,
  refetchInterval: 5000,
  queryFn: async ({ queryKey }) => {
    const reply = await window.vork.redisRequest(String(queryKey[1]), {
      kind: 'ttl-batch',
      database: Number(queryKey[2]),
      keys: queryKey.slice(3).map(String),
    })
    if (reply.kind !== 'ttl-batch') throw new Error('TTL 响应无效')
    return reply
  },
})
function removeExpired(reply: RedisBulkTtlResult) {
  const expired = new Set(
    reply.results.filter((item) => item.ok && item.ttl === -2).map((item) => item.key),
  )
  if (!expired.size) return
  setSelectedKeys(selectedKeys.value.filter((key) => !expired.has(key)))
  if (selectedKey.value !== null && expired.has(selectedKey.value)) selectedKey.value = null
  void client.invalidateQueries({ queryKey: ['redis-keys', props.session.id, database.value] })
}
watch(selectedTtlQuery.data, (reply) => {
  if (reply) removeExpired(reply)
})
const validatingBulk = ref(false)
const keys = computed(() => [
  ...new Set(keysQuery.data.value?.pages.flatMap((page) => page.keys) || []),
])
const autoScans = ref(0)
watch([keysQuery.data, keysQuery.isFetching, () => props.closed], () => {
  if (
    canContinueRedisScan({
      closed: Boolean(props.closed),
      keys: keys.value.length,
      hasNext: Boolean(keysQuery.hasNextPage.value),
      fetching: keysQuery.isFetching.value,
      error: keysQuery.isError.value || keysQuery.isFetchNextPageError.value,
      attempts: autoScans.value,
    })
  ) {
    autoScans.value++
    void keysQuery.fetchNextPage()
  }
})
watch([database, pattern, typeFilter], () => {
  autoScans.value = 0
})
const dbSelection = computed({
  get: () => String(database.value),
  set: (value: string) => {
    if (value === 'custom') {
      notice.value = ''
      customDbOpen.value = true
      return
    }
    dbDraft.value = value
    applyDatabase()
  },
})
const customDbOpen = ref(false),
  switchingDatabase = ref(false)
const databaseOptions = computed(() => {
  const count = infoQuery.data.value?.databaseCount
  const indexes = new Set(Array.from({ length: Math.min(count || 16, 64) }, (_, i) => i))
  indexes.add(database.value)
  for (const item of infoQuery.data.value?.databases || []) indexes.add(item.database)
  return [...indexes]
    .sort((a, b) => a - b)
    .map((value) => ({
      value,
      keys: infoQuery.data.value?.databases.find((item) => item.database === value)?.keys || 0,
    }))
})
const tree = computed(() => buildKeyTree(keys.value))
const keyRows = computed(() => flattenKeyTree(tree.value, expanded.value))
const virtualizer = useVirtualizer(
  computed(() => ({
    count: keyRows.value.length,
    getScrollElement: () => scrollElement.value,
    estimateSize: () => 32,
    overscan: 10,
  })),
)
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const detail = computed(() => detailQuery.data.value)
const tableResult = computed<QueryResult>(() => ({
  columns: detail.value?.columns || [],
  rows: detail.value?.rows || [],
  affectedRows: 0,
  elapsedMs: 0,
  truncated: false,
}))
const keyDraft = ref(''),
  ttlDraft = ref('')
watch([selectedKey, detail], () => {
  keyDraft.value = selectedKey.value ?? ''
  ttlDraft.value = detail.value ? String(detail.value.ttl) : ''
})
function saveKeyName() {
  if (
    props.closed ||
    !detail.value ||
    detail.value.type === 'none' ||
    mutation.isPending.value ||
    selectedKey.value === null ||
    keyDraft.value === selectedKey.value
  )
    return
  mutation.mutate({
    kind: 'rename',
    database: database.value,
    key: selectedKey.value,
    newKey: keyDraft.value,
  })
}
function saveTtl() {
  if (
    props.closed ||
    !detail.value ||
    detail.value.type === 'none' ||
    mutation.isPending.value ||
    selectedKey.value === null ||
    ttlDraft.value === String(detail.value.ttl)
  )
    return
  if (
    !/^-?\d+$/.test(ttlDraft.value) ||
    !Number.isSafeInteger(Number(ttlDraft.value)) ||
    (Number(ttlDraft.value) <= 0 && Number(ttlDraft.value) !== -1)
  ) {
    notice.value = 'TTL 请输入正整数秒数或 -1，按 Enter 保存'
    return
  }
  mutation.mutate(
    Number(ttlDraft.value) === -1
      ? { kind: 'persist', database: database.value, key: selectedKey.value }
      : {
          kind: 'expire',
          database: database.value,
          key: selectedKey.value,
          seconds: Number(ttlDraft.value),
        },
  )
}
const displayMode = ref<'text' | 'json'>('text'),
  editedValue = ref(''),
  editing = ref(false)
const formattedValue = computed(() => {
  if (displayMode.value === 'json' && detail.value?.text !== undefined) {
    try {
      return JSON.stringify(JSON.parse(detail.value.text), null, 2)
    } catch {
      return '当前值不是有效 JSON。切回文本查看原值。'
    }
  }
  return detail.value?.text || ''
})
watch(detail, (value) => {
  editedValue.value = value?.text || ''
  editing.value = false
})
watch([database, pattern, typeFilter], () => {
  setSelectedKeys([])
})
watch(
  () => props.closed,
  (closed) => {
    if (closed) {
      setSelectedKeys([])
      selectedKey.value = null
      editing.value = false
      bulkAction.value = null
    }
  },
)
watch(database, () => {
  selectedKey.value = null
  history.value = []
  readCursor.value = '0'
  expanded.value = new Set()
  commandResult.value = undefined
  commandError.value = ''
})
watch(selectedKey, () => {
  history.value = []
  readCursor.value = '0'
  displayMode.value = 'text'
  editing.value = false
})
function toggle(node: KeyRow) {
  const next = new Set(expanded.value)
  if (next.has(node.id)) next.delete(node.id)
  else next.add(node.id)
  expanded.value = next
}
function choose(node: KeyRow) {
  if (node.key !== undefined) {
    selectedKey.value = node.key
    mode.value = 'browser'
  } else toggle(node)
}
function search() {
  const next = redisSearchPattern(patternDraft.value)
  autoScans.value = 0
  if (next === pattern.value) void keysQuery.refetch()
  pattern.value = next
  selectedKey.value = null
  expanded.value = new Set()
}
async function selectCustomDatabase() {
  await applyDatabase()
  if (!notice.value) customDbOpen.value = false
}
async function applyDatabase() {
  const value = Number(dbDraft.value)
  if (!/^\d+$/.test(dbDraft.value) || !Number.isInteger(value) || value > 2147483647) {
    notice.value = '数据库编号必须为非负整数'
    return
  }
  if (switchingDatabase.value || props.closed) return
  switchingDatabase.value = true
  try {
    await window.vork.redisRequest(props.session.id, { kind: 'select', database: value })
    database.value = value
    notice.value = ''
  } catch (error) {
    notice.value = error instanceof Error ? error.message : '数据库切换失败'
  } finally {
    switchingDatabase.value = false
  }
}
watch(pageSize, () => {
  history.value = []
  readCursor.value = '0'
})
async function createdKey(key: string, db: number) {
  if (db !== database.value) return
  patternDraft.value = pattern.value = '*'
  typeFilter.value = 'all'
  selectedKey.value = key
  notice.value = ''
  notifications.notify('创建成功')
  await refresh()
}
function nextPage() {
  if (!detailQuery.isFetching.value && detail.value?.nextCursor) {
    history.value.push(readCursor.value)
    readCursor.value = detail.value.nextCursor
  }
}
function previousPage() {
  if (detailQuery.isFetching.value) return
  readCursor.value = history.value.pop() || '0'
}
async function refresh() {
  history.value = []
  readCursor.value = '0'
  await Promise.all([
    client.invalidateQueries({ queryKey: ['redis-keys', props.session.id, database.value] }),
    client.invalidateQueries({ queryKey: ['redis-key', props.session.id, database.value] }),
    client.invalidateQueries({ queryKey: ['redis-info', props.session.id, database.value] }),
  ])
}
async function copyValue() {
  try {
    await navigator.clipboard.writeText(detail.value?.text || '')
    notice.value = '已复制当前预览值'
  } catch {
    notice.value = '无法访问剪贴板'
  }
}

type BulkRequest = Extract<RedisRequest, { kind: 'ttl-batch' | 'expire-batch' | 'delete-batch' }>
const bulkMutation = useMutation({
  mutationFn: ({ request }: { request: BulkRequest; revision: number }) =>
    window.vork.redisRequest(props.session.id, request),
  retry: false,
  gcTime: 0,
  async onSuccess(reply, { request, revision }) {
    if (reply.kind !== 'ttl-batch' && reply.kind !== 'bulk-mutation') return
    if (request.database !== database.value || revision !== bulkRevision.value) return
    bulkResult.value = reply
    bulkResultOpen.value = reply.kind === 'ttl-batch' || reply.results.some((item) => !item.ok)
    bulkAction.value = null
    if (reply.kind === 'bulk-mutation') {
      notice.value = `批量${request.kind === 'delete-batch' ? '删除' : 'TTL'}完成：${reply.results.filter((result) => result.ok && result.affected > 0).length} 已修改，${reply.results.filter((result) => result.ok && result.affected === 0).length} 无需修改或键不存在，${reply.results.filter((result) => !result.ok).length} 失败`
      if (request.kind === 'delete-batch') {
        const deleted = new Set(reply.results.filter((item) => item.ok).map((item) => item.key))
        selectedKeys.value = selectedKeys.value.filter((key) => !deleted.has(key))
        if (selectedKey.value !== null && deleted.has(selectedKey.value)) selectedKey.value = null
      }
      await refresh()
    }
  },
  onError(error, { request, revision }) {
    if (request.database === database.value && revision === bulkRevision.value)
      notice.value = error.message
  },
})
function setSelectedKeys(keys: string[]) {
  selectedKeys.value = keys
  bulkRevision.value++
  bulkResult.value = undefined
  bulkAction.value = null
}
function toggleSelected(key: string, checked: unknown) {
  if (checked === true && selectedKeys.value.length < 100 && !selectedKeys.value.includes(key))
    setSelectedKeys([...selectedKeys.value, key])
  else if (checked !== true) setSelectedKeys(selectedKeys.value.filter((value) => value !== key))
}
function selectLoaded(checked: unknown) {
  setSelectedKeys(checked === true ? keys.value.slice(0, 100) : [])
}
function readBulkTtl() {
  if (!props.closed && !bulkMutation.isPending.value && selectedKeys.value.length) {
    notice.value = ''
    bulkMutation.mutate({
      request: { kind: 'ttl-batch', database: database.value, keys: [...selectedKeys.value] },
      revision: bulkRevision.value,
    })
  }
}
async function openBulk(operation: 'expire' | 'persist' | 'delete') {
  if (props.closed || bulkMutation.isPending.value || !selectedKeys.value.length) return
  if (validatingBulk.value) return
  validatingBulk.value = true
  const db = database.value,
    revision = bulkRevision.value
  try {
    const reply = await window.vork.redisRequest(props.session.id, {
      kind: 'ttl-batch',
      database: db,
      keys: [...selectedKeys.value],
    })
    if (db !== database.value || revision !== bulkRevision.value || props.closed) return
    if (reply.kind !== 'ttl-batch') throw new Error('TTL 响应无效')
    if (reply.results.some((item) => !item.ok)) throw new Error('部分键状态检查失败，请刷新后重试')
    removeExpired(reply)
    if (!selectedKeys.value.length) {
      notifications.notify('已选键已过期或不存在')
      return
    }
    bulkSnapshot.value = {
      database: database.value,
      keys: [...selectedKeys.value],
      revision: bulkRevision.value,
    }
    bulkAction.value = operation
    bulkSeconds.value = '300'
    notice.value = ''
  } catch (error) {
    notifications.notify((error as Error).message, 'error')
  } finally {
    validatingBulk.value = false
  }
}
function submitBulk() {
  const snapshot = bulkSnapshot.value,
    operation = bulkAction.value
  if (
    !snapshot ||
    !operation ||
    props.closed ||
    bulkMutation.isPending.value ||
    snapshot.revision !== bulkRevision.value
  )
    return
  const seconds = Number(bulkSeconds.value)
  if (
    operation === 'expire' &&
    (!/^\d+$/.test(bulkSeconds.value) || !Number.isSafeInteger(seconds) || seconds <= 0)
  ) {
    notice.value = 'TTL 必须为安全范围内的正整数秒数'
    return
  }
  const request: BulkRequest =
    operation === 'delete'
      ? { kind: 'delete-batch', database: snapshot.database, keys: [...snapshot.keys] }
      : operation === 'expire'
        ? {
            kind: 'expire-batch',
            operation,
            database: snapshot.database,
            keys: [...snapshot.keys],
            seconds,
          }
        : { kind: 'expire-batch', operation, database: snapshot.database, keys: [...snapshot.keys] }
  bulkMutation.mutate({ request, revision: snapshot.revision })
}
function bulkOutcome(
  result: RedisBulkTtlResult['results'][number] | RedisBulkMutationResult['results'][number],
) {
  if (!result.ok) return result.error
  if ('ttl' in result)
    return result.ttl === -2 ? '已失效 (-2)' : result.ttl === -1 ? '永久 (-1)' : `${result.ttl} 秒`
  return result.affected > 0 ? '修改完成' : '无需修改或键不存在'
}
const action = ref<'rename' | 'expire' | 'delete' | 'set-string' | null>(null),
  actionKey = ref(''),
  actionDb = ref(0)
const renameValue = ref(''),
  expireValue = ref('300')
function openAction(kind: NonNullable<typeof action.value>) {
  if (selectedKey.value === null || !detail.value || props.closed) return
  actionKey.value = selectedKey.value
  actionDb.value = database.value
  action.value = kind
  notice.value = ''
  renameValue.value = selectedKey.value
  expireValue.value = String(detail.value.ttl > 0 ? detail.value.ttl : 300)
}
const mutation = useMutation({
  mutationFn: (request: RedisRequest) => window.vork.redisRequest(props.session.id, request),
  retry: false,
  gcTime: 0,
  async onSuccess(reply, request) {
    action.value = null
    notice.value =
      reply.kind === 'mutation' && reply.affected === 0 ? '键不存在或无需修改' : '操作完成'
    if (request.database !== database.value) return
    if (request.kind === 'rename') selectedKey.value = request.newKey
    if (request.kind === 'delete') selectedKey.value = null
    await refresh()
  },
  onError(error) {
    notice.value = error.message
  },
})
function submitAction() {
  const base = { database: actionDb.value, key: actionKey.value }
  if (action.value === 'rename')
    mutation.mutate({ ...base, kind: 'rename', newKey: renameValue.value })
  if (action.value === 'expire')
    mutation.mutate({ ...base, kind: 'expire', seconds: Number(expireValue.value) })
  if (action.value === 'delete') mutation.mutate({ ...base, kind: 'delete' })
  if (action.value === 'set-string' && detail.value?.text !== undefined)
    mutation.mutate({
      ...base,
      kind: 'set-string',
      expected: detail.value.text,
      value: editedValue.value,
    })
}
const command = ref('PING'),
  commandResult = ref<QueryResult>(),
  commandError = ref('')
const commandMutation = useMutation({
  mutationFn: async () => {
    const db = database.value
    const reply = await window.vork.redisRequest(props.session.id, {
      kind: 'command',
      database: db,
      command: command.value,
    })
    return { db, reply }
  },
  retry: false,
  gcTime: 0,
  async onSuccess({ db, reply }) {
    if (db !== database.value || reply.kind !== 'command') return
    commandResult.value = reply.result
    commandError.value = ''
    await refresh()
  },
  onError(error) {
    commandError.value = error.message
  },
})
function run() {
  if (!props.closed && !commandMutation.isPending.value && command.value.trim()) {
    commandError.value = ''
    commandMutation.mutate()
  }
}
async function cancel() {
  try {
    await window.vork.cancel(props.session.id)
  } catch (error) {
    notice.value = (error as Error).message
  }
}
function startStringEdit() {
  editing.value = true
  displayMode.value = 'text'
}
</script>

<template>
  <div
    v-if="closed"
    class="text-muted-foreground flex h-full flex-col items-center justify-center gap-3"
    role="status"
  >
    <p class="text-base font-medium">未连接</p>
    <p class="text-sm">点击上方「重新连接」后查看数据库和键列表。</p>
  </div>
  <div v-else class="flex h-full min-h-0 flex-col">
    <div class="flex h-12 shrink-0 items-center justify-between border-b px-4">
      <div class="flex items-center gap-2">
        <Database :size="14" class="text-primary" /><span class="text-muted-foreground text-xs"
          >数据库</span
        ><Select v-model="dbSelection" :disabled="closed"
          ><select-trigger aria-label="Redis 数据库切换" class="h-7 w-40 text-xs"
            ><select-value /></select-trigger
          ><select-content
            ><select-item v-for="db in databaseOptions" :key="db.value" :value="String(db.value)"
              >db{{ db.value }} · {{ db.keys }} 个键</select-item
            ><select-item value="custom">其他数据库…</select-item></select-content
          ></Select
        >
        <span class="text-muted-foreground ml-2 hidden text-[11px] xl:inline"
          >{{ infoQuery.data.value?.keyCount ?? '…' }} 个键<span
            v-if="infoQuery.data.value"
            class="ml-3"
            >Redis {{ infoQuery.data.value.info.redis_version }} ·
            {{ infoQuery.data.value.info.used_memory_human }}</span
          ></span
        >
      </div>
      <div class="flex items-center gap-1">
        <connection-details :session="session" :database="database" :closed="closed" />
        <redis-create-key
          :session-id="session.id"
          :database="database"
          :closed="closed"
          @created="createdKey"
        /><Button
          variant="ghost"
          size="xs"
          :disabled="closed || keysQuery.isFetching.value"
          @click="refresh"
          ><refresh-cw :size="13" />刷新</Button
        ><Button
          variant="ghost"
          class="h-auto whitespace-normal shadow-none"
          :class="[
            'rounded px-3 py-1.5 text-xs',
            mode === 'browser' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
          ]"
          @click="mode = 'browser'"
          >键浏览</Button
        ><Button
          variant="ghost"
          class="h-auto whitespace-normal shadow-none"
          :class="[
            'flex items-center gap-1 rounded px-3 py-1.5 text-xs',
            mode === 'command' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
          ]"
          @click="mode = 'command'"
          ><terminal :size="13" />命令控制台</Button
        >
      </div>
    </div>
    <alert
      v-if="notice"
      role="status"
      class="bg-accent/40 flex shrink-0 items-center justify-between border-b px-4 py-2 text-xs"
      ><alert-description class="break-all">{{ notice }}</alert-description
      ><Button
        variant="ghost"
        class="text-muted-foreground ml-3 h-auto whitespace-normal shadow-none"
        @click="notice = ''"
        >关闭</Button
      ></alert
    >
    <div v-show="mode === 'browser'" class="flex min-h-0 flex-1">
      <aside class="bg-sidebar/40 flex w-[270px] shrink-0 flex-col border-r">
        <form class="space-y-2 border-b p-3" @submit.prevent="search">
          <div class="flex items-center gap-2">
            <Input
              v-model="patternDraft"
              aria-label="Redis 键匹配模式"
              placeholder="搜索键名，支持包含匹配或 user:*"
              class="h-8 font-mono text-xs"
            /><Button
              type="submit"
              variant="outline"
              size="icon"
              class="size-8 shrink-0"
              :disabled="closed"
              aria-label="搜索 Redis 键"
              ><Search :size="13"
            /></Button>
          </div>
          <Select v-model="typeFilter" :disabled="closed"
            ><select-trigger aria-label="Redis 键类型筛选" class="h-7 w-full text-xs"
              ><select-value /></select-trigger
            ><select-content
              ><select-item value="all">全部类型</select-item
              ><select-item
                v-for="type in ['string', 'hash', 'list', 'set', 'zset', 'stream']"
                :key="type"
                :value="type"
                >{{ type }}</select-item
              ></select-content
            ></Select
          >
        </form>
        <div class="space-y-2 border-b px-3 py-2">
          <div class="flex items-center justify-between">
            <Label class="flex items-center gap-2 text-xs"
              ><checkbox
                :model-value="
                  keys.length > 0 && keys.slice(0, 100).every((key) => selectedKeys.includes(key))
                "
                :disabled="closed || bulkMutation.isPending.value || !keys.length"
                aria-label="选择已加载的前 100 个 Redis 键"
                @update:model-value="selectLoaded"
              />已选 {{ selectedKeys.length }} / 100</Label
            ><Button
              variant="ghost"
              size="xs"
              :disabled="!selectedKeys.length || bulkMutation.isPending.value"
              @click="setSelectedKeys([])"
              >清空</Button
            >
          </div>
          <div class="flex flex-wrap gap-1">
            <Button
              variant="outline"
              size="xs"
              :disabled="
                closed || validatingBulk || bulkMutation.isPending.value || !selectedKeys.length
              "
              @click="readBulkTtl"
              >查看 TTL</Button
            ><Button
              variant="outline"
              size="xs"
              :disabled="
                closed || validatingBulk || bulkMutation.isPending.value || !selectedKeys.length
              "
              @click="openBulk('expire')"
              >设置 TTL</Button
            ><Button
              variant="outline"
              size="xs"
              :disabled="
                closed || validatingBulk || bulkMutation.isPending.value || !selectedKeys.length
              "
              @click="openBulk('persist')"
              >永久保留</Button
            >
            <Button
              variant="outline"
              size="xs"
              class="text-destructive hover:text-destructive"
              :disabled="
                closed || validatingBulk || bulkMutation.isPending.value || !selectedKeys.length
              "
              @click="openBulk('delete')"
              ><trash2 :size="12" />删除已选</Button
            >
          </div>
          <p v-if="bulkMutation.isPending.value" class="text-muted-foreground text-[10px]">
            批量处理中…
          </p>
        </div>
        <div
          class="text-muted-foreground flex h-9 shrink-0 items-center justify-between px-4 text-[10px]"
        >
          <span>KEY NAMESPACE</span><span>{{ keys.length }} 已加载</span>
        </div>
        <div ref="scrollElement" class="scroll-area relative min-h-0 flex-1 overflow-auto">
          <p
            v-if="keysQuery.error.value"
            role="alert"
            class="text-destructive p-4 text-xs break-all"
          >
            {{ keysQuery.error.value.message }}
          </p>
          <div
            v-if="keysQuery.isPending.value"
            class="text-muted-foreground flex items-center justify-center gap-2 p-8 text-xs"
          >
            <loader-circle :size="14" class="animate-spin" />加载键列表…
          </div>
          <p
            v-if="!keysQuery.isPending.value && !keys.length && !keysQuery.error.value"
            class="text-muted-foreground p-8 text-center text-xs leading-6"
          >
            {{ keysQuery.hasNextPage.value ? '本批没有匹配项，可继续扫描。' : '没有匹配的键。' }}
          </p>
          <div class="relative" :style="{ height: `${virtualizer.getTotalSize()}px` }">
            <div
              v-for="item in virtualRows"
              :key="item.key.toString()"
              class="absolute right-0 left-0 flex h-8 items-center pr-3 text-xs"
              :style="{
                transform: `translateY(${item.start}px)`,
              }"
            >
              <tree-row
                class="w-full"
                :depth="keyRows[item.index]!.depth"
                :label="keyRows[item.index]!.label"
                :title="keyRows[item.index]!.key ?? keyRows[item.index]!.label"
                :expandable="Boolean(keyRows[item.index]!.children.length)"
                :expanded="expanded.has(keyRows[item.index]!.id)"
                :selected="
                  keyRows[item.index]!.key !== undefined && selectedKey === keyRows[item.index]!.key
                "
                :disabled="closed"
                @toggle="toggle(keyRows[item.index]!)"
                @activate="choose(keyRows[item.index]!)"
              >
                <template #icon
                  ><key-round
                    v-if="keyRows[item.index]!.key !== undefined"
                    :size="13"
                    class="shrink-0" /><folder v-else :size="13" class="shrink-0"
                /></template>
                <template #actions>
                  <checkbox
                    v-if="keyRows[item.index]!.key !== undefined"
                    class="mr-1 shrink-0"
                    :model-value="selectedKeys.includes(keyRows[item.index]!.key!)"
                    :aria-label="`选择 Redis 键 ${keyRows[item.index]!.key || '(空键名)'}`"
                    :disabled="
                      closed ||
                      bulkMutation.isPending.value ||
                      (!selectedKeys.includes(keyRows[item.index]!.key!) &&
                        selectedKeys.length >= 100)
                    "
                    @update:model-value="
                      (checked) => toggleSelected(keyRows[item.index]!.key!, checked)
                    "
                /></template>
              </tree-row>
            </div>
          </div>
        </div>
        <div class="border-t p-3">
          <Button
            variant="outline"
            size="sm"
            class="w-full text-xs"
            :disabled="
              closed ||
              !keysQuery.hasNextPage.value ||
              keysQuery.isFetching.value ||
              keys.length >= 10000
            "
            @click="keysQuery.fetchNextPage()"
            ><loader-circle v-if="keysQuery.isFetching.value" :size="13" class="animate-spin" />{{
              keys.length >= 10000
                ? '已达浏览上限，请缩小匹配范围'
                : keysQuery.hasNextPage.value
                  ? '继续扫描'
                  : '扫描完成'
            }}</Button
          >
        </div>
      </aside>
      <section class="flex min-w-0 flex-1 flex-col">
        <div
          v-if="selectedKey === null"
          class="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3"
        >
          <div class="bg-card rounded-xl border p-4">
            <key-round :size="25" :stroke-width="1.3" />
          </div>
          <p class="text-sm">选择一个键，查看它的内容</p>
          <p class="max-w-[320px] text-center text-xs leading-6">
            按命名空间展开左侧键树。大集合分批读取，命令控制台可执行更多操作。
          </p>
        </div>
        <template v-else>
          <div class="flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3">
            <div class="min-w-0 flex-1">
              <div class="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-2">
                <badge
                  v-if="detail"
                  variant="secondary"
                  class="bg-primary/10 text-primary w-fit font-mono text-[10px] uppercase"
                  >{{ detail.type }}</badge
                >
                <Input
                  v-model="keyDraft"
                  aria-label="Redis 键名"
                  title="Enter 保存键名，Esc 恢复"
                  class="h-8 min-w-0 flex-1 font-mono text-sm"
                  :disabled="
                    closed || !detail || detail.type === 'none' || mutation.isPending.value
                  "
                  @keydown.enter.prevent="saveKeyName"
                  @keydown.esc.prevent="keyDraft = selectedKey ?? ''"
                />
                <div class="flex shrink-0 items-center gap-1">
                  <redis-collection-editor
                    v-if="detail && ['hash', 'list', 'set', 'zset'].includes(detail.type)"
                    :session-id="session.id"
                    :database="database"
                    :detail="detail"
                    :closed="closed"
                    @changed="refresh"
                  /><Button
                    variant="ghost"
                    size="icon"
                    class="text-destructive size-7"
                    :disabled="closed || !detail || detail.type === 'none'"
                    aria-label="删除 Redis 键"
                    @click="openAction('delete')"
                    ><trash2 :size="13"
                  /></Button>
                </div>
              </div>
              <div
                class="text-muted-foreground mt-2 grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 text-[11px]"
              >
                <span class="flex items-center gap-1"><clock3 :size="11" />TTL</span>
                <div class="flex flex-wrap items-center gap-3">
                  <span class="flex items-center gap-1"
                    ><Input
                      v-model="ttlDraft"
                      aria-label="Redis 键 TTL 秒数"
                      title="TTL 秒数，Enter 保存，-1 不过期"
                      class="h-7 w-24 font-mono text-xs"
                      :disabled="
                        closed || !detail || detail.type === 'none' || mutation.isPending.value
                      "
                      @keydown.enter.prevent="saveTtl"
                      @keydown.esc.prevent="ttlDraft = detail ? String(detail.ttl) : ''"
                    /><span>秒</span></span
                  ><span v-if="detail"
                    >{{ detail.size }} {{ detail.type === 'string' ? 'bytes' : 'items' }}</span
                  ><span>db{{ database }}</span>
                </div>
              </div>
            </div>
          </div>
          <p
            v-if="detailQuery.error.value"
            role="alert"
            class="bg-destructive/10 text-destructive m-5 rounded p-4 text-xs break-all"
          >
            {{ detailQuery.error.value.message }}
          </p>
          <div
            v-if="detailQuery.isFetching.value"
            class="text-muted-foreground flex items-center gap-2 p-5 text-xs"
          >
            <loader-circle :size="14" class="animate-spin" />读取键值…
          </div>
          <div v-else-if="detail?.type === 'none'" class="text-muted-foreground p-8 text-sm">
            键已过期或被其他客户端删除。请刷新列表。
          </div>
          <template v-else-if="detail?.type === 'string'">
            <div class="flex h-11 shrink-0 items-center justify-between border-b px-5">
              <div class="flex gap-2">
                <Button
                  variant="ghost"
                  class="h-auto whitespace-normal shadow-none"
                  :class="[
                    'text-xs',
                    displayMode === 'text' ? 'text-primary' : 'text-muted-foreground',
                  ]"
                  @click="displayMode = 'text'"
                  >{{ detail.encoding === 'hex' ? 'HEX' : 'TEXT' }}</Button
                ><Button
                  v-if="detail.encoding === 'text'"
                  variant="ghost"
                  class="h-auto whitespace-normal shadow-none"
                  :class="[
                    'text-xs',
                    displayMode === 'json' ? 'text-primary' : 'text-muted-foreground',
                  ]"
                  @click="displayMode = 'json'"
                  >JSON</Button
                ><span v-if="detail.truncated" class="text-muted-foreground text-[11px]"
                  >仅预览前 64 KiB，不能直接保存</span
                >
              </div>
              <div class="flex gap-2">
                <Button
                  size="icon"
                  variant="ghost"
                  class="size-7"
                  aria-label="复制 Redis 值"
                  @click="copyValue"
                  ><Copy :size="13" /></Button
                ><Button
                  v-if="editing"
                  size="xs"
                  :disabled="closed || mutation.isPending.value"
                  @click="openAction('set-string')"
                  >保存修改</Button
                ><Button
                  v-else
                  size="xs"
                  variant="outline"
                  :disabled="closed || detail.truncated || detail.encoding !== 'text'"
                  @click="startStringEdit()"
                  >编辑值</Button
                >
              </div>
            </div>
            <Textarea
              v-if="editing"
              v-model="editedValue"
              aria-label="编辑 Redis 字符串"
              spellcheck="false"
              class="scroll-area bg-editor min-h-0 w-full flex-1 resize-none rounded-none border-0 p-5 font-mono text-xs leading-6 shadow-none outline-none focus-visible:ring-0"
            />
            <code-editor
              v-else-if="displayMode === 'json' && detail.encoding === 'text'"
              :model-value="formattedValue"
              language="json"
              label="Redis JSON 预览"
              disabled
              class="min-h-0 flex-1"
            />
            <pre
              v-else
              class="scroll-area bg-editor min-h-0 flex-1 overflow-auto p-5 font-mono text-xs leading-6 break-all whitespace-pre-wrap"
              >{{ formattedValue }}</pre>
          </template>
          <template v-else-if="detail"
            ><p v-if="detail.binaryMembers" class="text-muted-foreground border-b p-3 text-xs">
              本批含二进制成员，显示为 HEX；集合编辑已禁用，请使用 redis-cli。
            </p>
            <div class="min-h-0 flex-1"><result-table :result="tableResult" /></div>
            <div
              class="text-muted-foreground flex h-11 shrink-0 items-center justify-between border-t px-5 text-xs"
            >
              <div class="flex items-center gap-3">
                <span
                  >第 {{ history.length + 1 }} 批 · {{ detail.rows.length }} 项 / 共
                  {{ detail.size }} 项</span
                ><Select v-model="pageSize" :disabled="closed || detailQuery.isFetching.value"
                  ><select-trigger aria-label="Redis 集合每批数量" class="h-7 w-28 text-xs"
                    ><select-value /></select-trigger
                  ><select-content
                    ><select-item v-for="size in [50, 200, 500]" :key="size" :value="String(size)"
                      >{{ size }} 项 / 批</select-item
                    ></select-content
                  ></Select
                >
              </div>
              <div class="flex gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  :disabled="closed || detailQuery.isFetching.value || !history.length"
                  @click="previousPage"
                  ><arrow-left :size="12" />上一批</Button
                ><Button
                  variant="outline"
                  size="xs"
                  :disabled="closed || detailQuery.isFetching.value || !detail.nextCursor"
                  @click="nextPage"
                  >下一批<arrow-right :size="12"
                /></Button>
              </div></div
          ></template>
        </template>
      </section>
    </div>
    <div v-show="mode === 'command'" class="flex min-h-0 flex-1 flex-col">
      <div class="flex h-11 shrink-0 items-center justify-between border-b px-5">
        <span class="text-muted-foreground text-xs"
          >Redis 命令 · db{{ database }} · 每次执行一条，不自动重试</span
        >
        <div class="flex gap-2">
          <Button v-if="commandMutation.isPending.value" variant="outline" size="xs" @click="cancel"
            >停止并断开</Button
          ><Button
            size="xs"
            :disabled="closed || commandMutation.isPending.value || !command.trim()"
            @click="run"
            ><play :size="12" />{{
              commandMutation.isPending.value ? '执行中…' : '执行命令'
            }}</Button
          >
        </div>
      </div>
      <code-editor
        v-model="command"
        language="redis"
        label="Redis 命令"
        :disabled="closed || commandMutation.isPending.value"
        class="h-40 shrink-0"
        @execute="run"
      />
      <div class="flex h-10 shrink-0 items-center justify-between border-y px-5 text-xs">
        <span>命令结果</span
        ><span v-if="commandResult" class="text-muted-foreground"
          >{{ commandResult.elapsedMs }} ms{{
            commandResult.truncated ? ' · 结果已截断' : ''
          }}</span
        >
      </div>
      <p
        v-if="commandError"
        role="alert"
        class="bg-destructive/10 text-destructive m-5 rounded p-4 text-xs break-all"
      >
        {{ commandError }}
      </p>
      <div v-if="commandResult" class="min-h-0 flex-1">
        <result-table :result="commandResult" />
      </div>
      <div
        v-else-if="!commandError"
        class="text-muted-foreground flex flex-1 items-center justify-center text-xs"
      >
        输入命令并执行，例如 PING、GET、HSET 或 SCAN。
      </div>
    </div>
    <Dialog v-model:open="bulkResultOpen">
      <dialog-content class="sm:max-w-xl">
        <dialog-header>
          <dialog-title
            >{{ bulkResult?.kind === 'ttl-batch' ? '批量 TTL' : '批量操作结果' }} · db{{
              database
            }}</dialog-title
          >
          <dialog-description>已选键的过期时间（秒）与操作结果。</dialog-description>
        </dialog-header>
        <div class="max-h-[60vh] overflow-auto rounded-md border">
          <p
            v-for="result in bulkResult?.results"
            :key="result.key"
            class="flex items-center justify-between gap-4 border-b px-4 py-2 font-mono text-xs last:border-b-0"
            :class="result.ok ? 'text-muted-foreground' : 'text-destructive'"
          >
            <span class="min-w-0 break-all">{{ result.key || '(空键名)' }}</span
            ><span class="shrink-0">{{ bulkOutcome(result) }}</span>
          </p>
        </div>
      </dialog-content>
    </Dialog>
    <alert-dialog
      :open="bulkAction !== null"
      @update:open="
        (value) => {
          if (!value && !bulkMutation.isPending.value) bulkAction = null
        }
      "
    >
      <alert-dialog-content class="sm:max-w-lg"
        ><alert-dialog-header
          ><alert-dialog-title>{{
            bulkAction === 'delete'
              ? '确认批量删除'
              : bulkAction === 'persist'
                ? '确认批量永久保留'
                : '确认批量设置 TTL'
          }}</alert-dialog-title
          ><alert-dialog-description
            >将修改 db{{ bulkSnapshot?.database }} 中的
            {{ bulkSnapshot?.keys.length }}
            个已选键。每个键独立执行，失败项不会回滚已经完成的修改。</alert-dialog-description
          ></alert-dialog-header
        ><Label v-if="bulkAction === 'expire'" class="grid gap-2"
          ><span>TTL 秒数（正整数）</span
          ><Input
            v-model="bulkSeconds"
            type="number"
            min="1"
            aria-label="Redis 批量 TTL 秒数"
            :disabled="bulkMutation.isPending.value"
        /></Label>
        <div class="max-h-40 overflow-auto rounded border p-3">
          <p
            v-for="key in bulkSnapshot?.keys"
            :key="key"
            class="font-mono text-xs leading-6 break-all"
          >
            {{ key || '(空键名)' }}
          </p>
        </div>
        <p v-if="notice" role="alert" class="text-destructive text-xs">{{ notice }}</p>
        <alert-dialog-footer
          ><alert-dialog-cancel :disabled="bulkMutation.isPending.value">取消</alert-dialog-cancel
          ><Button
            :disabled="closed || bulkMutation.isPending.value"
            :variant="bulkAction === 'delete' ? 'destructive' : 'default'"
            @click="submitBulk"
            >{{ bulkMutation.isPending.value ? '修改中…' : '确认修改' }}</Button
          ></alert-dialog-footer
        ></alert-dialog-content
      >
    </alert-dialog>
    <Dialog :open="customDbOpen" @update:open="customDbOpen = $event"
      ><dialog-content
        ><dialog-header
          ><dialog-title>选择其他数据库</dialog-title
          ><dialog-description>{{
            infoQuery.data.value?.databaseCount
              ? `服务器配置 ${infoQuery.data.value.databaseCount} 个数据库`
              : '服务器未提供数据库数量，可输入编号。'
          }}</dialog-description></dialog-header
        ><Input v-model="dbDraft" type="number" min="0" aria-label="Redis 数据库编号" /><alert
          v-if="notice"
          variant="destructive"
          ><alert-description>{{ notice }}</alert-description></alert
        ><Button :disabled="switchingDatabase" @click="selectCustomDatabase"
          >切换数据库</Button
        ></dialog-content
      ></Dialog
    >
    <Dialog
      :open="action !== null"
      @update:open="
        (value) => {
          if (!value && !mutation.isPending.value) action = null
        }
      "
    >
      <dialog-content class="sm:max-w-md"
        ><dialog-header
          ><dialog-title>{{
            action === 'rename'
              ? '重命名键'
              : action === 'expire'
                ? '设置过期时间'
                : action === 'set-string'
                  ? '保存字符串修改'
                  : '删除键'
          }}</dialog-title
          ><dialog-description class="break-all"
            >db{{ actionDb }} · {{ actionKey || '(空键名)' }}</dialog-description
          ></dialog-header
        >
        <form class="space-y-4" @submit.prevent="submitAction">
          <Label v-if="action === 'rename'" class="grid gap-2"
            ><span class="text-xs">新键名（已有同名键时不会覆盖）</span
            ><Input v-model="renameValue" /></Label
          ><Label v-if="action === 'expire'" class="grid gap-2"
            ><span class="text-xs">TTL 秒数（正整数）</span
            ><Input v-model="expireValue" type="number" min="1"
          /></Label>
          <p v-if="action === 'delete'" class="text-destructive text-sm">
            删除后无法从此工作区恢复。确认删除这个键？
          </p>
          <p v-if="action === 'set-string'" class="text-muted-foreground text-sm">
            保留当前过期时间；如果值已被其他客户端修改，本次保存会被拒绝。
          </p>
          <p v-if="notice" role="alert" class="text-destructive text-xs">{{ notice }}</p>
          <div class="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              :disabled="mutation.isPending.value"
              @click="action = null"
              >取消</Button
            ><Button
              type="submit"
              :variant="action === 'delete' ? 'destructive' : 'default'"
              :disabled="mutation.isPending.value"
              ><loader-circle v-if="mutation.isPending.value" :size="13" class="animate-spin" />{{
                action === 'delete' ? '确认删除' : '确认保存'
              }}</Button
            >
          </div>
        </form></dialog-content
      >
    </Dialog>
  </div>
</template>
