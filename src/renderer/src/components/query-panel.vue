<script setup lang="ts">
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Bookmark, WandSparkles, PanelsTopLeft } from '@lucide/vue'
import { ResizeHandle } from '@/components/ui/resize-handle'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { notifications } from '@/composables/use-notifications'
import { formatSql } from '@/lib/sql-format'
import CodeEditor from './code-editor.vue'
import SqlSnippets from './sql-snippets.vue'
import DataBrowser from './data-browser.vue'
import type { SqlObject } from '@/lib/sql-browser'
const dataOpen = ref(false),
  dataObject = ref<SqlObject>()
function browseTable(object: SqlObject) {
  dataObject.value = { ...object }
  dataOpen.value = true
}
import type { SqlDialect } from '@/lib/sql-snippets'
const snippetsOpen = ref(false)
import { computed, ref, onBeforeUnmount, watch } from 'vue'
import { useMutation } from '@tanstack/vue-query'
import { Play, Square, Table2, Clock3, Check, Copy, Download } from '@lucide/vue'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import ResultTable from './result-table.vue'
import SqlObjectBrowser from './sql-object-browser.vue'
import type { SqlCompletionTable } from '@/lib/sql-completion'
import type { Session, SqlBatchResult, QueryResult } from '../../../shared/contracts'
const props = defineProps<{
  session: Session
  databases?: string[]
  database?: string
  databaseBusy?: boolean
  closed: boolean
  prepared?: { sql: string; version: number }
}>()
const emit = defineEmits<{
  draft: [sql: string]
  busy: [value: boolean]
  database: [value: string]
}>()
const container = ref<HTMLElement>(),
  sidebarVisible = ref(true),
  sidebarWidth = ref(270),
  editorHeight = ref(210),
  editorVisible = ref(true),
  resultsVisible = ref(true),
  outputTab = ref('results'),
  structure = ref<QueryResult>()
function setLayout(layout: 'default' | 'editor' | 'results') {
  editorVisible.value = layout !== 'results'
  resultsVisible.value = layout !== 'editor'
  if (layout === 'default') sidebarVisible.value = true
}
function toggleEditor() {
  editorVisible.value = !editorVisible.value
  if (!editorVisible.value) resultsVisible.value = true
}
function resizeSidebar(delta: number) {
  sidebarWidth.value = Math.max(
    160,
    Math.min((container.value?.clientWidth || 800) * 0.5, sidebarWidth.value + delta),
  )
}
function resizeEditor(delta: number) {
  editorHeight.value = Math.max(
    100,
    Math.min((container.value?.clientHeight || 600) - 220, editorHeight.value + delta),
  )
}
function showStructure(value: QueryResult) {
  structure.value = value
  outputTab.value = 'structure'
  resultsVisible.value = true
}

const command = ref(
  props.session.type === 'redis'
    ? 'PING'
    : props.session.type === 'sqlite'
      ? "SELECT 'Hello, Vork' AS message, sqlite_version() AS version;"
      : 'SELECT 1 AS connected;',
)
watch(
  () => props.prepared,
  (value) => {
    if (value) command.value = value.sql
  },
  { immediate: true },
)
watch(command, (value) => emit('draft', value), { immediate: true })
const completionTables = ref<SqlCompletionTable[]>([])
const metadataBusy = ref(false),
  exporting = ref(false),
  exportNotice = ref('')
const history = ref<{ id: string; sql: string }[]>([]),
  historySelection = ref('none')
let historyId = 0
const batch = ref<SqlBatchResult>(),
  resultIndex = ref('0'),
  selection = ref('')
const result = computed(() => batch.value?.results[Number(resultIndex.value)]?.result),
  error = ref(''),
  copied = ref(false)
let mounted = true,
  copyTimer: ReturnType<typeof setTimeout> | undefined
