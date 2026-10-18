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
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import ErCanvas from './er-canvas.vue'
import { entityKey } from '../../../shared/er-layout'
import type {
  DataTable,
  Session,
  ErDiagram,
  ErRelation,
  ErPositions,
  ErResponse,
} from '../../../shared/contracts'
const props = defineProps<{ session: Session; table: DataTable; closed: boolean }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ busy: [value: boolean] }>()
const schema = ref(''),
  search = ref(''),
  list = ref<string[]>([]),
  after = ref<string>(),
  cursor = ref(''),
  previous = ref<string[]>([]),
  chosen = ref<DataTable[]>([]),
  graph = ref<ErDiagram>(),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  full = ref(false),
  positions = ref<ErPositions>({}),
  selected = ref<DataTable>(),
  relation = ref<ErRelation>()
const selectedEntity = computed(() =>
  graph.value?.tables.find(
    (entity) => entityKey(entity.table) === entityKey(selected.value || { schema: '', name: '' }),
  ),
)
const dirty = computed(
  () =>
    graph.value &&
    JSON.stringify(chosen.value.map(entityKey).sort()) !==
      JSON.stringify(graph.value.tables.map((entity) => entityKey(entity.table)).sort()),
)
let mounted = true
function setBusy(value: boolean) {
  busy.value = value
  emit('busy', value)
}
async function tables(
  reset = false,
): Promise<Extract<ErResponse, { kind: 'er-tables' }> | undefined> {
  if (busy.value || props.closed) return
  if (reset) {
    cursor.value = ''
    previous.value = []
  }
  setBusy(true)
  error.value = ''
  try {
    const result = await window.vork.erRequest(props.session.id, {
      kind: 'tables',
      schema: schema.value,
      search: search.value,
      after: cursor.value,
    })
    if (mounted && result.kind === 'er-tables') {
      list.value = result.tables
      after.value = result.after
      return result
    }
  } catch (e) {
    if (mounted) error.value = (e as Error).message
  } finally {
    if (mounted) setBusy(false)
  }
}
async function generate() {
  if (busy.value || props.closed || !chosen.value.length || !open.value) return
  setBusy(true)
  error.value = ''
  notice.value = ''
  try {
    const result = await window.vork.erRequest(props.session.id, {
      kind: 'diagram',
      tables: chosen.value.map((table) => ({ ...table })),
    })
    if (mounted && result.kind === 'er-diagram') {
      graph.value = result
      relation.value = undefined
      if (!selected.value) selected.value = result.tables[0]?.table
    }
  } catch (e) {
    if (mounted) error.value = (e as Error).message
  } finally {
    if (mounted) setBusy(false)
  }
}
function toggle(table: DataTable, value: boolean | 'indeterminate') {
  if (value === true) {
    if (chosen.value.some((item) => entityKey(item) === entityKey(table))) return
    if (chosen.value.length >= 100) {
      error.value = '每张图最多100张表，请先移除部分表'
      return
    }
    chosen.value = [...chosen.value, { ...table }]
  } else chosen.value = chosen.value.filter((item) => entityKey(item) !== entityKey(table))
}
function selectAll() {
  if (
    new Set([
      ...chosen.value.map(entityKey),
      ...list.value.map((name) => entityKey({ schema: schema.value, name })),
    ]).size > 100
  ) {
    error.value = '本页加入后会超过100张表，请先缩小范围'
    return
  }
  for (const name of list.value) toggle({ schema: schema.value, name }, true)
}
async function stop() {
  try {
    await window.vork.cancel(props.session.id)
  } catch (e) {
    error.value = (e as Error).message
  }
}
function selectRelation(value: ErRelation) {
  relation.value = value
  selected.value = undefined
}
function select(table: DataTable) {
  selected.value = table
  relation.value = undefined
}
async function addRelated() {
  if (!graph.value) return
  const targets = graph.value.relations.flatMap((value) => [value.from, value.to])
  const all = new Map([...chosen.value, ...targets].map((table) => [entityKey(table), table]))
  if (all.size > 100) {
    error.value = '关联表加入后会超过100张，请分批查看'
    return
  }
  chosen.value = [...all.values()]
  await generate()
}
async function loadSelected() {
  if (selected.value) {
    toggle(selected.value, true)
    await generate()
  }
}
async function next() {
  if (!after.value) return
  previous.value.push(cursor.value)
  cursor.value = after.value
  await tables()
}
async function back() {
  cursor.value = previous.value.pop() || ''
  await tables()
}
async function exportSvg() {
  if (!graph.value || busy.value) return
  setBusy(true)
  error.value = ''
  try {
    const path = await window.vork.exportErSvg(
      props.session.id,
      graph.value.snapshotId,
      Object.fromEntries(
        Object.entries(positions.value).map(([key, point]) => [key, { x: point.x, y: point.y }]),
      ),
      full.value,
    )
    if (path) notice.value = '已导出：' + path
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    if (mounted) setBusy(false)
  }
}
watch(
  open,
  async (value) => {
    if (value) {
      schema.value = props.table.schema
      search.value = ''
      graph.value = undefined
      chosen.value = []
      selected.value = { ...props.table }
      relation.value = undefined
      notice.value = ''
      const page = await tables(true)
      if (!mounted || !open.value || !page) return
      chosen.value = page.after
        ? [{ ...props.table }]
        : page.tables.map((name) => ({ schema: schema.value, name }))
      if (!chosen.value.length) chosen.value = [{ ...props.table }]
      await generate()
    }
  },
  { immediate: true },
)
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
    ><dialog-content :show-close-button="!busy" class="flex h-[90vh] flex-col sm:max-w-[96vw]"
      ><dialog-header
        ><dialog-title>ER 关系图</dialog-title
        ><dialog-description
          >读取真实字段和外键，不修改结构。箭头指向被引用的表；虚线卡片表示字段未加载。</dialog-description
        ></dialog-header
      >
      <div class="flex shrink-0 flex-wrap items-center gap-2">
        <Button v-if="busy" variant="outline" @click="stop">停止并断开</Button>
        <Button :disabled="busy || closed || !chosen.length" @click="generate"
          >生成关系图（{{ chosen.length }} 张表）</Button
        ><Button variant="outline" :disabled="busy || closed || !graph" @click="addRelated"
          >加入关联表</Button
        ><Label class="ml-2 flex items-center gap-2 text-sm"
          ><checkbox v-model="full" :disabled="busy" />完整字段</Label
        ><Button
          class="ml-auto"
          variant="outline"
          :disabled="busy || closed || !graph || dirty"
          @click="exportSvg"
          >导出 SVG</Button
        >
      </div>
      <alert v-if="error" variant="destructive"
        ><alert-description>{{ error }}</alert-description></alert
      >
      <p v-if="notice" role="status" class="text-xs">{{ notice }}</p>
      <p v-if="dirty" class="text-destructive text-xs">选表已变化，生成关系图以更新。</p>
      <p v-if="busy" role="status" class="text-muted-foreground text-xs">正在读取或导出关系图…</p>
      <p v-for="warning in graph?.warnings || []" :key="warning" class="text-destructive text-xs">
        {{ warning }}
      </p>
      <div class="grid min-h-0 flex-1 grid-cols-[190px_minmax(300px,1fr)_230px] gap-3">
        <div class="flex min-h-0 flex-col gap-2 rounded-md border p-2">
          <form class="space-y-2" @submit.prevent="tables(true)">
            <Input
              v-model="schema"
              aria-label="ER Schema"
              placeholder="Schema / 数据库"
              :disabled="busy"
            /><Input
              v-model="search"
              aria-label="ER 搜索表"
              placeholder="搜索表名…"
              :disabled="busy"
            /><Button
              type="submit"
              variant="outline"
              size="sm"
              :disabled="busy || closed"
              class="w-full"
              >搜索表</Button
            >
          </form>
          <div class="flex gap-2">
            <Button variant="ghost" size="sm" :disabled="busy" @click="selectAll">选本页</Button
            ><Button variant="ghost" size="sm" :disabled="busy" @click="chosen = []">清空</Button>
          </div>
          <div class="min-h-0 flex-1 space-y-2 overflow-auto">
            <Label v-for="name in list" :key="name" class="flex min-w-0 items-center gap-2 text-xs"
              ><checkbox
                :aria-label="`ER 选表 ${schema}.${name}`"
                :model-value="
                  chosen.some((table) => entityKey(table) === entityKey({ schema, name }))
                "
                :disabled="busy"
                @update:model-value="(value) => toggle({ schema, name }, value)"
              /><span class="truncate" :title="name">{{ name }}</span></Label
            >
          </div>
          <div class="flex justify-between">
            <Button variant="ghost" size="sm" :disabled="busy || !previous.length" @click="back"
              >上一页</Button
            ><Button variant="ghost" size="sm" :disabled="busy || !after" @click="next"
              >下一页</Button
            >
          </div>
        </div>
        <er-canvas
          v-if="graph"
          :graph="graph"
          :full="full"
          :selected="selected ? entityKey(selected) : undefined"
          :selected-relation="relation?.id"
          @layout="positions = $event"
          @select="select"
          @relation="selectRelation"
        />
        <div
          v-else
          class="text-muted-foreground flex items-center justify-center rounded-md border text-sm"
        >
          选择表并生成关系图
        </div>
        <aside
          aria-label="ER 对象详情"
          class="min-h-0 space-y-3 overflow-auto rounded-md border p-3 text-xs"
        >
          <template v-if="relation"
            ><h3 class="font-medium break-all">{{ relation.name }}</h3>
            <p>
              {{ relation.from.schema }}.{{ relation.from.name }} → {{ relation.to.schema }}.{{
                relation.to.name
              }}
            </p>
            <p v-for="(column, index) in relation.fromColumns" :key="column" class="break-all">
              {{ column }} → {{ relation.toColumns[index] }}
            </p>
            <p>删除规则：{{ relation.onDelete }}</p>
            <p>更新规则：{{ relation.onUpdate }}</p></template
          ><template v-else-if="selected"
            ><h3 class="font-medium break-all">{{ selected.schema }}.{{ selected.name }}</h3>
            <Button
              v-if="!selectedEntity"
              variant="outline"
              size="sm"
              :disabled="busy || closed"
              @click="loadSelected"
              >加载该表字段</Button
            ><template v-else
              ><p class="text-muted-foreground">
                {{ selectedEntity.columns.length }} 个字段 · PK 表示主键
              </p>
              <div
                v-for="column in selectedEntity.columns"
                :key="column.name"
                class="border-b pb-2"
              >
                <p class="font-mono break-all">
                  {{ column.primaryKey ? 'PK ' : '' }}{{ column.name }}
                </p>
                <p class="text-muted-foreground break-all">
                  {{ column.type }} · {{ column.nullable ? '可空' : '非空' }}
                </p>
              </div>
              <Button variant="outline" size="sm" :disabled="busy" @click="toggle(selected, false)"
                >从图中移除</Button
              ></template
            ></template
          >
          <p v-else class="text-muted-foreground">选择表或关系查看详情</p>
        </aside>
      </div>
    </dialog-content></Dialog
  >
</template>
