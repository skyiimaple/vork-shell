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
import { Pencil } from '@lucide/vue'
import type { QueryResult, Cell } from '../../../shared/contracts'
const props = defineProps<{
  result: QueryResult
  editableColumns?: string[]
  disabled?: boolean
  serverSorting?: boolean
  sort?: { column: string; descending: boolean }
}>()
const emit = defineEmits<{
  edit: [rowIndex: number, column: string, value: Cell]
  sort: [column: string]
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
const selectedRow = ref<string>()
watch(
  () => props.result,
  () => {
    selectedRow.value = undefined
  },
)
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
const leafColumns = computed(() => table.getAllLeafColumns())
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
const width = computed(() => table.getTotalSize() + 60)
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
  () => props.result.columns.join('\0'),
  () => table.resetColumnSizing(true),
)
onBeforeUnmount(() => stopResize?.())
</script>
<template>
  <div ref="scroll" class="scroll-area h-full overflow-auto font-mono text-xs">
    <Table
      container-class="overflow-visible"
      class="block text-xs"
      :style="{ width: `${width}px`, minWidth: '100%' }"
      :aria-rowcount="rows.length + 1"
      :aria-colcount="result.columns.length + 1"
    >
      <table-header class="bg-sidebar text-muted-foreground sticky top-0 z-10 block"
        ><table-row class="flex h-10 hover:bg-transparent"
          ><table-head class="flex h-full w-[60px] shrink-0 items-center border-r px-4"
            >#</table-head
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
          :aria-selected="selectedRow === rows[item.index]?.id"
          :class="selectedRow === rows[item.index]?.id ? 'bg-primary/20 hover:bg-primary/25' : ''"
          class="border-border/60 hover:bg-muted/60 absolute left-0 flex w-full items-center border-b"
          :style="{ height: `${item.size}px`, transform: `translateY(${item.start}px)` }"
          @click="selectedRow = rows[item.index]?.id"
        >
          <table-cell class="text-muted-foreground block w-[60px] shrink-0 border-r px-4 py-0">{{
            (rows[item.index]?.index || 0) + 1
          }}</table-cell>
          <table-cell
            v-for="cell in rows[item.index]?.getAllCells()"
            :key="cell.id"
            :style="{ width: `${cell.column.getSize()}px` }"
            :class="[
              'block shrink-0 truncate border-r px-4 py-0',
              cell.getValue() === null ? 'text-muted-foreground italic' : '',
            ]"
            :title="String(cell.getValue() ?? 'NULL')"
            ><Button
              v-if="editableColumns?.includes(String(cell.column.columnDef.header))"
              variant="ghost"
              class="h-8 w-full justify-start gap-2 px-0 font-mono text-xs"
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
            ><template v-else>{{
              cell.getValue() === null ? 'NULL' : cell.getValue()
            }}</template></table-cell
          >
        </table-row>
      </table-body>
    </Table>
    <p v-if="!result.rows.length" class="text-muted-foreground p-10 text-center">
      {{
        result.columns.length ? '查询未返回数据' : `执行成功 · ${result.affectedRows} 行受到影响`
      }}
    </p>
  </div>
</template>
