<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { Session, DataTable, Cell, TableMutationPreview } from '../../../shared/contracts'
const props = defineProps<{
  session: Session
  table: DataTable
  columns: string[]
  action: 'insert' | 'delete' | 'delete-many' | 'update-many'
  snapshotId?: string
  rowIndex?: number
  rowIndices?: number[]
  closed: boolean
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  busy: [value: boolean]
  applied: [affectedRows: number, requestedRows?: number]
}>()
const fields = ref<{ column: string; mode: string; value: string }[]>([]),
  preview = ref<TableMutationPreview>(),
  busy = ref(false),
  error = ref(''),
  updateColumn = ref('')
const visibleFields = computed(() =>
  props.action === 'update-many'
    ? fields.value.filter((field) => field.column === updateColumn.value)
    : fields.value,
)
watch(updateColumn, () => {
  preview.value = undefined
})
watch(open, (value) => {
  if (value) {
    updateColumn.value = props.columns[0] || ''
    fields.value = props.columns.map((column) => ({
      column,
      mode: props.action === 'update-many' ? 'text' : 'default',
      value: '',
    }))
    preview.value = undefined
    error.value = ''
  }
})
watch(
  fields,
  () => {
    preview.value = undefined
  },
  { deep: true },
)
async function prepare() {
  error.value = ''
  busy.value = true
  emit('busy', true)
  try {
    const values: { column: string; value: Cell }[] = []
    if (props.action === 'insert' || props.action === 'update-many')
      for (const field of visibleFields.value.filter((field) => field.mode !== 'default')) {
        let value: Cell = field.value
        if (field.mode === 'null') value = null
        if (field.mode === 'number') {
          value = Number(field.value)
          if (
            !field.value.trim() ||
            !Number.isFinite(value) ||
            (Number.isInteger(value) && !Number.isSafeInteger(value))
          )
            throw new Error('数字无效，大整数请使用文本类型')
        }
        if (field.mode === 'boolean') {
          if (!['true', 'false'].includes(field.value))
            throw new Error('布尔值请输入 true 或 false')
          value = field.value === 'true'
        }
        values.push({ column: field.column, value })
      }
    if (props.action === 'update-many' && values.length !== 1)
      throw new Error('请选择一个可更新的字段并填写值')
    const response = await window.vork.tableRequest(
      props.session.id,
      props.action === 'insert'
        ? { kind: 'preview-insert', table: { ...props.table }, values }
        : props.action === 'update-many'
          ? {
              kind: 'preview-update-many',
              snapshotId: props.snapshotId!,
              rowIndices: [...(props.rowIndices || [])],
              column: values[0]!.column,
              value: values[0]!.value,
            }
          : props.action === 'delete-many'
            ? {
                kind: 'preview-delete-many',
                snapshotId: props.snapshotId!,
                rowIndices: [...(props.rowIndices || [])],
              }
            : { kind: 'preview-delete', snapshotId: props.snapshotId!, rowIndex: props.rowIndex! },
    )
    if (response.kind === 'mutation-preview') preview.value = response
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
    emit('busy', false)
  }
}
async function commit() {
  if (!preview.value || busy.value || props.closed) return
  busy.value = true
  emit('busy', true)
  error.value = ''
  let applied: { affectedRows: number; requestedRows?: number } | undefined
  try {
    const response = await window.vork.tableRequest(props.session.id, {
      kind: 'commit',
      token: preview.value.token,
    })
    if (response.kind !== 'edited') throw new Error('数据库未返回写入结果')
    applied = response
    open.value = false
  } catch (e) {
    error.value = (e as Error).message
    preview.value = undefined
  } finally {
    busy.value = false
    emit('busy', false)
  }
  if (applied) emit('applied', applied.affectedRows, applied.requestedRows)
}
</script>
<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!busy) open = value
      }
    "
    ><dialog-content :show-close-button="!busy" class="flex max-h-[85vh] flex-col sm:max-w-2xl"
      ><dialog-header
        ><dialog-title>{{
          action === 'insert'
            ? '新增行'
            : action === 'update-many'
              ? `确认批量更新 ${rowIndices?.length || 0} 行`
              : action === 'delete-many'
                ? `确认批量删除 ${rowIndices?.length || 0} 行`
                : '确认删除所选行'
        }}</dialog-title
        ><dialog-description
          >{{ table.schema }}.{{ table.name }} ·
          {{
            action === 'insert'
              ? '未填写的字段使用数据库默认值。'
              : '按主键及原行内容定位，变化的行跳过；外键级联或触发器可能影响关联数据。'
          }}预览后确认才会写入。</dialog-description
        ></dialog-header
      >
      <Select v-if="action === 'update-many'" v-model="updateColumn" :disabled="busy"
        ><select-trigger aria-label="批量更新字段"><select-value /></select-trigger
        ><select-content
          ><select-item v-for="column in columns" :key="column" :value="column">{{
            column
          }}</select-item></select-content
        ></Select
      >
      <div
        v-if="action === 'insert' || action === 'update-many'"
        class="min-h-0 space-y-3 overflow-auto"
      >
        <div
          v-for="field in visibleFields"
          :key="field.column"
          class="grid grid-cols-[minmax(80px,1fr)_130px_minmax(100px,2fr)] items-center gap-2"
        >
          <span class="truncate text-sm" :title="field.column">{{ field.column }}</span
          ><Select v-model="field.mode" :disabled="busy"
            ><select-trigger :aria-label="`新增字段类型 ${field.column}`"
              ><select-value /></select-trigger
            ><select-content
              ><select-item v-if="action === 'insert'" value="default">使用默认值</select-item
              ><select-item value="text">文本</select-item
              ><select-item value="number">数字</select-item
              ><select-item value="boolean">布尔值</select-item
              ><select-item value="null">NULL</select-item></select-content
            ></Select
          ><Input
            v-model="field.value"
            :aria-label="`新增字段值 ${field.column}`"
            :disabled="busy || ['default', 'null'].includes(field.mode)"
          />
        </div>
      </div>
      <div v-if="preview" class="min-h-0 space-y-2 overflow-auto rounded-md border p-3 text-xs">
        <p class="font-medium">待执行 SQL（参数单独绑定）</p>
        <pre class="break-all whitespace-pre-wrap">{{ preview.sql }}</pre>
        <pre class="break-all whitespace-pre-wrap">{{
          JSON.stringify(preview.parameters, null, 2)
        }}</pre>
      </div>
      <alert v-if="error" variant="destructive"
        ><alert-description>{{ error }}</alert-description></alert
      >
      <div class="flex justify-end gap-2">
        <Button variant="outline" :disabled="busy" @click="open = false">取消</Button
        ><Button v-if="!preview" :disabled="busy || closed" @click="prepare">预览 SQL</Button
        ><Button
          v-else
          :variant="action === 'delete' || action === 'delete-many' ? 'destructive' : 'default'"
          :disabled="busy || closed"
          @click="commit"
          >确认执行{{
            action === 'update-many' ? '更新' : action !== 'insert' ? '删除' : '新增'
          }}</Button
        >
      </div>
    </dialog-content></Dialog
  >
</template>
