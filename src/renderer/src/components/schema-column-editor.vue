<script setup lang="ts">
import { computed, ref, watch, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import ResultTable from './result-table.vue'
import type { DataTable, SchemaInfo, SchemaRequest, ColumnDefault } from '../../../shared/contracts'
const props = defineProps<{
  table: DataTable
  info: SchemaInfo
  busy: boolean
  closed: boolean
  dialect: string
}>()
const emit = defineEmits<{ preview: [request: SchemaRequest]; invalidate: [] }>()
type Action = 'none' | 'add' | 'rename' | 'drop' | 'default' | 'type' | 'nullable'
const action = ref<Action>('none'),
  column = ref(''),
  name = ref(''),
  type = ref('TEXT'),
  nullable = ref(true),
  defaultMode = ref('none'),
  defaultValue = ref(''),
  error = ref(''),
  convert = ref(false)
const formTitle = computed(
  () =>
    ({
      none: '',
      add: '新增字段',
      rename: '重命名字段',
      drop: '删除字段',
      default: '修改默认值',
      type: '修改字段类型',
      nullable: '修改可空约束',
    })[action.value] + (action.value === 'add' ? '' : ' ' + column.value),
)
const id = useId()
const canEdit = computed(() => ['table', 'partitioned-table'].includes(props.info.objectKind))
const disabled = computed(() => props.busy || props.closed)
function metadata(field: string) {
  const sqlite = props.dialect === 'sqlite'
  const row = props.info.columnInfo.rows.find((row) => row[sqlite ? 1 : 0] === field)
  return row
    ? {
        type: String(row[sqlite ? 2 : 1]),
        nullable: sqlite ? !row[3] : row[2] === 'YES',
        defaultValue: row[sqlite ? 4 : 3],
      }
    : undefined
}
const currentColumn = computed(() => metadata(column.value))
watch([name, type, nullable, defaultMode, defaultValue, convert], () => {
  emit('invalidate')
  error.value = ''
})
watch(
  () => props.info,
  () => {
    action.value = 'none'
    error.value = ''
  },
)
function start(mode: Exclude<Action, 'none'>, field = '') {
  action.value = mode
  column.value = field
  name.value = mode === 'rename' ? field : ''
  const original = metadata(field)
  type.value = original?.type || 'TEXT'
  nullable.value = original?.nullable ?? true
  convert.value = false
  defaultMode.value = 'none'
  defaultValue.value = ''
  error.value = ''
  emit('invalidate')
}
function prepare() {
  if (disabled.value) return
  error.value = ''
  const table = { ...props.table }
  if (action.value === 'rename') {
    emit('preview', {
      kind: 'preview-rename-column',
      table,
      column: column.value,
      name: name.value,
    })
    return
  }
  if (action.value === 'drop') {
    emit('preview', { kind: 'preview-drop-column', table, name: column.value })
    return
  }
  if (action.value === 'type') {
    emit('preview', {
      kind: 'preview-column-type',
      table,
      name: column.value,
      type: type.value,
      convert: convert.value,
    })
    return
  }
  if (action.value === 'nullable') {
    emit('preview', {
      kind: 'preview-column-nullable',
      table,
      name: column.value,
      nullable: nullable.value,
    })
    return
  }
  if (action.value !== 'add' && action.value !== 'default') return
  let option: ColumnDefault | undefined
  try {
    if (defaultMode.value === 'null') option = { kind: 'value', value: null }
    else if (defaultMode.value === 'text') option = { kind: 'value', value: defaultValue.value }
    else if (defaultMode.value === 'number') {
      const value = Number(defaultValue.value)
      if (
        !defaultValue.value.trim() ||
        !Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value))
      )
        throw new Error('请输入有效数字，大整数请使用文本默认值')
      option = { kind: 'value', value }
    } else if (defaultMode.value === 'boolean') {
      if (!['true', 'false'].includes(defaultValue.value))
        throw new Error('布尔值请输入 true 或 false')
      option = { kind: 'value', value: defaultValue.value === 'true' }
    } else if (['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME'].includes(defaultMode.value))
      option = {
        kind: 'expression',
        expression: defaultMode.value as 'CURRENT_TIMESTAMP' | 'CURRENT_DATE' | 'CURRENT_TIME',
      }
    if (action.value === 'default') {
      emit('preview', {
        kind: 'preview-column-default',
        table,
        name: column.value,
        ...(option ? { default: option } : {}),
      })
      return
    }
    emit('preview', {
      kind: 'preview-add-column',
      table,
      name: name.value,
      type: type.value,
      nullable: nullable.value,
      ...(option ? { default: option } : {}),
    })
  } catch (e) {
    error.value = (e as Error).message
  }
}
</script>
<template>
  <div class="flex h-full min-h-0 flex-col gap-3">
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <Button :disabled="disabled || !canEdit" @click="start('add')">新增字段</Button>
      <span class="text-muted-foreground text-xs"
        >删除字段会永久移除该列数据；数据库可能调整依赖索引，不使用 CASCADE。</span
      >
    </div>
    <div v-if="action !== 'none'" class="shrink-0 space-y-3 rounded-md border p-3">
      <p class="text-sm font-medium">{{ formTitle }}</p>
      <p
        v-if="['default', 'type', 'nullable'].includes(action)"
        class="text-muted-foreground text-xs"
      >
        当前类型：{{ currentColumn?.type }} · 可空：{{ currentColumn?.nullable ? '是' : '否' }} ·
        默认值：{{ currentColumn?.defaultValue ?? '未设置 / NULL' }}
      </p>
      <div v-if="action === 'add' || action === 'rename'" class="flex flex-wrap gap-3">
        <Label class="grid min-w-48 flex-1 gap-2"
          >字段名称<Input v-model="name" aria-label="字段名称" :disabled="disabled"
        /></Label>
        <template v-if="action === 'add'">
          <Label class="grid min-w-48 flex-1 gap-2"
            >字段类型<Input
              v-model="type"
              aria-label="字段类型"
              placeholder="例如 VARCHAR(255)、INTEGER"
              :disabled="disabled"
          /></Label>
          <div class="flex items-end gap-2 pb-2">
            <checkbox :id="id" v-model="nullable" :disabled="disabled" /><Label :for="id"
              >允许 NULL</Label
            >
          </div>
        </template>
      </div>
      <Label v-if="action === 'type'" class="grid gap-2"
        >字段类型<Input v-model="type" aria-label="字段类型" :disabled="disabled"
      /></Label>
      <div
        v-if="action === 'type' && ['postgresql', 'sqlite'].includes(dialect)"
        class="flex items-center gap-2"
      >
        <checkbox
          :id="id + '-convert'"
          v-model="convert"
          aria-label="显式类型转换"
          :disabled="disabled"
        /><Label :for="id + '-convert'">{{
          dialect === 'sqlite' ? '显式转换现有值（CAST）' : '显式转换现有值（USING 字段::目标类型）'
        }}</Label>
      </div>
      <div v-if="action === 'nullable'" class="flex items-center gap-2">
        <checkbox
          :id="id + '-nullable'"
          v-model="nullable"
          aria-label="字段允许 NULL"
          :disabled="disabled"
        /><Label :for="id + '-nullable'">允许 NULL</Label>
      </div>
      <div v-if="action === 'add' || action === 'default'" class="flex flex-wrap items-end gap-3">
        <Label class="grid gap-2"
          >默认值类型<Select v-model="defaultMode" :disabled="disabled"
            ><select-trigger aria-label="字段默认值类型" class="w-52"
              ><select-value /></select-trigger
            ><select-content>
              <select-item value="none">{{
                action === 'default' ? '移除默认值' : '不设置默认值'
              }}</select-item
              ><select-item value="text">文本</select-item
              ><select-item value="number">数字</select-item
              ><select-item value="boolean">布尔值</select-item
              ><select-item value="null">NULL</select-item
              ><select-item value="CURRENT_TIMESTAMP">当前时间戳</select-item
              ><select-item value="CURRENT_DATE">当前日期</select-item
              ><select-item value="CURRENT_TIME">当前时间</select-item>
            </select-content></Select
          ></Label
        >
        <Label
          v-if="['text', 'number', 'boolean'].includes(defaultMode)"
          class="grid min-w-48 flex-1 gap-2"
          >默认值<Input v-model="defaultValue" aria-label="字段默认值" :disabled="disabled"
        /></Label>
      </div>
      <alert v-if="error" variant="destructive"
        ><alert-description>{{ error }}</alert-description></alert
      >
      <Button
        variant="outline"
        :disabled="disabled || (['add', 'rename'].includes(action) && !name.trim())"
        @click="prepare"
        >预览字段变更</Button
      >
    </div>
    <p v-if="dialect === 'sqlite'" class="text-muted-foreground text-xs">
      SQLite
      修改使用事务性重建表；会校验原值、行数和外键，并恢复索引与触发器。请先提交或回滚当前事务。
    </p>
    <div class="min-h-0 flex-1 space-y-3 overflow-auto">
      <div class="divide-y rounded-md border">
        <div
          v-for="field in info.columns"
          :key="field"
          class="flex items-center justify-between gap-3 px-3 py-2"
        >
          <span class="min-w-0 truncate font-mono text-sm">{{ field }}</span>
          <div class="flex shrink-0 gap-2">
            <Button
              variant="ghost"
              size="sm"
              :aria-label="`修改字段类型 ${field}`"
              :disabled="disabled || !canEdit"
              @click="start('type', field)"
              >类型</Button
            ><Button
              variant="ghost"
              size="sm"
              :aria-label="`修改字段默认值 ${field}`"
              :disabled="disabled || !canEdit"
              @click="start('default', field)"
              >默认值</Button
            ><Button
              variant="ghost"
              size="sm"
              :aria-label="`修改字段可空 ${field}`"
              :disabled="disabled || !canEdit"
              @click="start('nullable', field)"
              >可空</Button
            >

            <Button
              variant="ghost"
              size="sm"
              :aria-label="`重命名字段 ${field}`"
              :disabled="disabled || !canEdit"
              @click="start('rename', field)"
              >重命名</Button
            ><Button
              variant="ghost"
              size="sm"
              class="text-destructive"
              :aria-label="`删除字段 ${field}`"
              :disabled="disabled || !canEdit || info.columns.length <= 1"
              @click="start('drop', field)"
              >删除</Button
            >
          </div>
        </div>
      </div>
      <div class="h-64 rounded-md border"><result-table :result="info.columnInfo" /></div>
    </div>
  </div>
</template>
