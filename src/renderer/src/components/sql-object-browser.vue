<script setup lang="ts">
import { TreeRow } from '@/components/ui/tree'
import { computed, ref, onBeforeUnmount, onMounted, watch } from 'vue'
import { useMutation } from '@tanstack/vue-query'
import { Folder, Database, RefreshCw, Table2, Eye, List } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu'
import {
  objectsSql,
  columnsSql,
  previewSql,
  countSql,
  qualifiedName,
  type SqlObject,
} from '@/lib/sql-browser'
import type { SqlCompletionTable } from '@/lib/sql-completion'
import type { Session, QueryResult } from '../../../shared/contracts'
const props = defineProps<{
  session: Session
  closed: boolean
  executing: boolean
  databases?: string[]
  database?: string
}>()
const emit = defineEmits<{
  database: [value: string]
  prepare: [sql: string]
  execute: [sql: string]
  busy: [value: boolean]
  completion: [tables: SqlCompletionTable[]]
  browse: [object: SqlObject]
  structure: [result: QueryResult]
}>()
const objects = ref<SqlObject[]>([]),
  filter = ref(''),
  selected = ref<SqlObject>(),
  fields = ref<QueryResult>(),
  loaded = ref(false),
  truncated = ref(false),
  error = ref('')
const expanded = ref(true)
const collapsedSchemas = ref<string[]>([])
const databaseNames = computed(() =>
  props.databases?.length
    ? props.databases
    : [props.database || (props.session.type === 'sqlite' ? 'main' : '当前数据库')],
)
const schemaNames = computed(() => [...new Set(visible.value.map((object) => object.schema))])
function hasNoMatches(name: string) {
  return (
    (name === props.database || (!props.database && databaseNames.value.length === 1)) &&
    loaded.value &&
    visible.value.length === 0
  )
}
function openDatabase(name: string) {
  if (blocked.value || hasNoMatches(name)) return
  if (name === props.database || (!props.database && databaseNames.value.length === 1)) {
    expanded.value = !expanded.value
    if (expanded.value && !loaded.value) load()
  } else emit('database', name)
}
function toggleSchema(name: string) {
  collapsedSchemas.value = collapsedSchemas.value.includes(name)
    ? collapsedSchemas.value.filter((item) => item !== name)
    : [...collapsedSchemas.value, name]
}
watch(
  () => props.database,
  (value) => {
    if (value) load()
  },
  { immediate: false },
)
let mounted = true
const completionTables = ref<SqlCompletionTable[]>([])
function publishCompletion() {
  emit(
    'completion',
    completionTables.value.map((table) => ({ ...table, columns: [...table.columns] })),
  )
}
const visible = computed(() =>
  objects.value.filter((o) =>
    `${o.schema}.${o.name}`.toLowerCase().includes(filter.value.toLowerCase()),
  ),
)
const mutation = useMutation({
  mutationFn: async (object?: SqlObject) => {
    const result = await window.vork.execute(
      props.session.id,
      object ? columnsSql(props.session.type, object) : objectsSql(props.session.type),
    )
    return { result, object }
  },
  retry: false,
  onSuccess({ result, object }) {
    if (!mounted) return
    if (object) {
      const nameIndex = result.columns.findIndex(
        (name) => name === 'name' || name === 'column_name',
      )
      const table = completionTables.value.find(
        (table) => table.schema === object.schema && table.name === object.name,
      )
      if (table && nameIndex >= 0) {
        table.columns = result.rows.map((row) => String(row[nameIndex]))
        publishCompletion()
      }
      selected.value = object
      const indices = result.columns
        .map((_, index) => index)
        .filter((index) => result.columns[index] !== 'cid')
      fields.value = {
        ...result,
        columns: indices.map((index) => result.columns[index]!),
        rows: result.rows.map((row) => indices.map((index) => row[index]!)),
      }
      emit('structure', fields.value!)
    } else {
      objects.value = result.rows.map((row) => ({
        schema: String(row[0]),
        name: String(row[1]),
        kind: String(row[2]),
      }))
      completionTables.value = objects.value.map((object) => ({
        schema: object.schema,
        name: object.name,
        columns: [],
      }))
      publishCompletion()
      loaded.value = true
      truncated.value = result.truncated
      selected.value = undefined
      fields.value = undefined
    }
  },
  onError(e) {
    if (mounted) error.value = e.message
  },
  onSettled() {
    if (mounted) emit('busy', false)
  },
})
function load(object?: SqlObject) {
  if (props.closed || props.executing || mutation.isPending.value) return
  error.value = ''
  emit('busy', true)
  mutation.mutate(object)
}
onMounted(() => {
  if (props.database) load()
})
let clickTimer: ReturnType<typeof setTimeout> | undefined
const blocked = computed(() => props.closed || props.executing || mutation.isPending.value)
function cancelClick() {
  clearTimeout(clickTimer)
}
function clickObject(object: SqlObject, event: MouseEvent) {
  clearTimeout(clickTimer)
  if (event.detail === 0) {
    load(object)
    return
  }
  if (event.detail === 1) clickTimer = setTimeout(() => load(object), 250)
}
function executeObject(object: SqlObject, count = false) {
  clearTimeout(clickTimer)
  if (blocked.value) return
  emit(
    'execute',
    count ? countSql(props.session.type, object) : previewSql(props.session.type, object),
  )
}
async function copyObject(object: SqlObject, qualified = false) {
  try {
    await navigator.clipboard.writeText(
      qualified ? qualifiedName(props.session.type, object) : object.name,
    )
  } catch {
    error.value = '无法访问剪贴板'
  }
}
function prepare(object: SqlObject) {
  emit('prepare', previewSql(props.session.type, object))
}
onBeforeUnmount(() => {
  clearTimeout(clickTimer)
  mounted = false
  emit('busy', false)
})
</script>
<template>
  <aside
    class="bg-sidebar/40 flex h-full min-h-0 w-[270px] shrink-0 flex-col border-r"
    aria-label="SQL 对象浏览器"
  >
    <div class="flex h-12 shrink-0 items-center gap-2 border-b px-2">
      <div class="relative min-w-0 flex-1">
        <database
          :size="14"
          class="text-muted-foreground pointer-events-none absolute top-2.5 left-2"
        /><Input
          v-model="filter"
          aria-label="搜索 SQL 对象"
          placeholder="搜索表或视图…"
          class="h-8 pl-7 text-xs"
        />
      </div>
      <Button
        size="icon"
        variant="ghost"
        class="size-7 shrink-0"
        aria-label="刷新 SQL 对象"
        :disabled="closed || executing || mutation.isPending.value"
        @click="load()"
        ><refresh-cw :size="13" :class="mutation.isPending.value ? 'animate-spin' : ''"
      /></Button>
    </div>
    <alert v-if="error" variant="destructive" class="mx-3 w-auto"
      ><alert-description class="text-xs break-all">{{ error }}</alert-description></alert
    >
    <div class="scroll-area min-h-0 flex-1 overflow-auto px-2">
      <template v-for="db in databaseNames" :key="db">
        <tree-row
          class="mb-1"
          :label="db"
          :selected="db === database"
          :disabled="blocked"
          :expandable="!hasNoMatches(db)"
          :expanded="db === database && expanded"
          @toggle="openDatabase(db)"
          @activate="openDatabase(db)"
          ><template #icon><database :size="14" class="shrink-0" /></template
        ></tree-row>
        <div
          v-if="
            (db === database || (!database && databaseNames.length === 1)) &&
            expanded &&
            !hasNoMatches(db)
          "
          class="border-border/60 mb-2 ml-3 border-l pl-2"
        >
          <template v-for="schema in schemaNames" :key="schema">
            <tree-row
              v-if="session.type === 'postgresql'"
              :label="schema"
              expandable
              :expanded="!collapsedSchemas.includes(schema)"
              @toggle="toggleSchema(schema)"
              @activate="toggleSchema(schema)"
              ><template #icon><folder :size="13" class="shrink-0" /></template
            ></tree-row>
            <div
              v-show="session.type !== 'postgresql' || !collapsedSchemas.includes(schema)"
              :class="session.type === 'postgresql' ? 'pl-3' : ''"
            >
              <context-menu
                v-for="object in visible.filter((item) => item.schema === schema)"
                :key="JSON.stringify([object.schema, object.name])"
                ><context-menu-trigger as-child :disabled="blocked" @contextmenu="cancelClick"
                  ><tree-row
                    :label="object.name"
                    :title="`${object.schema}.${object.name}`"
                    :disabled="blocked"
                    :selected="selected?.schema === object.schema && selected?.name === object.name"
                    @activate="clickObject(object, $event)"
                    @double-activate="executeObject(object)"
                  >
                    <template #icon
                      ><eye
                        v-if="object.kind.toLowerCase().includes('view')"
                        :size="13"
                        class="shrink-0" /><table2 v-else :size="13" class="shrink-0"
                    /></template>
                    <template #actions>
                      <Button
                        variant="ghost"
                        size="icon"
                        class="size-7 shrink-0"
                        :aria-label="`管理数据 ${object.schema}.${object.name}`"
                        :disabled="blocked"
                        @click="emit('browse', object)"
                        ><table2 :size="12"
                      /></Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        class="size-7 shrink-0"
                        :aria-label="`预览 ${object.schema}.${object.name}`"
                        :disabled="closed || executing || mutation.isPending.value"
                        @click="prepare(object)"
                        ><list :size="12" /></Button
                    ></template> </tree-row
                ></context-menu-trigger>
                <context-menu-content>
                  <context-menu-item :disabled="blocked" @select="emit('browse', object)"
                    >管理数据（分页与编辑）</context-menu-item
                  >
                  <context-menu-item :disabled="blocked" @select="executeObject(object)"
                    >查看数据（前 1000 行）</context-menu-item
                  >
                  <context-menu-item :disabled="blocked" @select="load(object)"
                    >查看字段</context-menu-item
                  >
                  <context-menu-item :disabled="blocked" @select="executeObject(object, true)"
                    >查询总行数</context-menu-item
                  >
                  <context-menu-item :disabled="blocked" @select="prepare(object)"
                    >生成 SELECT</context-menu-item
                  >
                  <context-menu-item @select="copyObject(object)">复制表名</context-menu-item>
                  <context-menu-item @select="copyObject(object, true)"
                    >复制完整表名</context-menu-item
                  >
                  <context-menu-item :disabled="blocked" @select="load()"
                    >刷新列表</context-menu-item
                  >
                </context-menu-content></context-menu
              >
            </div>
          </template>
          <p v-if="!loaded" class="text-muted-foreground p-5 text-center text-xs leading-6">
            点击刷新读取当前连接的表与视图。单击查看字段，双击查询前 1000 行，右键打开常用操作。
          </p>
          <p v-else-if="!visible.length" class="text-muted-foreground p-5 text-center text-xs">
            没有匹配的对象。
          </p>
          <p v-if="truncated" class="text-muted-foreground p-3 text-xs">
            对象列表达到返回上限，部分对象未展示。
          </p>
        </div>
      </template>
    </div>
  </aside>
</template>
