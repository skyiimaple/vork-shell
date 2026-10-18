<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import type {
  Session,
  DataTable,
  StructureSource,
  StructureReport,
  StructureProgress,
} from '../../../shared/contracts'
const props = defineProps<{ session: Session; table: DataTable; closed: boolean }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ busy: [value: boolean] }>()
const sources = ref<StructureSource[]>([]),
  sourceKey = ref(''),
  targetKey = ref(''),
  sourceSchema = ref(''),
  targetSchema = ref(''),
  tableNames = ref(''),
  busy = ref(false),
  loading = ref(false),
  exporting = ref(false),
  error = ref(''),
  notice = ref(''),
  report = ref<StructureReport>(),
  requestId = ref(''),
  progress = ref<StructureProgress>(),
  canceling = ref(false),
  search = ref(''),
  kind = ref('all'),
  status = ref('all'),
  selected = ref(0)
const key = (source: StructureSource) => source.kind + ':' + source.id
const source = computed(() => sources.value.find((item) => key(item) === sourceKey.value)),
  target = computed(() => sources.value.find((item) => key(item) === targetKey.value))
const parsedTables = computed(() => [
  ...new Set(
    tableNames.value
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
  ),
])
const dirty = computed(
  () =>
    report.value &&
    (sourceKey.value !== key(report.value.source) ||
      targetKey.value !== key(report.value.target) ||
      sourceSchema.value !== report.value.source.schema ||
      targetSchema.value !== report.value.target.schema ||
      JSON.stringify(parsedTables.value) !== JSON.stringify(report.value.requestedTables)),
)
const kinds: Record<string, string> = {
    object: '表/对象',
    column: '字段',
    index: '索引',
    'foreign-key': '外键',
    trigger: '触发器',
    check: 'CHECK 约束',
    definition: '定义原文',
  },
  changes: Record<string, string> = {
    'source-only': '仅源端',
    'target-only': '仅目标端',
    changed: '不同',
  }
const rows = computed(
  () =>
    report.value?.differences
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row }) =>
          (kind.value === 'all' || row.kind === kind.value) &&
          (status.value === 'all' || row.change === status.value) &&
          `${row.table} ${row.name}`.toLowerCase().includes(search.value.toLowerCase()),
      ) || [],
)
const current = computed(() => report.value?.differences[selected.value])
const text = (value: unknown) =>
  value === undefined ? '（不存在）' : JSON.stringify(value, null, 2)
