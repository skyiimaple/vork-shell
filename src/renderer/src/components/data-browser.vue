<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
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
import ResultTable from './result-table.vue'
import type { Cell, Session, DataTable, TablePage, TableRequest } from '../../../shared/contracts'
const props = defineProps<{
  table: DataTable
  session: Session
  closed: boolean
  executing: boolean
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ busy: [value: boolean] }>()
const data = ref<TablePage>(),
  loading = ref(false),
  error = ref(''),
  notice = ref(''),
  pageSize = ref('50')
const sort = ref<{ column: string; descending: boolean }>(),
  filterColumn = ref('none'),
  filterOperator = ref('eq'),
  filterValue = ref('')
const appliedFilter = ref<Extract<TableRequest, { kind: 'browse' }>['filter']>()
const editing = ref<{ snapshotId: string; rowIndex: number; column: string; original: Cell }>(),
  editValue = ref(''),
  editType = ref('text'),
  saving = ref(false)
const busy = computed(() => loading.value || saving.value || props.closed)
const editableColumns = computed(() =>
  data.value?.snapshotId
    ? data.value.columns.filter((column) => column.editable).map((column) => column.name)
    : [],
)
let request = 0,
  mounted = true
async function load(page = 0) {
  if (props.closed || loading.value || saving.value) return
  const current = ++request
  loading.value = true
  error.value = ''
  emit('busy', true)
  try {
    const response = await window.vork.tableRequest(props.session.id, {
      kind: 'browse',
      table: { ...props.table },
      page,
      pageSize: Number(pageSize.value),
      ...(sort.value ? { sort: { ...sort.value } } : {}),
      ...(appliedFilter.value ? { filter: { ...appliedFilter.value } } : {}),
    })
    if (mounted && current === request && response.kind === 'page') data.value = response
  } catch (e) {
    if (mounted && current === request) error.value = (e as Error).message
  } finally {
    if (mounted && current === request) {
      loading.value = false
      emit('busy', false)
    }
  }
}
watch(
  open,
  (value) => {
    if (value) {
      data.value = undefined
      sort.value = undefined
      appliedFilter.value = undefined
      filterColumn.value = 'none'
      filterValue.value = ''
      error.value = ''
      notice.value = ''
      editing.value = undefined
      void load()
    } else {
      request++
      loading.value = false
      editing.value = undefined
      emit('busy', false)
    }
  },
  { immediate: true },
)
function applyFilter() {
  if (busy.value) return
  appliedFilter.value =
    filterColumn.value === 'none'
      ? undefined
      : {
          column: filterColumn.value.slice(7),
          operator: filterOperator.value as 'eq' | 'contains' | 'is-null' | 'not-null',
          value: filterValue.value,
        }
  void load()
}
function sortBy(column: string) {
  if (busy.value) return
  sort.value =
    sort.value?.column === column
      ? sort.value.descending
        ? undefined
        : { column, descending: true }
      : { column, descending: false }
  void load()
}
function startEdit(rowIndex: number, column: string, value: Cell) {
  if (busy.value || !data.value?.snapshotId) return
  editing.value = { snapshotId: data.value.snapshotId, rowIndex, column, original: value }
  editValue.value = value === null ? '' : String(value)
  editType.value =
    value === null
      ? 'null'
      : typeof value === 'number'
        ? 'number'
        : typeof value === 'boolean'
          ? 'boolean'
          : 'text'
  error.value = ''
  notice.value = ''
}
async function saveCell() {
  if (!editing.value || busy.value) return
  const value: Cell =
    editType.value === 'null'
      ? null
      : editType.value === 'number'
        ? Number(editValue.value)
        : editType.value === 'boolean'
          ? editValue.value === 'true'
          : editValue.value
  if (
    editType.value === 'number' &&
    (!editValue.value.trim() ||
      !Number.isFinite(value as number) ||
      (Number.isInteger(value as number) && !Number.isSafeInteger(value as number)))
  ) {
    error.value = '请输入有效数字；超出安全范围的整数请使用文本类型输入'
    return
  }
  if (editType.value === 'boolean' && !['true', 'false'].includes(editValue.value)) {
    error.value = '布尔值请输入 true 或 false'
    return
  }
  saving.value = true
  emit('busy', true)
  error.value = ''
  try {
    await window.vork.tableRequest(props.session.id, {
      kind: 'edit',
      snapshotId: editing.value.snapshotId,
      rowIndex: editing.value.rowIndex,
      column: editing.value.column,
      value,
    })
    if (mounted) {
      editing.value = undefined
      notice.value = '已修改1个单元格；请按需刷新以查看其他客户端的修改。'
    }
  } catch (e) {
    if (mounted) error.value = (e as Error).message
  } finally {
    if (mounted) {
      saving.value = false
      emit('busy', false)
    }
  }
  if (mounted && !editing.value) void load(data.value?.page ?? 0)
}
onBeforeUnmount(() => {
  mounted = false
  request++
  emit('busy', false)
})
function refreshPage() {
  notice.value = ''
  void load(data.value?.page ?? 0)
}
</script>
<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!saving) open = value
      }
    "
    ><dialog-content
      :show-close-button="!saving"
      class="flex h-[85vh] flex-col gap-3 sm:max-w-[95vw]"
    >
      <dialog-header
        ><dialog-title>管理数据 · {{ table.schema }}.{{ table.name }}</dialog-title
        ><dialog-description
          >分页、排序和筛选在数据库执行。可编辑单元格带铅笔图标；写入前确认，原值变化时提示冲突。</dialog-description
        ></dialog-header
      >
      <form class="flex flex-wrap items-center gap-2" @submit.prevent="applyFilter">
        <Select v-model="filterColumn" :disabled="busy"
          ><select-trigger aria-label="数据筛选字段" class="w-44"><select-value /></select-trigger
          ><select-content
            ><select-item value="none">全部数据</select-item
            ><select-item
              v-for="column in data?.columns"
              :key="column.name"
              :value="'column:' + column.name"
              >{{ column.name }}</select-item
            ></select-content
          ></Select
        >
        <Select v-model="filterOperator" :disabled="busy || filterColumn === 'none'"
          ><select-trigger aria-label="数据筛选方式" class="w-32"><select-value /></select-trigger
          ><select-content
            ><select-item value="eq">等于</select-item
            ><select-item value="contains">包含文本</select-item
            ><select-item value="is-null">为空 NULL</select-item
            ><select-item value="not-null">不为空</select-item></select-content
          ></Select
        >
        <Input
          v-model="filterValue"
          aria-label="数据筛选值"
          class="w-48"
          placeholder="筛选值"
          :disabled="
            busy || filterColumn === 'none' || ['is-null', 'not-null'].includes(filterOperator)
          "
        />
        <Button type="submit" variant="outline" :disabled="busy">应用筛选</Button
        ><Button type="button" variant="outline" :disabled="busy" @click="refreshPage()"
          >刷新数据</Button
        >
        <span v-if="loading" class="text-muted-foreground text-xs">正在加载…</span>
      </form>
      <alert v-if="error && !editing" variant="destructive"
        ><alert-description>{{ error }}</alert-description></alert
      >
      <alert v-if="notice"
        ><alert-description>{{ notice }}</alert-description></alert
      >
      <p v-if="data?.result.truncated" class="text-destructive text-xs">
        当前页达到返回字节上限，已停止翻页。请减少每页行数或缩小筛选范围。
      </p>
      <p v-if="data?.readOnlyReason" class="text-muted-foreground text-xs">
        {{ data.readOnlyReason }}
      </p>
      <div class="min-h-0 flex-1 rounded-md border">
        <result-table
          v-if="data"
          :result="data.result"
          :editable-columns="editableColumns"
          :disabled="busy"
          server-sorting
          :sort="sort"
          @sort="sortBy"
          @edit="startEdit"
        />
        <p v-else class="text-muted-foreground p-10 text-center text-sm">
          {{ error ? '数据未加载，请检查错误后重试' : '读取数据…' }}
        </p>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span aria-label="数据分页状态"
          >第 {{ (data?.page ?? 0) + 1 }} 页 · {{ data?.result.rows.length ?? 0 }} 行{{
            data?.result.truncated ? ' · 已截断' : ''
          }}</span
        >
        <div class="flex items-center gap-2">
          <Select v-model="pageSize" :disabled="busy" @update:model-value="() => load()"
            ><select-trigger aria-label="数据每页行数" class="w-32"><select-value /></select-trigger
            ><select-content
              ><select-item value="20">每页20行</select-item
              ><select-item value="50">每页50行</select-item
              ><select-item value="100">每页100行</select-item></select-content
            ></Select
          ><Button
            variant="outline"
            size="sm"
            aria-label="数据上一页"
            :disabled="busy || !data || data.page === 0"
            @click="load(data!.page - 1)"
            >上一页</Button
          ><Button
            variant="outline"
            size="sm"
            aria-label="数据下一页"
            :disabled="busy || !data?.hasNext"
            @click="load(data!.page + 1)"
            >下一页</Button
          >
        </div>
      </div>
      <p class="text-muted-foreground text-[10px]">
        主键和复杂类型只读；分页是实时读取，其他客户端的增删可能改变页内容。编辑沿用当前连接的事务状态。
      </p>
    </dialog-content></Dialog
  >
  <Dialog
    :open="Boolean(editing)"
    @update:open="
      (value) => {
        if (!value && !saving) editing = undefined
      }
    "
    ><dialog-content :show-close-button="!saving" class="sm:max-w-[600px]"
      ><dialog-header
        ><dialog-title>确认修改单元格 · {{ editing?.column }}</dialog-title
        ><dialog-description
          >{{ table.schema }}.{{ table.name }} · 当前页第
          {{ (editing?.rowIndex ?? 0) + 1 }} 行，按主键定位。</dialog-description
        ></dialog-header
      >
      <Label class="grid gap-2"
        ><span>原值</span>
        <pre
          class="max-h-32 overflow-auto rounded border p-3 font-mono text-xs break-all whitespace-pre-wrap"
          >{{ editing?.original === null ? 'NULL' : editing?.original }}</pre>
      </Label>
      <form class="space-y-3" @submit.prevent="saveCell">
        <Label class="grid gap-2"
          ><span>新值类型</span
          ><Select v-model="editType" :disabled="saving"
            ><select-trigger aria-label="单元格值类型"><select-value /></select-trigger
            ><select-content
              ><select-item value="text">文本</select-item
              ><select-item value="number">数字</select-item
              ><select-item value="boolean">布尔值</select-item
              ><select-item value="null">NULL</select-item></select-content
            ></Select
          ></Label
        ><Label v-if="editType !== 'null'" class="grid gap-2"
          ><span>新值</span
          ><Textarea
            v-model="editValue"
            aria-label="单元格新值"
            :disabled="saving"
            class="min-h-24 font-mono" /></Label
        ><alert v-if="error" variant="destructive"
          ><alert-description>{{ error }}</alert-description></alert
        >
        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" :disabled="saving" @click="editing = undefined"
            >取消</Button
          ><Button type="submit" :disabled="saving || closed">{{
            saving ? '正在写入…' : '确认写入数据库'
          }}</Button>
        </div>
      </form>
    </dialog-content></Dialog
  >
</template>
