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
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TreeRow } from '@/components/ui/tree'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { Session, QueryPlan, PlanNode } from '../../../shared/contracts'
const props = defineProps<{ session: Session; sql: string; closed: boolean }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ busy: [value: boolean] }>()
const plan = ref<QueryPlan>(),
  input = ref(''),
  busy = ref(false),
  error = ref(''),
  view = ref('tree'),
  selected = ref(''),
  collapsed = ref<string[]>([]),
  copied = ref(false),
  analyzedInput = ref('')
let mounted = true
const all = computed(() => {
  const result: PlanNode[] = []
  const walk = (node: PlanNode) => {
    result.push(node)
    node.children.forEach(walk)
  }
  plan.value?.nodes.forEach(walk)
  return result
})
const visible = computed(() => {
  const result: { node: PlanNode; depth: number }[] = []
  const walk = (node: PlanNode, depth: number) => {
    result.push({ node, depth })
    if (!collapsed.value.includes(node.id)) node.children.forEach((child) => walk(child, depth + 1))
  }
  plan.value?.nodes.forEach((node) => walk(node, 0))
  return result
})
const current = computed(() => all.value.find((node) => node.id === selected.value))
const scans = computed(
  () =>
    all.value.filter(
      (node) =>
        /Seq Scan/.test(node.label) ||
        (/^SCAN\s/i.test(node.label) && !/USING/i.test(node.label)) ||
        node.details.access_type === 'ALL',
    ).length,
)
const labels: Record<string, string> = {
  'Node Type': '节点类型',
  'Relation Name': '表名',
  Schema: 'Schema',
  Alias: '别名',
  'Join Type': '连接方式',
  'Index Name': '索引名称',
  'Index Cond': '索引条件',
  Filter: '过滤条件',
  'Startup Cost': '启动成本',
  'Total Cost': '总成本',
  'Plan Rows': '估算行数',
  'Plan Width': '估算行宽',
  Output: '输出字段',
  'Parent Relationship': '父节点关系',
  'Scan Direction': '扫描方向',
  table_name: '表名',
  access_type: '访问类型',
  key: '使用的索引',
  possible_keys: '可选索引',
  used_key_parts: '使用的索引字段',
  rows_examined_per_scan: '估算扫描行数',
  rows_produced_per_join: '估算连接行数',
  filtered: '过滤比例',
  attached_condition: '过滤条件',
  query_cost: '查询成本',
  read_cost: '读取成本',
  eval_cost: '求值成本',
  prefix_cost: '前缀成本',
  data_read_per_join: '每次连接读取量',
  using_temporary_table: '使用临时表',
  using_filesort: '使用排序',
  parent: '父节点',
  id: '节点 ID',
}
function toggle(id: string) {
  collapsed.value = collapsed.value.includes(id)
    ? collapsed.value.filter((value) => value !== id)
    : [...collapsed.value, id]
}
async function load() {
  if (busy.value || props.closed || !input.value.trim()) return
  busy.value = true
  emit('busy', true)
  error.value = ''
  copied.value = false
  try {
    const requestedSql = input.value
    const result = await window.vork.queryPlan(props.session.id, requestedSql)
    if (mounted) {
      plan.value = result
      analyzedInput.value = requestedSql
      selected.value = result.nodes[0]?.id || ''
      collapsed.value = []
    }
  } catch (e) {
    if (mounted) {
      error.value = (e as Error).message
      plan.value = undefined
    }
  } finally {
    if (mounted) {
      busy.value = false
      emit('busy', false)
    }
  }
}
async function stop() {
  try {
    await window.vork.cancel(props.session.id)
  } catch (e) {
    error.value = (e as Error).message
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(plan.value, null, 2))
    copied.value = true
  } catch {
    error.value = '复制计划失败，请检查剪贴板权限'
  }
}
watch(open, (value) => {
  if (value) {
    input.value = props.sql
    plan.value = undefined
    view.value = 'tree'
    error.value = ''
    void load()
  }
})
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
    ><dialog-content :show-close-button="!busy" class="flex h-[88vh] flex-col sm:max-w-[95vw]"
      ><dialog-header
        ><dialog-title>执行计划</dialog-title
        ><dialog-description
          >使用 EXPLAIN，不启用
          ANALYZE。显示优化器估算与访问路径，不代表实际执行耗时。</dialog-description
        ></dialog-header
      >
      <div class="flex shrink-0 items-start gap-3">
        <Textarea
          v-model="input"
          aria-label="执行计划 SQL"
          class="max-h-24 min-h-16 font-mono text-xs"
          :disabled="busy"
        />
        <div class="flex shrink-0 flex-col gap-2">
          <Button :disabled="busy || closed || !input.trim()" @click="load">生成执行计划</Button
          ><Button v-if="busy" variant="outline" @click="stop">停止并断开</Button>
        </div>
      </div>
      <alert v-if="error" variant="destructive"
        ><alert-description>{{ error }}</alert-description></alert
      >
      <p v-if="busy" role="status" class="text-muted-foreground text-sm">正在读取执行计划…</p>
      <template v-if="plan"
        ><div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <tabs v-model="view"
              ><tabs-list
                ><tabs-trigger value="tree">计划树</tabs-trigger
                ><tabs-trigger value="raw">原始计划</tabs-trigger></tabs-list
              ></tabs
            ><badge variant="secondary">{{ all.length }} 个节点</badge
            ><badge v-if="scans" variant="secondary">{{ scans }} 处全表扫描</badge>
          </div>
          <Button variant="outline" size="sm" @click="copy">{{
            copied ? '已复制' : '复制计划 JSON'
          }}</Button>
        </div>
        <p v-if="input !== analyzedInput" class="text-destructive text-xs">
          SQL 已修改，请重新生成计划。
        </p>
        <p v-for="warning in plan.warnings" :key="warning" class="text-destructive text-xs">
          {{ warning }}
        </p>
        <div
          v-if="view === 'tree'"
          class="grid min-h-0 flex-1 grid-cols-[minmax(240px,1fr)_minmax(250px,1fr)] gap-3"
        >
          <div aria-label="执行计划树" class="min-h-0 overflow-auto rounded-md border p-2">
            <tree-row
              v-for="entry in visible"
              :key="entry.node.id"
              :label="entry.node.label"
              :depth="entry.depth"
              :expandable="Boolean(entry.node.children.length)"
              :expanded="!collapsed.includes(entry.node.id)"
              :selected="selected === entry.node.id"
              @toggle="toggle(entry.node.id)"
              @activate="selected = entry.node.id"
            />
            <p v-if="!all.length" class="text-muted-foreground p-4 text-sm">
              没有可视节点，可切换查看原始计划。
            </p>
          </div>
          <div aria-label="执行计划节点详情" class="min-h-0 overflow-auto rounded-md border p-4">
            <template v-if="current"
              ><h3 class="mb-4 font-medium">{{ current.label }}</h3>
              <dl class="space-y-3">
                <div
                  v-for="(value, key) in current.details"
                  :key="key"
                  class="grid grid-cols-[minmax(100px,1fr)_minmax(0,2fr)] gap-3 text-xs"
                >
                  <dt class="text-muted-foreground">{{ labels[key] || key }}</dt>
                  <dd class="font-mono break-all whitespace-pre-wrap">{{ value }}</dd>
                </div>
              </dl></template
            >
          </div>
        </div>
        <pre
          v-else
          aria-label="原始执行计划"
          class="min-h-0 flex-1 overflow-auto rounded-md border p-4 text-xs break-all whitespace-pre-wrap"
          >{{ JSON.stringify({ columns: plan.raw.columns, rows: plan.raw.rows }, null, 2) }}</pre>
        <p class="text-muted-foreground shrink-0 text-xs">
          {{
            plan.dialect === 'sqlite'
              ? 'SQLite 提供访问路径，不提供成本和行数估算。'
              : '成本是数据库内部估算单位，不是毫秒。'
          }}全表扫描并不一定表示计划不合理。
        </p>
      </template>
    </dialog-content></Dialog
  >
</template>