const mutation = useMutation({
  mutationFn: async (sql: string): Promise<SqlBatchResult> => {
    if (sql.trimStart().startsWith('.') || props.session.type === 'redis')
      return {
        results: [{ index: 1, sql, result: await window.vork.execute(props.session.id, sql) }],
        elapsedMs: 0,
      }
    return window.vork.executeScript(props.session.id, sql)
  },
  retry: false,
  onSuccess(value, sql) {
    if (!value.error && !value.notice && !sql.trimStart().startsWith('.') && sql.length <= 65536)
      void window.vork
        .recordQuery(props.session.id, sql)
        .catch((e) => notifications.notify(`无法保存查询历史：${e.message}`, 'error'))
    if (mounted) {
      outputTab.value = 'results'
      resultsVisible.value = true
      batch.value = value
      resultIndex.value = String(Math.max(0, value.results.length - 1))
      error.value = value.error
        ? `第 ${value.failedIndex} 条语句失败：${value.error}。后续语句未执行；此前写入不会自动回滚。`
        : ''
      exportNotice.value = value.notice || ''
      historySelection.value = 'none'
      if (!value.error && !value.notice && sql.length <= 65536)
        history.value = [
          { id: String(++historyId), sql },
          ...history.value.filter((item) => item.sql !== sql),
        ].slice(0, 20)
    }
  },
  onError(e) {
    if (mounted) error.value = e.message
  },
})
watch(
  () => mutation.isPending.value || metadataBusy.value,
  (value) => emit('busy', value),
  { immediate: true },
)