let mounted = true
const unsubscribe = window.vork.onStructureProgress((value) => {
  if (value.id === requestId.value) progress.value = value
})
function setBusy(value: boolean) {
  busy.value = value
  emit('busy', value)
}
async function loadSources() {
  loading.value = true
  error.value = ''
  try {
    sources.value = await window.vork.structureSources()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
function changedTarget() {
  const item = target.value
  targetSchema.value =
    item?.type === 'sqlite' ? 'main' : item?.type === 'postgresql' ? 'public' : sourceSchema.value
}
function swap() {
  const left = sourceKey.value,
    schema = sourceSchema.value
  sourceKey.value = targetKey.value
  sourceSchema.value = targetSchema.value
  targetKey.value = left
  targetSchema.value = schema
}
async function compare() {
  if (busy.value || !source.value || !target.value) return
  const id = crypto.randomUUID()
  requestId.value = id
  setBusy(true)
  error.value = ''
  notice.value = ''
  report.value = undefined
  progress.value = undefined
  canceling.value = false
  try {
    const result = await window.vork.compareStructure({
      id,
      source: { kind: source.value.kind, id: source.value.id },
      target: { kind: target.value.kind, id: target.value.id },
      sourceSchema: sourceSchema.value,
      targetSchema: targetSchema.value,
      tables: parsedTables.value,
    })
    if (mounted) {
      report.value = result
      selected.value = 0
      search.value = ''
      kind.value = 'all'
      status.value = 'all'
    }
  } catch (e) {
    if (mounted) error.value = (e as Error).message
  } finally {
    if (mounted) {
      setBusy(false)
      requestId.value = ''
      canceling.value = false
    }
  }
}
async function cancel() {
  canceling.value = true
  try {
    await window.vork.cancelStructure(requestId.value)
  } catch (e) {
    error.value = (e as Error).message
  }
}
async function exportReport() {
  if (!report.value || exporting.value) return
  exporting.value = true
  error.value = ''
  try {
    const path = await window.vork.exportStructure(report.value.id)
    if (path) notice.value = '已导出报告：' + path
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    exporting.value = false
  }
}
watch(
  open,
  async (value) => {
    if (value) {
      report.value = undefined
      notice.value = ''
      sourceSchema.value = props.table.schema
      targetSchema.value = props.table.schema
      tableNames.value = props.table.name
      await loadSources()
      const initial =
        sources.value.find((item) => item.kind === 'session' && item.id === props.session.id) ||
        sources.value[0]
      if (!initial) return
      sourceKey.value = key(initial)
      const other = sources.value.find((item) => key(item) !== sourceKey.value)
      targetKey.value = other ? key(other) : sourceKey.value
      changedTarget()
    }
  },
  { immediate: true },
)
watch(rows, (value) => {
  if (value.length && !value.some((item) => item.index === selected.value))
    selected.value = value[0]!.index
})
onBeforeUnmount(() => {
  mounted = false
  unsubscribe()
  if (requestId.value) void window.vork.cancelStructure(requestId.value).catch(() => {})
  emit('busy', false)
})
</script>
<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!busy && !exporting) open = value
      }
    "
    ><dialog-content
      :show-close-button="!busy && !exporting"
      class="flex h-[90vh] flex-col sm:max-w-[95vw]"
      ><dialog-header
        ><dialog-title>结构对比</dialog-title
        ><dialog-description
          >读取两侧结构并生成差异报告，不执行同步或修改数据。已保存连接使用临时会话，完成后释放。</dialog-description
        ></dialog-header
      >
      <div class="grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-3">
        <div class="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2">
          <Label class="grid gap-2"
            ><span>源端连接</span
            ><Select v-model="sourceKey" :disabled="busy || loading"
              ><select-trigger aria-label="结构对比源连接" class="w-full"
                ><select-value /></select-trigger
              ><select-content
                ><select-item v-for="item in sources" :key="key(item)" :value="key(item)"
                  >{{ item.kind === 'session' ? '已连接' : '已保存' }} · {{ item.name }} ·
                  {{ item.type }}</select-item
                ></select-content
              ></Select
            ></Label
          ><Label class="grid gap-2"
            ><span>Schema / 数据库</span
            ><Input v-model="sourceSchema" aria-label="结构对比源 Schema" :disabled="busy"
          /></Label>
        </div>
        <Button variant="outline" :disabled="busy" @click="swap">交换</Button>
        <div class="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2">
          <Label class="grid gap-2"
            ><span>目标连接</span
            ><Select
              v-model="targetKey"
              :disabled="busy || loading"
              @update:model-value="changedTarget"
              ><select-trigger aria-label="结构对比目标连接" class="w-full"
                ><select-value /></select-trigger
              ><select-content
                ><select-item v-for="item in sources" :key="key(item)" :value="key(item)"
                  >{{ item.kind === 'session' ? '已连接' : '已保存' }} · {{ item.name }} ·
                  {{ item.type }}</select-item
                ></select-content
              ></Select
            ></Label
          ><Label class="grid gap-2"
            ><span>Schema / 数据库</span
            ><Input v-model="targetSchema" aria-label="结构对比目标 Schema" :disabled="busy"
          /></Label>
        </div>
      </div>
      <div class="flex shrink-0 items-start gap-3">
        <Label class="grid min-w-0 flex-1 gap-1"
          ><span class="text-xs">指定表名，每行一个；留空比较整个 Schema（最多500张表）</span
          ><Textarea
            v-model="tableNames"
            aria-label="结构对比表名范围"
            class="max-h-24 min-h-14 font-mono text-xs"
            :disabled="busy"
        /></Label>
        <div class="flex shrink-0 gap-2 pt-5">
          <Button
            :disabled="busy || loading || !source || !target || !sourceSchema || !targetSchema"
            @click="compare"
            >开始对比</Button
          ><Button v-if="busy" variant="outline" :disabled="canceling" @click="cancel"
            >取消对比</Button
          ><Button
            variant="outline"
            :disabled="busy || !report || exporting || dirty"
            @click="exportReport"
            >导出报告 JSON</Button
          >
        </div>
      </div>
      <alert v-if="error" variant="destructive"
        ><alert-description>{{ error }}</alert-description></alert
      >
      <p v-if="notice" role="status" class="text-xs">{{ notice }}</p>
      <p v-if="busy" role="status" class="text-muted-foreground text-xs">
        {{
          canceling
            ? '正在取消，等待当前连接或元数据读取结束…'
            : progress
              ? `${progress.side === 'source' ? '源端' : '目标端'} ${progress.completed}/${progress.total} · ${progress.table}`
              : '正在连接和读取元数据…'
        }}
      </p>
      <p v-if="dirty" class="text-destructive text-xs">对比条件已变化，请重新对比。</p>
      <template v-if="report"
        ><div class="flex flex-wrap items-center gap-2">
          <badge variant="secondary">源端 {{ report.sourceTables }} 张</badge
          ><badge variant="secondary">目标 {{ report.targetTables }} 张</badge
          ><badge variant="secondary">{{ report.differences.length }} 项差异</badge
          ><Input
            v-model="search"
            aria-label="搜索结构差异"
            placeholder="搜索表/字段/索引名"
            class="ml-auto h-8 w-52"
          /><Select v-model="kind"
            ><select-trigger aria-label="结构差异类型" class="h-8 w-36"
              ><select-value /></select-trigger
            ><select-content
              ><select-item value="all">全部类型</select-item
              ><select-item v-for="(label, id) in kinds" :key="id" :value="id">{{
                label
              }}</select-item></select-content
            ></Select
          ><Select v-model="status"
            ><select-trigger aria-label="结构差异状态" class="h-8 w-32"
              ><select-value /></select-trigger
            ><select-content
              ><select-item value="all">全部状态</select-item
              ><select-item v-for="(label, id) in changes" :key="id" :value="id">{{
                label
              }}</select-item></select-content
            ></Select
          >
        </div>
        <div class="grid min-h-0 flex-1 grid-cols-[minmax(220px,1fr)_minmax(0,2fr)] gap-3">
          <div
            aria-label="结构差异列表"
            class="min-h-0 space-y-1 overflow-auto rounded-md border p-2"
          >
            <Button
              v-for="item in rows"
              :key="item.index"
              variant="ghost"
              class="h-auto w-full justify-start gap-2 p-2 text-left"
              :class="selected === item.index ? 'bg-primary/10 text-primary' : ''"
              @click="selected = item.index"
              ><span class="min-w-0 flex-1"
                ><span class="block truncate">{{ item.row.table }} · {{ item.row.name }}</span
                ><span class="text-muted-foreground text-xs"
                  >{{ kinds[item.row.kind] }} · {{ changes[item.row.change] }}</span
                ></span
              ></Button
            >
            <p v-if="!rows.length" class="text-muted-foreground p-4 text-sm">
              {{
                report.sourceTables === 0 && report.targetTables === 0
                  ? '所选范围没有表'
                  : report.differences.length
                    ? '没有匹配的差异'
                    : '未发现差异（按本次读取的元数据）'
              }}
            </p>
          </div>
          <div v-if="current" class="flex min-h-0 flex-col gap-2">
            <p class="shrink-0 text-sm font-medium">
              {{ current.table }} · {{ current.name }} · {{ kinds[current.kind] }}
            </p>
            <div class="grid min-h-0 flex-1 grid-cols-2 gap-3">
              <div class="flex min-h-0 flex-col rounded-md border">
                <p class="border-b p-2 text-xs">源端：{{ report.source.name }}</p>
                <pre
                  aria-label="结构差异源值"
                  class="min-h-0 flex-1 overflow-auto p-3 text-xs break-all whitespace-pre-wrap"
                  >{{ text(current.source) }}</pre>
              </div>
              <div class="flex min-h-0 flex-col rounded-md border">
                <p class="border-b p-2 text-xs">目标：{{ report.target.name }}</p>
                <pre
                  aria-label="结构差异目标值"
                  class="min-h-0 flex-1 overflow-auto p-3 text-xs break-all whitespace-pre-wrap"
                  >{{ text(current.target) }}</pre>
              </div>
            </div>
          </div>
        </div>
        <p
          v-for="warning in report.warnings"
          :key="warning"
          class="text-muted-foreground shrink-0 text-[11px]"
        >
          {{ warning }}
        </p>
      </template>
      <p v-else-if="!busy" class="text-muted-foreground py-8 text-center text-sm">
        选择连接和范围后开始对比。PostgreSQL 填 Schema，MySQL 填数据库名，SQLite 通常填 main。
      </p>
    </dialog-content></Dialog
  >
</template>
