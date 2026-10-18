<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import ResultTable from './result-table.vue'
import SchemaColumnEditor from './schema-column-editor.vue'
import SchemaForeignKeyEditor from './schema-foreign-key-editor.vue'
import ErDiagramDialog from './er-diagram-dialog.vue'
import StructureCompareDialog from './structure-compare-dialog.vue'
const compareOpen = ref(false)
const erOpen = ref(false)
import type { DataTable, Session, SchemaInfo, SchemaRequest } from '../../../shared/contracts'
const props = defineProps<{ session: Session; table: DataTable; closed: boolean }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ busy: [value: boolean] }>()
const info = ref<SchemaInfo>(),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  tab = ref('indexes'),
  name = ref(''),
  unique = ref(false),
  fields = ref<{ name: string; descending: boolean }[]>([]),
  creating = ref(false)
const preview = ref<{ token: string; sql: string }>()
let mounted = true
function setBusy(value: boolean) {
  busy.value = value
  emit('busy', value)
}
async function load() {
  if (busy.value || props.closed) return
  setBusy(true)
  error.value = ''
  try {
    const response = await window.vork.schemaRequest(props.session.id, {
      kind: 'inspect',
      table: { ...props.table },
    })
    if (mounted && response.kind === 'schema') info.value = response
  } catch (e) {
    if (mounted) error.value = (e as Error).message
  } finally {
    if (mounted) setBusy(false)
  }
}
watch(
  open,
  (value) => {
    if (value) {
      info.value = undefined
      preview.value = undefined
      creating.value = false
      notice.value = ''
      tab.value = 'indexes'
      void load()
    }
  },
  { immediate: true },
)
watch(
  [name, unique, fields],
  () => {
    preview.value = undefined
  },
  { deep: true },
)
watch(tab, () => {
  preview.value = undefined
  creating.value = false
})
function startCreate() {
  creating.value = true
  name.value = 'idx_' + props.table.name
  fields.value = []
  unique.value = false
  preview.value = undefined
  error.value = ''
}
function toggle(column: string, checked: boolean | 'indeterminate') {
  fields.value =
    checked === true
      ? [...fields.value, { name: column, descending: false }]
      : fields.value.filter((field) => field.name !== column)
}
function move(index: number, delta: number) {
  const next = [...fields.value]
  const field = next.splice(index, 1)[0]!
  next.splice(index + delta, 0, field)
  fields.value = next
}
async function prepare(request: SchemaRequest) {
  if (busy.value || props.closed) return
  setBusy(true)
  error.value = ''
  notice.value = ''
  try {
    const response = await window.vork.schemaRequest(props.session.id, request)
    if (mounted && response.kind === 'schema-preview') preview.value = response
  } catch (e) {
    if (mounted) error.value = (e as Error).message
  } finally {
    if (mounted) setBusy(false)
  }
}
function create() {
  void prepare({
    kind: 'preview-create-index',
    table: { ...props.table },
    name: name.value,
    unique: unique.value,
    columns: fields.value.map((field) => ({ ...field })),
  })
}
function drop(index: string) {
  creating.value = false
  void prepare({ kind: 'preview-drop-index', table: { ...props.table }, name: index })
}
async function commit() {
  if (!preview.value || busy.value || props.closed) return
  setBusy(true)
  error.value = ''
  let applied = false
  try {
    await window.vork.schemaRequest(props.session.id, {
      kind: 'commit',
      token: preview.value.token,
    })
    applied = true
    notice.value = '结构变更已执行'
    creating.value = false
  } catch (e) {
    if (mounted) error.value = (e as Error).message
  } finally {
    preview.value = undefined
    if (mounted) setBusy(false)
  }
  if (applied && mounted) await load()
}
onBeforeUnmount(() => {
  mounted = false
  emit('busy', false)
})
</script>
<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!busy) open = value
      }
    "
    ><dialog-content :show-close-button="!busy" class="flex h-[85vh] flex-col sm:max-w-[90vw]"
      ><dialog-header
        ><dialog-title>结构管理 · {{ table.schema }}.{{ table.name }}</dialog-title
        ><dialog-description
          >查看与编辑字段、索引，查看外键与触发器。结构变更需预览确认，可能锁表、转换数据或删除列数据；沿用当前连接事务状态，MySQL
          DDL 可能隐式提交。</dialog-description
        ></dialog-header
      >
      <div class="flex items-center justify-between gap-3">
        <tabs v-model="tab"
          ><tabs-list
            ><tabs-trigger value="columns">字段</tabs-trigger
            ><tabs-trigger value="indexes">索引</tabs-trigger
            ><tabs-trigger value="foreignKeys">外键</tabs-trigger
            ><tabs-trigger value="triggers">触发器</tabs-trigger></tabs-list
          ></tabs
        >
        <div class="flex gap-2">
          <Button variant="outline" :disabled="busy || closed" @click="compareOpen = true"
            >结构对比</Button
          >
          <Button variant="outline" :disabled="busy || closed" @click="erOpen = true"
            >ER 关系图</Button
          >
          <Button variant="outline" :disabled="busy || closed" @click="load">刷新结构</Button
          ><Button
            v-if="tab === 'indexes'"
            :disabled="busy || closed || !info?.canCreateIndex"
            @click="startCreate"
            >新建索引</Button
          >
        </div>
      </div>
      <alert v-if="error" variant="destructive"
        ><alert-description>{{ error }}</alert-description></alert
      ><alert v-if="notice"
        ><alert-description>{{ notice }}</alert-description></alert
      >
      <schema-column-editor
        v-if="tab === 'columns' && info"
        class="min-h-0 flex-1"
        :table="table"
        :info="info"
        :dialect="session.type"
        :busy="busy"
        :closed="closed"
        @preview="prepare"
        @invalidate="preview = undefined"
      />
      <div v-else-if="tab === 'indexes'" class="min-h-0 flex-1 space-y-3 overflow-auto">
        <div v-if="creating" class="space-y-3 rounded-md border p-4">
          <div class="flex items-center gap-3">
            <Input
              v-model="name"
              aria-label="索引名称"
              placeholder="索引名称"
              :disabled="busy"
            /><Label class="flex shrink-0 items-center gap-2 text-sm"
              ><checkbox v-model="unique" :disabled="busy" />唯一索引</Label
            >
          </div>
          <p class="text-muted-foreground text-xs">勾选字段，按选择顺序创建复合索引。</p>
          <div class="flex flex-wrap gap-3">
            <Label
              v-for="column in info?.columns"
              :key="column"
              class="flex items-center gap-2 text-sm"
              ><checkbox
                :aria-label="`索引字段 ${column}`"
                :model-value="fields.some((field) => field.name === column)"
                :disabled="busy"
                @update:model-value="(value) => toggle(column, value)"
              />{{ column }}</Label
            >
          </div>
          <div
            v-for="(field, index) in fields"
            :key="field.name"
            class="flex items-center gap-3 text-sm"
          >
            <span class="min-w-0 flex-1 truncate">{{ index + 1 }}. {{ field.name }}</span
            ><Label class="flex items-center gap-2"
              ><checkbox v-model="field.descending" :disabled="busy" />降序</Label
            ><Button
              variant="ghost"
              size="sm"
              :aria-label="`上移索引字段 ${field.name}`"
              :disabled="busy || index === 0"
              @click="move(index, -1)"
              >上移</Button
            ><Button
              variant="ghost"
              size="sm"
              :aria-label="`下移索引字段 ${field.name}`"
              :disabled="busy || index === fields.length - 1"
              @click="move(index, 1)"
              >下移</Button
            >
          </div>
          <Button
            variant="outline"
            :disabled="busy || closed || !name.trim() || !fields.length"
            @click="create"
            >预览创建索引</Button
          >
        </div>
        <div v-for="index in info?.indexes" :key="index.name" class="rounded-md border p-4">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <p class="truncate font-medium">
                {{ index.name }}
                <span class="text-muted-foreground text-xs"
                  >{{ index.unique ? '唯一索引' : '普通索引'
                  }}{{ index.protected ? ' · 主键/约束维护' : '' }}</span
                >
              </p>
              <p class="mt-1 text-xs">{{ index.columns.join(', ') }}</p>
            </div>
            <Button
              variant="outline"
              :aria-label="`删除索引 ${index.name}`"
              :disabled="busy || closed || index.protected"
              @click="drop(index.name)"
              >删除</Button
            >
          </div>
          <pre class="mt-2 overflow-auto text-xs break-all whitespace-pre-wrap">{{
            index.definition
          }}</pre>
        </div>
        <p v-if="info && !info.indexes.length" class="text-muted-foreground p-4 text-sm">
          暂无索引
        </p>
      </div>
      <schema-foreign-key-editor
        v-else-if="tab === 'foreignKeys' && info"
        class="min-h-0 flex-1"
        :session="session"
        :table="table"
        :info="info"
        :busy="busy"
        :closed="closed"
        @busy="setBusy"
        @preview="prepare"
        @invalidate="preview = undefined"
      />
      <div v-else-if="info" class="min-h-0 flex-1 rounded-md border">
        <result-table :result="info.triggers" />
      </div>
      <div
        v-if="preview"
        role="region"
        aria-label="结构变更预览"
        class="flex max-h-64 min-h-0 shrink-0 flex-col gap-3 rounded-md border p-4"
      >
        <p class="shrink-0 text-sm font-medium">待执行结构变更</p>
        <pre class="min-h-0 flex-1 overflow-auto text-xs break-all whitespace-pre-wrap">{{
          preview.sql
        }}</pre>
        <div class="flex shrink-0 justify-end gap-2">
          <Button variant="outline" :disabled="busy" @click="preview = undefined">取消变更</Button
          ><Button :disabled="busy || closed" @click="commit">确认执行结构变更</Button>
        </div>
      </div>
      <p v-if="busy" class="text-muted-foreground text-xs">正在读取或执行，请稍候…</p>
    </dialog-content></Dialog
  >
  <er-diagram-dialog
    v-model:open="erOpen"
    :session="session"
    :table="table"
    :closed="closed"
    @busy="setBusy"
  />
  <structure-compare-dialog
    v-model:open="compareOpen"
    :session="session"
    :table="table"
    :closed="closed"
    @busy="setBusy"
  />
</template>