function format() {
  try {
    command.value = formatSql(
      command.value,
      props.session.type === 'mysql'
        ? 'mysql'
        : props.session.type === 'postgresql'
          ? 'postgresql'
          : 'sqlite',
    )
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  }
}
function executeSql(sql: string) {
  command.value = sql
  run(sql)
}
function run(sql?: unknown) {
  const chosen =
    typeof sql === 'string' && sql.trim()
      ? sql
      : selection.value.trim()
        ? selection.value
        : command.value
  if (props.closed || metadataBusy.value || mutation.isPending.value || !chosen.trim()) return
  error.value = ''
  mutation.mutate(chosen)
}
async function cancel() {
  try {
    await window.vork.cancel(props.session.id)
  } catch (e) {
    error.value = (e as Error).message
  }
}
async function exportRows() {
  if (!result.value || exporting.value || props.closed) return
  exporting.value = true
  try {
    const path = await window.vork.exportResult(props.session.id, result.value)
    if (path && mounted)
      exportNotice.value = `已导出当前结果：${path}${result.value.truncated ? '（仅当前截断结果）' : ''}`
  } catch (e) {
    if (mounted) error.value = (e as Error).message
  } finally {
    exporting.value = false
  }
}
function restoreHistory(value: unknown) {
  const item = history.value.find((item) => item.id === String(value))
  if (item) {
    command.value = item.sql
    historySelection.value = item.id
  }
}
async function copy() {
  if (!result.value) return
  try {
    await navigator.clipboard.writeText(
      [
        result.value.columns.join('\t'),
        ...result.value.rows.map((row) =>
          row.map((v) => (v === null ? 'NULL' : String(v))).join('\t'),
        ),
      ].join('\n'),
    )
    copied.value = true
    copyTimer = setTimeout(() => (copied.value = false), 1500)
  } catch {
    error.value = '无法访问剪贴板'
  }
}
onBeforeUnmount(() => {
  mounted = false
  if (copyTimer) clearTimeout(copyTimer)
})
</script>
<template>
  <div ref="container" class="flex h-full min-h-0 min-w-0">
    <data-browser
      v-if="dataObject"
      v-model:open="dataOpen"
      :table="dataObject"
      :session="session"
      :closed="closed"
      :executing="mutation.isPending.value || metadataBusy"
      @busy="metadataBusy = $event"
    />
    <sql-snippets
      v-model:open="snippetsOpen"
      :sql="selection.trim() ? selection : command"
      :dialect="session.type as SqlDialect"
      :busy="metadataBusy || mutation.isPending.value"
      @load="command = $event"
    />
    <sql-object-browser
      v-show="sidebarVisible"
      :style="{ width: sidebarWidth + 'px' }"
      :session="session"
      :closed="closed"
      :executing="mutation.isPending.value || databaseBusy"
      :databases="databases"
      :database="database"
      @database="emit('database', $event)"
      @structure="showStructure"
      @busy="metadataBusy = $event"
      @prepare="command = $event"
      @execute="executeSql"
      @completion="completionTables = $event"
      @browse="browseTable"
    />
    <resize-handle
      axis="horizontal"
      label="调整表浏览器宽度，双击收起或展开"
      @dblclick="sidebarVisible = !sidebarVisible"
      @resize="resizeSidebar"
    />
    <div class="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <slot name="workspace-tabs" />
      <div
        class="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-5 py-2"
      >
        <div class="text-muted-foreground flex items-center gap-2 text-xs">
          <badge variant="secondary" class="text-[10px] uppercase">{{
            session.type === 'redis' ? 'command' : 'sql'
          }}</badge
          ><span>{{ session.type === 'redis' ? '命令工作台' : '查询编辑器' }}</span>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <Select
            :model-value="historySelection"
            :disabled="closed || metadataBusy || mutation.isPending.value || !history.length"
            @update:model-value="restoreHistory"
            ><select-trigger aria-label="SQL 查询历史" class="h-8 w-32 text-xs"
              ><select-value placeholder="查询历史" /></select-trigger
            ><select-content
              ><select-item value="none">查询历史</select-item
              ><select-item v-for="item in history" :key="item.id" :value="item.id"
                ><span class="max-w-[360px] truncate font-mono text-xs">{{
                  item.sql
                }}</span></select-item
              ></select-content
            ></Select
          >
          <dropdown-menu>
            <dropdown-menu-trigger as-child>
              <Button variant="outline" size="icon-sm" aria-label="选择查询布局" title="布局"
                ><panels-top-left :size="14"
              /></Button>
            </dropdown-menu-trigger>
            <dropdown-menu-content align="end" class="w-44">
              <dropdown-menu-item @select="setLayout('default')"
                ><check
                  :size="14"
                  :class="editorVisible && resultsVisible ? '' : 'invisible'"
                />默认布局</dropdown-menu-item
              >
              <dropdown-menu-item @select="setLayout('editor')"
                ><check
                  :size="14"
                  :class="editorVisible && !resultsVisible ? '' : 'invisible'"
                />仅编辑器</dropdown-menu-item
              >
              <dropdown-menu-item @select="setLayout('results')"
                ><check
                  :size="14"
                  :class="!editorVisible && resultsVisible ? '' : 'invisible'"
                />仅执行结果</dropdown-menu-item
              >
              <dropdown-menu-item @select="sidebarVisible = !sidebarVisible"
                ><check
                  :size="14"
                  :class="sidebarVisible ? '' : 'invisible'"
                />显示表浏览器</dropdown-menu-item
              >
            </dropdown-menu-content>
          </dropdown-menu>

          <Button
            variant="outline"
            size="icon-sm"
            aria-label="SQL 收藏片段"
            title="SQL 收藏"
            :disabled="mutation.isPending.value"
            @click="snippetsOpen = true"
            ><bookmark :size="14" /></Button
          ><Button
            variant="outline"
            size="icon-sm"
            aria-label="格式化 SQL"
            title="格式化 SQL"
            :disabled="closed || metadataBusy || mutation.isPending.value"
            @click="format"
            ><wand-sparkles :size="14" /></Button
          ><Button
            v-if="mutation.isPending.value"
            variant="outline"
            size="icon-sm"
            aria-label="停止并断开"
            title="停止并断开"
            @click="cancel"
            ><square :size="12" /></Button
          ><Button
            size="icon-sm"
            :aria-label="selection.trim() ? '执行选中 SQL' : '执行 SQL'"
            :title="selection.trim() ? '执行选中 SQL（⌘ Enter）' : '执行 SQL（⌘ Enter）'"
            :disabled="closed || metadataBusy || mutation.isPending.value || !command.trim()"
            @click="run"
            ><play :size="14"
          /></Button>
        </div>
      </div>
      <p
        v-if="session.type === 'sqlite'"
        class="text-muted-foreground border-b px-5 py-2 text-[10px]"
      >
        .import 表名：选择带字段表头 CSV，事务导入现有表 · .dump [表名]：导出结构与数据 SQL（16 MiB
        上限）
      </p>
      <code-editor
        v-if="editorVisible"
        v-model="command"
        :style="resultsVisible ? { height: editorHeight + 'px' } : { flex: 1 }"
        :tables="completionTables"
        :language="
          session.type === 'redis'
            ? 'redis'
            : session.type === 'mysql'
              ? 'mysql'
              : session.type === 'postgresql'
                ? 'postgresql'
                : 'sqlite'
        "
        :disabled="closed || metadataBusy || mutation.isPending.value"
        :label="session.type === 'redis' ? 'Redis 命令' : 'SQL 查询'"
        class="shrink-0"
        @selection="selection = $event"
        @execute="run"
      />
      <resize-handle
        axis="vertical"
        label="调整编辑器高度，双击收起或展开"
        @dblclick="toggleEditor"
        @resize="resizeEditor"
      />
      <div v-if="resultsVisible" class="flex min-h-0 flex-1 flex-col">
        <div class="bg-sidebar/50 flex h-11 shrink-0 items-center justify-between border-y px-5">
          <div class="flex items-center gap-2">
            <tabs v-model="outputTab" class="shrink-0"
              ><tabs-list
                ><tabs-trigger value="results">执行结果</tabs-trigger
                ><tabs-trigger value="structure">表结构／字段</tabs-trigger></tabs-list
              ></tabs
            >
            <span
              v-if="outputTab === 'results' && result"
              class="text-muted-foreground ml-2 text-[11px]"
              >{{ result.rows.length }} 行{{
                result.truncated ? ' · 已截断（最多 1000 行 / 4 MB）' : ''
              }}</span
            >
          </div>
          <div class="text-muted-foreground flex items-center gap-3 text-xs">
            <span v-if="outputTab === 'results' && result" class="flex items-center gap-1"
              ><clock3 :size="12" />{{ result.elapsedMs }} ms</span
            ><Button
              v-if="outputTab === 'results' && result"
              variant="ghost"
              size="icon"
              class="size-7"
              aria-label="导出 CSV"
              :disabled="closed || exporting"
              @click="exportRows"
              ><Download :size="13" /></Button
            ><Button
              v-if="outputTab === 'results' && result"
              size="icon"
              variant="ghost"
              class="size-7"
              aria-label="复制结果"
              @click="copy"
              ><check v-if="copied" :size="13" /><Copy v-else :size="13"
            /></Button>
          </div>
        </div>
        <template v-if="outputTab === 'results'">
          <div
            v-if="batch && batch.results.length > 1"
            class="flex shrink-0 items-center gap-3 border-t px-5 py-2"
          >
            <Select v-model="resultIndex"
              ><select-trigger aria-label="SQL 结果集" class="h-8 w-64 text-xs"
                ><select-value /></select-trigger
              ><select-content
                ><select-item
                  v-for="(item, index) in batch.results"
                  :key="index"
                  :value="String(index)"
                  >语句 {{ item.index }} ·
                  {{
                    item.result.columns.length
                      ? `${item.result.rows.length} 行`
                      : `${item.result.affectedRows} 行受影响`
                  }}</select-item
                ></select-content
              ></Select
            ><span class="text-muted-foreground text-xs"
              >{{ batch.results.length }} 条完成 · {{ batch.elapsedMs }} ms</span
            >
          </div>
          <alert v-if="exportNotice" class="m-3 w-auto"
            ><alert-description class="text-xs break-all">{{
              exportNotice
            }}</alert-description></alert
          >
          <alert
            v-if="error"
            variant="destructive"
            class="border-destructive/20 bg-destructive/5 text-destructive m-4 rounded-lg border p-4 break-all"
            ><div class="mb-1 text-xs font-semibold">执行失败</div>
            <alert-description>
              <pre class="font-mono text-xs whitespace-pre-wrap">{{ error }}</pre>
            </alert-description></alert
          >
          <div v-if="result" class="min-h-0 flex-1"><result-table :result="result" /></div>
          <div
            v-else-if="!error"
            class="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-3"
          >
            <div class="bg-card rounded-xl border p-4">
              <table2 :size="25" :stroke-width="1.3" />
            </div>
            <p class="text-sm">
              {{ mutation.isPending.value ? '正在等待结果…' : '运行第一条查询' }}
            </p>
            <p class="text-xs">
              {{
                session.type === 'redis'
                  ? '输入 Redis 命令，点击执行查看结果。'
                  : '选中内容优先执行；脚本按顺序执行，遇错停止。'
              }}
            </p>
          </div>
        </template>
        <div v-else class="min-h-0 flex-1">
          <result-table v-if="structure" :result="structure" />
          <p v-else class="text-muted-foreground p-8 text-center text-sm">
            在左侧选择表，查看字段结构。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
