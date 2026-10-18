<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import {
  useTable,
  tableFeatures,
  rowSortingFeature,
  columnSizingFeature,
  createSortedRowModel,
} from '@tanstack/vue-table'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { compareCells } from '@/lib/result-table'
import { Pencil, Eye, Columns3, Copy } from '@lucide/vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { notifications } from '@/composables/use-notifications'
import type { QueryResult, Cell } from '../../../shared/contracts'
const props = defineProps<{
  selectable?: boolean
  multiSelect?: boolean
  result: QueryResult
  editableColumns?: string[]
  disabled?: boolean
  serverSorting?: boolean
  sort?: { column: string; descending: boolean }
}>()
const emit = defineEmits<{
  edit: [rowIndex: number, column: string, value: Cell]
  sort: [column: string]
  select: [rowIndex: number]
  selectionChange: [rowIndices: number[]]
}>()
function sortDirection(id: string, name: string) {
  return props.serverSorting
    ? props.sort?.column === name
      ? props.sort.descending
        ? 'desc'
        : 'asc'
      : false
    : table.getColumn(id)?.getIsSorted()
}
const columnSettings = ref(false),
  columnSearch = ref(''),
  hidden = ref<string[]>([]),
  detail = ref<{ column: string; row: number; value: Cell }>(),
  detailOpen = ref(false),
  copying = ref(false)
