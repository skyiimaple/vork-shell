<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { Plus, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Tabs as TabsRoot, TabsList, TabsTrigger } from '@/components/ui/tabs'
import QueryPanel from './query-panel.vue'
import type { Session } from '../../../shared/contracts'
const props = defineProps<{
  session: Session
  closed: boolean
  prepared?: { sql: string; version: number }
}>()
const emit = defineEmits<{ draft: [sql: string] }>()
type QueryTab = {
  id: string
  name: string
  session: Session
  database: string
  owned: boolean
  sql?: string
  prepared?: { sql: string; version: number }
  closed: boolean
  busy: boolean
}
let sequence = 1,
  disposed = false
const tabs = ref<QueryTab[]>([
  {
    id: crypto.randomUUID(),
    name: 'Query 1',
    session: props.session,
    database: '',
    owned: false,
    prepared: props.prepared,
    closed: false,
    busy: false,
  },
])
const active = ref(tabs.value[0]!.id),
  working = ref(false),
  error = ref(''),
  databases = ref<string[]>([])
const current = computed(() => tabs.value.find((tab) => tab.id === active.value))
watch(
  () => props.prepared,
  (value) => {
    if (value && current.value) current.value.prepared = value
  },
)
function draft(tab: QueryTab, sql: string) {
  tab.sql = sql
  if (tab.id === active.value) emit('draft', sql)
}
watch(active, () => {
  if (current.value?.sql !== undefined) emit('draft', current.value.sql)
})
async function release(tab: QueryTab) {
  if (tab.owned && !tab.closed) {
    tab.closed = true
    await window.vork.disconnect(tab.session.id).catch(() => {})
  }
}
async function add() {
  if (working.value || props.closed) return
  working.value = true
  error.value = ''
  try {
    const session = ['mysql', 'postgresql'].includes(props.session.type)
      ? await window.vork.createQuerySession(props.session.id, current.value?.database || undefined)
      : props.session
    const tab: QueryTab = {
      id: crypto.randomUUID(),
      name: 'Query ' + ++sequence,
      session,
      database: current.value?.database || '',
      owned: session.id !== props.session.id,
      closed: false,
      busy: false,
    }
    if (disposed || props.closed) {
      await release(tab)
      return
    }
    tabs.value.push(tab)
    active.value = tab.id
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    working.value = false
  }
}
async function remove(tab: QueryTab) {
  if (tab.busy || working.value || tabs.value.length === 1) return
  await release(tab)
  const index = tabs.value.indexOf(tab)
  tabs.value.splice(index, 1)
  if (active.value === tab.id) active.value = tabs.value[Math.min(index, tabs.value.length - 1)]!.id
}
async function readDatabases() {
  if (props.closed) return
  try {
    const details = await window.vork.connectionDetails(props.session.id)
    const sql =
      props.session.type === 'mysql'
        ? 'SHOW DATABASES'
        : props.session.type === 'postgresql'
          ? 'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname'
          : 'PRAGMA database_list'
    const result = await window.vork.execute(props.session.id, sql)
    databases.value = result.rows.map((row) => String(row[props.session.type === 'sqlite' ? 1 : 0]))
    let selectedDatabase = details.database || ''
    if (props.session.type === 'mysql' || props.session.type === 'postgresql') {
      const actual = await window.vork.execute(
        props.session.id,
        props.session.type === 'mysql' ? 'SELECT DATABASE()' : 'SELECT current_database()',
      )
      selectedDatabase = actual.rows[0]?.[0] == null ? '' : String(actual.rows[0][0])
    } else selectedDatabase = databases.value[0] || ''
    for (const tab of tabs.value) if (!tab.database) tab.database = selectedDatabase
    if (details.database && !databases.value.includes(details.database))
      databases.value.unshift(details.database)
  } catch (e) {
    error.value = '数据库列表读取失败：' + (e as Error).message
  }
}
async function changeDatabase(value: unknown) {
  const tab = current.value
  if (!tab || tab.busy || working.value || props.closed || value === tab.database) return
  working.value = true
  error.value = ''
  try {
    const session = await window.vork.createQuerySession(props.session.id, String(value))
    if (disposed || props.closed) {
      await window.vork.disconnect(session.id)
      return
    }
    await release(tab)
    tab.session = session
    tab.owned = true
    tab.closed = false
    tab.database = String(value)
    tab.prepared = tab.sql !== undefined ? { sql: tab.sql, version: Date.now() } : undefined
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    working.value = false
  }
}
const unsubscribe = window.vork.onEvent((event) => {
  if (event.type === 'closed' || event.type === 'error')
    for (const tab of tabs.value) if (tab.session.id === event.sessionId) tab.closed = true
})
watch(
  () => props.closed,
  (value) => {
    if (value) for (const tab of tabs.value) void release(tab)
  },
)
onMounted(() => void readDatabases())
onBeforeUnmount(() => {
  disposed = true
  unsubscribe()
  for (const tab of tabs.value) void release(tab)
})
</script>
<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <template v-for="tab in tabs" :key="tab.session.id + tab.id"
      ><query-panel
        v-show="active === tab.id"
        :session="tab.session"
        :closed="closed || tab.closed"
        :prepared="tab.prepared"
        :databases="databases"
        :database="tab.database"
        :database-busy="working"
        class="min-h-0 flex-1"
        @database="changeDatabase"
        @draft="draft(tab, $event)"
        @busy="tab.busy = $event"
        ><template #workspace-tabs>
          <div class="flex shrink-0 items-center gap-2 border-b p-2">
            <tabs-root v-model="active" class="min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
              ><tabs-list class="h-auto justify-start"
                ><div v-for="queryTab in tabs" :key="queryTab.id" class="flex items-center">
                  <tabs-trigger :value="queryTab.id">{{ queryTab.name }}</tabs-trigger
                  ><Button
                    variant="ghost"
                    size="icon-xs"
                    :aria-label="`关闭 ${queryTab.name}`"
                    :disabled="tabs.length === 1 || queryTab.busy || working"
                    @click="remove(queryTab)"
                    ><x :size="12"
                  /></Button></div></tabs-list></tabs-root
            ><Button
              variant="outline"
              size="icon-sm"
              aria-label="新建查询标签"
              title="新建查询标签"
              :disabled="closed || working"
              @click="add"
              ><plus :size="14"
            /></Button>
          </div>
          <p v-if="error" role="alert" class="text-destructive p-2 text-xs">
            {{ error }}
          </p>
        </template></query-panel
      ></template
    >
  </div>
</template>
