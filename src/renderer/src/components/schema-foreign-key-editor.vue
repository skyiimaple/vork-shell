<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type {
  DataTable,
  Session,
  SchemaInfo,
  SchemaRequest,
  SchemaForeignKey,
  ForeignKeyRule,
} from '../../../shared/contracts'
const props = defineProps<{
  session: Session
  table: DataTable
  info: SchemaInfo
  busy: boolean
  closed: boolean
}>()
const emit = defineEmits<{
  preview: [request: SchemaRequest]
  invalidate: []
  busy: [value: boolean]
}>()
const keys = ref<SchemaForeignKey[]>([]),
  creating = ref(false),
  loading = ref(false),
  error = ref(''),
  name = ref(''),
  targetSchema = ref(''),
  targetName = ref(''),
  targetColumns = ref<string[]>([]),
  fields = ref<{ column: string; target: string }[]>([]),
  onUpdate = ref('NO ACTION'),
  onDelete = ref('NO ACTION')
const rules = computed(() => [
  { value: 'NO ACTION', name: '不操作（NO ACTION）' },
  { value: 'RESTRICT', name: '限制（RESTRICT）' },
  { value: 'CASCADE', name: '级联（CASCADE）' },
  { value: 'SET NULL', name: '置空（SET NULL）' },
  ...(props.session.type === 'mysql'
    ? []
    : [{ value: 'SET DEFAULT', name: '默认值（SET DEFAULT）' }]),
])
const disabled = computed(() => props.busy || loading.value || props.closed)
const canEdit = computed(() => ['table', 'partitioned-table'].includes(props.info.objectKind))
let currentInfo: SchemaInfo | undefined,
  mounted = true