const columnChoices = computed(() =>
  props.result.columns
    .map((name, index) => ({ name, id: String(index) }))
    .filter((column) => column.name.toLowerCase().includes(columnSearch.value.toLowerCase())),
)
function toggleColumn(id: string, checked: boolean | 'indeterminate') {
  if (checked === true) hidden.value = hidden.value.filter((value) => value !== id)
  else if (hidden.value.length < props.result.columns.length - 1)
    hidden.value = [...new Set([...hidden.value, id])]
}
function inspect(column: string, row: number, value: Cell) {
  detail.value = { column, row, value }
  detailOpen.value = true
}
async function copyCell() {
  if (!detail.value || copying.value) return
  copying.value = true
  try {
    await window.vork.copyText(detail.value.value === null ? 'NULL' : String(detail.value.value))
    notifications.notify('已复制单元格原值')
  } catch {
    notifications.notify('无法访问剪贴板', 'error')
  } finally {
    copying.value = false
  }
}
const selectedRows = ref<number[]>([])
function toggleSelection(index: number, checked: boolean | 'indeterminate') {
  if (props.disabled) return
  selectedRows.value =
    checked === true
      ? [...new Set([...selectedRows.value, index])]
      : selectedRows.value.filter((value) => value !== index)
  emit('selectionChange', [...selectedRows.value])
}
function toggleAll(checked: boolean | 'indeterminate') {
  if (props.disabled) return
  selectedRows.value = checked === true ? props.result.rows.map((_, index) => index) : []
  emit('selectionChange', [...selectedRows.value])
}
const selectedRow = ref<string>()
watch(
  () => props.result,
  () => {
    selectedRow.value = undefined
    selectedRows.value = []
    emit('selectionChange', [])
    detailOpen.value = false
    detail.value = undefined
  },
)
function selectRow(index: number) {
  if (props.disabled) return
  selectedRow.value = rows.value[index]?.id
  if (props.selectable && rows.value[index]) emit('select', rows.value[index]!.index)
}
const scroll = ref<HTMLElement | null>(null)
const data = computed(() => props.result.rows)
const columns = computed(() =>
  props.result.columns.map((name, index) => ({
    id: String(index),
    header: name,
    size: 180,
    minSize: 80,
    maxSize: 1000,
    sortDescFirst: false,
    accessorFn: (row: Cell[]) => row[index],
    sortFn: (a: { original: Cell[] }, b: { original: Cell[] }) =>
      compareCells(a.original[index]!, b.original[index]!),
  })),
)
const features = tableFeatures({
  rowSortingFeature,
  columnSizingFeature,
  sortedRowModel: createSortedRowModel(),
})
const table = useTable<typeof features, Cell[]>({ features, columns, data, enableMultiSort: false })
const rows = computed(() => table.getRowModel().rows)
const leafColumns = computed(() =>
  table.getAllLeafColumns().filter((column) => !hidden.value.includes(column.id)),
)
const virtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => scroll.value,
    estimateSize: () => 34,
    overscan: 12,
  })),
)
const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const total = computed(() => virtualizer.value.getTotalSize())
const width = computed(() =>
  leafColumns.value.reduce((total, column) => total + column.getSize(), 60),
)
let stopResize: (() => void) | undefined
function resize(event: PointerEvent, id: string) {
  stopResize?.()
  const startX = event.clientX,
    startWidth = table.getColumn(id)!.getSize()
  const move = (next: PointerEvent) =>
    table.setColumnSizing((previous) => ({
      ...previous,
      [id]: Math.max(80, Math.min(1000, startWidth + next.clientX - startX)),
    }))
  const stop = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    stopResize = undefined
  }
  stopResize = stop
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
  window.addEventListener('pointercancel', stop)
  event.preventDefault()
}
watch(
  () => props.result,
  () => {
    stopResize?.()
    table.resetSorting(true)
    virtualizer.value.scrollToOffset(0)
  },
)
watch(
  () => JSON.stringify(props.result.columns),
  () => {
    table.resetColumnSizing(true)
    hidden.value = []
    columnSearch.value = ''
  },
)
onBeforeUnmount(() => stopResize?.())
</script>
<template>
  <div class="flex h-full min-h-0 flex-col">
    <div
      v-if="result.columns.length"
      class="flex shrink-0 items-center justify-end border-b px-2 py-1"
    >
      <Button
        variant="ghost"
        size="sm"
        class="h-7 gap-1.5 text-xs"
        aria-label="设置结果列"
        @click="columnSettings = true"
        ><columns3 class="size-3.5" />列 {{ leafColumns.length }}/{{
          result.columns.length
        }}</Button
      >
    </div>
    <div ref="scroll" class="scroll-area min-h-0 flex-1 overflow-auto font-mono text-xs">
      <Table
        container-class="overflow-visible"
        class="block text-xs"
        :style="{ width: `${width}px`, minWidth: '100%' }"
        :aria-rowcount="rows.length + 1"
        :aria-colcount="leafColumns.length + 1"
      >
        <table-header class="bg-sidebar text-muted-foreground sticky top-0 z-10 block"
          ><table-row class="flex h-10 hover:bg-transparent"
            ><table-head class="flex h-full w-[60px] shrink-0 items-center border-r px-4"
              ><checkbox
                v-if="multiSelect"
                aria-label="选择当前页全部行"
                :disabled="disabled || !result.rows.length"
                :model-value="
                  selectedRows.length === result.rows.length && !!result.rows.length
                    ? true
                    : selectedRows.length
                      ? 'indeterminate'
                      : false
                "
                @update:model-value="toggleAll"
              /><span v-else>#</span></table-head
            ><table-head
              v-for="column in leafColumns"
              :key="column.id"
              :style="{ width: `${column.getSize()}px` }"
              :aria-sort="
                sortDirection(column.id, String(column.columnDef.header)) === 'asc'
                  ? 'ascending'
                  : sortDirection(column.id, String(column.columnDef.header)) === 'desc'
                    ? 'descending'
                    : 'none'
              "
              class="relative flex h-full shrink-0 items-center border-r px-2 font-medium"
              ><Button
                variant="ghost"
                size="sm"
                class="h-8 min-w-0 flex-1 justify-start px-2 text-xs"
                :aria-label="`排序 ${column.columnDef.header}`"
                :disabled="disabled"
                @click="
                  serverSorting
                    ? emit('sort', String(column.columnDef.header))
                    : column.toggleSorting()
                "
                ><span class="truncate">{{ column.columnDef.header }}</span
                ><span class="ml-auto">{{
                  sortDirection(column.id, String(column.columnDef.header)) === 'asc'
                    ? '↑'
                    : sortDirection(column.id, String(column.columnDef.header)) === 'desc'
                      ? '↓'
                      : '↕'
                }}</span></Button
              ><Button
                variant="ghost"
                class="hover:bg-primary/30 absolute top-0 right-0 h-full w-2 cursor-col-resize touch-none rounded-none p-0"
                :aria-label="`调整列宽 ${column.columnDef.header}`"
                @pointerdown.stop="resize($event, column.id)"
                @click.stop
                @keydown.left.prevent="
                  table.setColumnSizing((previous) => ({
                    ...previous,
                    [column.id]: Math.max(80, column.getSize() - 10),
                  }))
                "
                @keydown.right.prevent="
                  table.setColumnSizing((previous) => ({
                    ...previous,
                    [column.id]: Math.min(1000, column.getSize() + 10),
                  }))
                " /></table-head></table-row
        ></table-header>
        <table-body class="relative block" :style="{ height: `${total}px` }">
          <table-row
            v-for="item in virtualRows"
            :key="item.key.toString()"
            :aria-rowindex="item.index + 2"
            :aria-selected="
              selectedRow === rows[item.index]?.id || selectedRows.includes(rows[item.index]!.index)
            "
            :class="
              selectedRow === rows[item.index]?.id || selectedRows.includes(rows[item.index]!.index)
                ? 'bg-primary/20 hover:bg-primary/25'
                : ''
            "
            class="border-border/60 hover:bg-muted/60 absolute left-0 flex w-full items-center border-b"
            :style="{ height: `${item.size}px`, transform: `translateY(${item.start}px)` }"
            @click="selectRow(item.index)"
          >
            <table-cell
              class="text-muted-foreground flex w-[60px] shrink-0 items-center justify-center gap-1 border-r px-1 py-0"
              ><checkbox
                v-if="multiSelect"
                :aria-label="`勾选第 ${rows[item.index]!.index + 1} 行`"
                :model-value="selectedRows.includes(rows[item.index]!.index)"
                :disabled="disabled"
                @click.stop
                @update:model-value="(value) => toggleSelection(rows[item.index]!.index, value)"
              /><Button
                v-if="selectable"
                variant="ghost"
                size="icon-xs"
                :disabled="disabled"
                :aria-label="`选择第 ${rows[item.index]!.index + 1} 行`"
                @click="emit('select', rows[item.index]!.index)"
                >{{ rows[item.index]!.index + 1 }}</Button
              ><template v-else>{{ (rows[item.index]?.index || 0) + 1 }}</template></table-cell
            >
            <table-cell
              v-for="cell in rows[item.index]
                ?.getAllCells()
                .filter((cell) => !hidden.includes(cell.column.id))"
              :key="cell.id"
              :style="{ width: `${cell.column.getSize()}px` }"
              :class="[
                'group/cell flex shrink-0 items-center gap-1 border-r px-2 py-0',
                cell.getValue() === null ? 'text-muted-foreground italic' : '',
              ]"
              :title="String(cell.getValue() ?? 'NULL')"
              @dblclick="
                inspect(
                  String(cell.column.columnDef.header),
                  rows[item.index]!.index,
                  cell.getValue() as Cell,
                )
              "
              ><Button
                v-if="editableColumns?.includes(String(cell.column.columnDef.header))"
                variant="ghost"
                class="h-8 min-w-0 flex-1 justify-start gap-2 px-0 font-mono text-xs"
                :disabled="disabled"
                :aria-label="`编辑 ${cell.column.columnDef.header} 第 ${rows[item.index]!.index + 1} 行`"
                @click="
                  emit(
                    'edit',
                    rows[item.index]!.index,
                    String(cell.column.columnDef.header),
                    cell.getValue() as Cell,
                  )
                "
                ><span class="truncate">{{
                  cell.getValue() === null ? 'NULL' : cell.getValue()
                }}</span
                ><pencil :size="10" class="text-muted-foreground ml-auto shrink-0" /></Button
              ><span v-else class="min-w-0 flex-1 truncate">{{
                cell.getValue() === null ? 'NULL' : cell.getValue()
              }}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                class="size-6 shrink-0 opacity-0 group-hover/cell:opacity-100 focus:opacity-100"
                :aria-label="`查看 ${cell.column.columnDef.header} 第 ${rows[item.index]!.index + 1} 行`"
                @click.stop="
                  inspect(
                    String(cell.column.columnDef.header),
                    rows[item.index]!.index,
                    cell.getValue() as Cell,
                  )
                "
                ><eye class="size-3" /></Button
            ></table-cell>
          </table-row>
        </table-body>
      </Table>
      <p v-if="!result.rows.length" class="text-muted-foreground p-10 text-center">
        {{
          result.columns.length ? '查询未返回数据' : `执行成功 · ${result.affectedRows} 行受到影响`
        }}
      </p>
    </div>
    <Dialog v-model:open="columnSettings"
      ><dialog-content class="flex max-h-[80vh] flex-col"
        ><dialog-header
          ><dialog-title>显示列</dialog-title
          ><dialog-description
            >只改变当前表格的显示；复制和导出仍包含全部结果列。</dialog-description
          ></dialog-header
        >
        <Input v-model="columnSearch" aria-label="搜索结果列" placeholder="搜索列名" />
        <Button variant="outline" @click="hidden = []">显示全部列</Button>
        <div class="min-h-0 space-y-2 overflow-auto">
          <div v-for="column in columnChoices" :key="column.id" class="flex items-center gap-2">
            <checkbox
              :aria-label="`显示第 ${Number(column.id) + 1} 列 ${column.name}`"
              :model-value="!hidden.includes(column.id)"
              :disabled="!hidden.includes(column.id) && leafColumns.length === 1"
              @update:model-value="(value) => toggleColumn(column.id, value)"
            /><span class="min-w-0 text-sm break-all"
              >{{ Number(column.id) + 1 }}. {{ column.name || '（未命名）' }}</span
            >
          </div>
          <p v-if="!columnChoices.length" class="text-muted-foreground text-sm">没有匹配的列</p>
        </div>
      </dialog-content></Dialog
    >
    <Dialog v-model:open="detailOpen"
      ><dialog-content class="flex max-h-[85vh] flex-col sm:max-w-3xl"
        ><dialog-header
          ><dialog-title>单元格详情</dialog-title
          ><dialog-description
            >{{ detail?.column }} · 第 {{ (detail?.row ?? 0) + 1 }} 行 ·
            {{
              detail?.value === null
                ? 'NULL'
                : { string: '文本', number: '数字', boolean: '布尔值', undefined: '' }[
                    typeof detail?.value as 'string' | 'number' | 'boolean' | 'undefined'
                  ]
            }}
            · {{ String(detail?.value ?? '').length }} 个字符</dialog-description
          ></dialog-header
        >
        <pre
          aria-label="单元格原值"
          class="bg-muted min-h-0 overflow-auto rounded-md border p-3 font-mono text-sm break-all whitespace-pre-wrap"
          >{{ detail?.value === null ? 'NULL' : detail?.value }}</pre>
        <Button class="gap-2 self-end" :disabled="copying" @click="copyCell"
          ><Copy class="size-4" />复制原值</Button
        >
      </dialog-content></Dialog
    >
  </div>
</template>