function setLoading(value: boolean) {
  loading.value = value
  emit('busy', value)
}
async function load() {
  if (loading.value || props.closed) return
  setLoading(true)
  error.value = ''
  try {
    const response = await window.vork.schemaRequest(props.session.id, {
      kind: 'foreign-keys',
      table: { ...props.table },
    })
    if (mounted && response.kind === 'foreign-keys') keys.value = response.keys
  } catch (e) {
    if (mounted) error.value = (e as Error).message
  } finally {
    if (mounted) setLoading(false)
  }
}
watch(
  () => [props.info, props.busy] as const,
  ([info, busy]) => {
    if (!busy && info !== currentInfo) {
      currentInfo = info
      creating.value = false
      void load()
    }
  },
  { immediate: true },
)
watch([name, targetSchema, targetName, onUpdate, onDelete, fields], () => emit('invalidate'), {
  deep: true,
})
watch([targetSchema, targetName], () => {
  targetColumns.value = []
  fields.value = []
})
function start() {
  creating.value = true
  name.value = 'fk_' + props.table.name + '_ref'
  targetSchema.value = props.table.schema
  targetName.value = ''
  targetColumns.value = []
  fields.value = []
  onUpdate.value = 'NO ACTION'
  onDelete.value = 'NO ACTION'
  error.value = ''
  emit('invalidate')
}
async function readTarget() {
  if (disabled.value || !targetSchema.value.trim() || !targetName.value.trim()) return
  setLoading(true)
  error.value = ''
  emit('invalidate')
  try {
    const response = await window.vork.schemaRequest(props.session.id, {
      kind: 'inspect',
      table: { schema: targetSchema.value, name: targetName.value },
    })
    if (mounted && response.kind === 'schema') {
      targetColumns.value = [...response.columns]
      fields.value = [{ column: '', target: '' }]
    }
  } catch (e) {
    if (mounted) error.value = (e as Error).message
  } finally {
    if (mounted) setLoading(false)
  }
}
function prepare() {
  if (disabled.value) return
  emit('preview', {
    kind: 'preview-create-foreign-key',
    table: { ...props.table },
    name: name.value,
    columns: fields.value.map((field) => field.column),
    reference: { schema: targetSchema.value, name: targetName.value },
    referenceColumns: fields.value.map((field) => field.target),
    onUpdate: onUpdate.value as ForeignKeyRule,
    onDelete: onDelete.value as ForeignKeyRule,
  })
}
function drop(key: string) {
  creating.value = false
  emit('preview', { kind: 'preview-drop-foreign-key', table: { ...props.table }, key })
}
onBeforeUnmount(() => {
  mounted = false
  emit('busy', false)
})
</script>
<template>
  <div class="flex h-full min-h-0 flex-col gap-3">
    <div class="flex shrink-0 items-center gap-3">
      <Button :disabled="disabled || !canEdit" @click="start">新建外键</Button
      ><span class="text-muted-foreground text-xs"
        >创建会校验已有数据；删除只移除约束。级联规则影响后续写入。</span
      >
    </div>
    <alert v-if="error" variant="destructive"
      ><alert-description>{{ error }}</alert-description></alert
    >
    <div class="min-h-0 flex-1 space-y-3 overflow-auto">
      <div v-if="creating" class="space-y-3 rounded-md border p-3">
        <Label class="grid gap-2"
          >外键名称<Input v-model="name" aria-label="外键名称" :disabled="disabled"
        /></Label>
        <div class="flex flex-wrap items-end gap-3">
          <Label class="grid min-w-36 flex-1 gap-2"
            >目标数据库 / Schema<Input
              v-model="targetSchema"
              aria-label="外键目标 Schema"
              :disabled="disabled" /></Label
          ><Label class="grid min-w-48 flex-1 gap-2"
            >目标表<Input
              v-model="targetName"
              aria-label="外键目标表"
              :disabled="disabled" /></Label
          ><Button
            variant="outline"
            :disabled="disabled || !targetSchema.trim() || !targetName.trim()"
            @click="readTarget"
            >读取目标字段</Button
          >
        </div>
        <div
          v-for="(field, index) in fields"
          :key="index"
          class="flex flex-wrap items-center gap-2"
        >
          <span class="text-muted-foreground text-xs">{{ index + 1 }}.</span>
          <Select v-model="field.column" :disabled="disabled"
            ><select-trigger :aria-label="`外键源字段 ${index + 1}`" class="min-w-40 flex-1"
              ><select-value placeholder="本表字段" /></select-trigger
            ><select-content
              ><select-item v-for="column in info.columns" :key="column" :value="column">{{
                column
              }}</select-item></select-content
            ></Select
          >
          <span class="text-muted-foreground">→</span>
          <Select v-model="field.target" :disabled="disabled"
            ><select-trigger :aria-label="`外键目标字段 ${index + 1}`" class="min-w-40 flex-1"
              ><select-value placeholder="目标字段" /></select-trigger
            ><select-content
              ><select-item v-for="column in targetColumns" :key="column" :value="column">{{
                column
              }}</select-item></select-content
            ></Select
          >
          <Button
            variant="ghost"
            size="sm"
            :disabled="disabled"
            :aria-label="`移除外键映射 ${index + 1}`"
            @click="fields.splice(index, 1)"
            >移除</Button
          >
        </div>
        <Button
          v-if="targetColumns.length"
          variant="outline"
          size="sm"
          :disabled="disabled || fields.length >= 32"
          @click="fields.push({ column: '', target: '' })"
          >添加字段映射</Button
        >
        <div class="flex flex-wrap gap-3">
          <Label class="grid gap-2"
            >更新规则<Select v-model="onUpdate" :disabled="disabled"
              ><select-trigger aria-label="外键更新规则" class="w-56"
                ><select-value /></select-trigger
              ><select-content
                ><select-item v-for="rule in rules" :key="rule.value" :value="rule.value">{{
                  rule.name
                }}</select-item></select-content
              ></Select
            ></Label
          ><Label class="grid gap-2"
            >删除规则<Select v-model="onDelete" :disabled="disabled"
              ><select-trigger aria-label="外键删除规则" class="w-56"
                ><select-value /></select-trigger
              ><select-content
                ><select-item v-for="rule in rules" :key="rule.value" :value="rule.value">{{
                  rule.name
                }}</select-item></select-content
              ></Select
            ></Label
          >
        </div>
        <Button
          variant="outline"
          :disabled="
            disabled ||
            !name.trim() ||
            !fields.length ||
            fields.some((field) => !field.column || !field.target)
          "
          @click="prepare"
          >预览创建外键</Button
        >
      </div>
      <div v-for="key in keys" :key="key.key" class="space-y-2 rounded-md border p-3">
        <div class="flex items-center justify-between gap-3">
          <p class="min-w-0 truncate text-sm font-medium">{{ key.name }}</p>
          <Button
            variant="outline"
            size="sm"
            :aria-label="`删除外键 ${key.name}`"
            :disabled="disabled || !canEdit || !key.droppable"
            @click="drop(key.key)"
            >删除</Button
          >
        </div>
        <p class="font-mono text-xs break-all">
          ({{ key.fromColumns.join(', ') }}) → {{ key.to.schema }}.{{ key.to.name }} ({{
            key.toColumns.join(', ')
          }})
        </p>
        <p class="text-muted-foreground text-xs">
          更新：{{ key.onUpdate }} · 删除：{{ key.onDelete
          }}{{ key.droppable ? '' : ' · 原定义无法可靠解析，仅支持查看' }}
        </p>
        <pre v-if="key.definition" class="text-xs break-all whitespace-pre-wrap">{{
          key.definition
        }}</pre>
      </div>
      <p v-if="!keys.length && !loading" class="text-muted-foreground p-4 text-sm">暂无外键</p>
    </div>
  </div>
</template>
