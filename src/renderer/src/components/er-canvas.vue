<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { Button } from '@/components/ui/button'
import { layoutDiagram, erWidth, erHeader, erRow, entityKey } from '../../../shared/er-layout'
import type { ErDiagram, ErPositions, DataTable, ErRelation } from '../../../shared/contracts'
const props = defineProps<{
  graph: ErDiagram
  full: boolean
  selected?: string
  selectedRelation?: string
}>()
const emit = defineEmits<{
  layout: [positions: ErPositions]
  select: [table: DataTable]
  relation: [relation: ErRelation]
}>()
const viewport = ref<HTMLElement>(),
  positions = ref<ErPositions>({}),
  zoom = ref(1),
  pan = ref({ x: 0, y: 0 })
const layout = computed(() => layoutDiagram(props.graph, positions.value, props.full))
const arrow = computed(() => 'er-arrow-' + props.graph.snapshotId)
let drag:
  { id?: string; pointer: number; x: number; y: number; startX: number; startY: number } | undefined
function publish() {
  emit(
    'layout',
    Object.fromEntries(layout.value.nodes.map((node) => [node.key, { x: node.x, y: node.y }])),
  )
}
function fit() {
  const width = viewport.value?.clientWidth || 800,
    height = viewport.value?.clientHeight || 500
  const next = Math.max(
    0.02,
    Math.min(1.25, (width - 32) / layout.value.width, (height - 32) / layout.value.height),
  )
  zoom.value = next
  pan.value = {
    x: (width - layout.value.width * next) / 2,
    y: (height - layout.value.height * next) / 2,
  }
}
function arrange() {
  positions.value = {}
  void nextTick(() => {
    fit()
    publish()
  })
}
function scale(value: number) {
  const next = Math.max(0.02, Math.min(3, value)),
    x = (viewport.value?.clientWidth || 800) / 2,
    y = (viewport.value?.clientHeight || 500) / 2
  pan.value = {
    x: x - ((x - pan.value.x) * next) / zoom.value,
    y: y - ((y - pan.value.y) * next) / zoom.value,
  }
  zoom.value = next
}
function start(event: PointerEvent, id?: string) {
  if (event.button !== 0) return
  event.preventDefault()
  const node = id ? layout.value.nodes.find((node) => node.key === id) : undefined
  if (node) emit('select', node.table)
  drag = {
    id,
    pointer: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    startX: node?.x ?? pan.value.x,
    startY: node?.y ?? pan.value.y,
  }
  viewport.value?.setPointerCapture(event.pointerId)
}
function move(event: PointerEvent) {
  if (!drag || drag.pointer !== event.pointerId) return
  const dx = event.clientX - drag.x,
    dy = event.clientY - drag.y
  if (drag.id)
    positions.value = {
      ...positions.value,
      [drag.id]: {
        x: Math.max(8, Math.min(1000000, drag.startX + dx / zoom.value)),
        y: Math.max(8, Math.min(1000000, drag.startY + dy / zoom.value)),
      },
    }
  else pan.value = { x: drag.startX + dx, y: drag.startY + dy }
}
function end(event: PointerEvent) {
  if (!drag || drag.pointer !== event.pointerId) return
  drag = undefined
  if (viewport.value?.hasPointerCapture(event.pointerId))
    viewport.value.releasePointerCapture(event.pointerId)
  publish()
}
watch(
  () => props.graph.snapshotId,
  () => {
    const valid = new Set([
      ...props.graph.tables.map((entity) => entityKey(entity.table)),
      ...props.graph.relations.flatMap((relation) => [
        entityKey(relation.from),
        entityKey(relation.to),
      ]),
    ])
    positions.value = Object.fromEntries(
      Object.entries(positions.value).filter(([key]) => valid.has(key)),
    )
    void nextTick(() => {
      fit()
      publish()
    })
  },
  { immediate: true },
)
watch(() => props.full, arrange)
</script>
<template>
  <div class="flex h-full min-h-0 flex-col rounded-md border">
    <div class="flex shrink-0 items-center gap-2 border-b px-2 py-1">
      <Button variant="ghost" size="sm" aria-label="放大关系图" @click="scale(zoom * 1.2)"
        >＋</Button
      ><span aria-label="关系图缩放比例" class="w-14 text-center text-xs"
        >{{ Math.round(zoom * 100) }}%</span
      ><Button variant="ghost" size="sm" aria-label="缩小关系图" @click="scale(zoom / 1.2)"
        >－</Button
      ><Button variant="ghost" size="sm" @click="fit">适应窗口</Button
      ><Button variant="ghost" size="sm" @click="arrange">自动布局</Button
      ><span class="text-muted-foreground ml-auto text-xs">拖动表或空白处，滚轮缩放</span>
    </div>
    <div
      ref="viewport"
      aria-label="ER 关系图画布"
      class="bg-muted/20 relative min-h-0 flex-1 touch-none overflow-hidden"
      @wheel.prevent="scale(zoom * ($event.deltaY > 0 ? 0.9 : 1.1))"
      @pointerdown="start($event)"
      @pointermove="move"
      @pointerup="end"
      @pointercancel="end"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        :width="layout.width"
        :height="layout.height"
        :viewBox="`0 0 ${layout.width} ${layout.height}`"
        class="absolute top-0 left-0 origin-top-left"
        :style="{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }"
      >
        <defs>
          <marker
            :id="arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" />
          </marker>
          <clipPath
            v-for="(node, index) in layout.nodes"
            :id="`er-clip-${graph.snapshotId}-${index}`"
            :key="node.key"
          >
            <rect x="10" y="0" :width="erWidth - 20" :height="node.height" />
          </clipPath>
        </defs>
        <g
          v-for="edge in layout.edges"
          :key="edge.relation.id"
          :aria-label="`外键 ${edge.relation.name}`"
          role="button"
          tabindex="0"
          @pointerdown.stop
          @click.stop="emit('relation', edge.relation)"
          @keydown.enter.prevent="emit('relation', edge.relation)"
        >
          <title>
            {{ edge.relation.name }}: {{ edge.relation.fromColumns.join(', ') }} →
            {{ edge.relation.toColumns.join(', ') }}
          </title>
          <path
            :d="edge.path"
            fill="none"
            stroke="var(--primary)"
            :stroke-width="selectedRelation === edge.relation.id ? 3 : 1.5"
            :marker-end="`url(#${arrow})`"
          />
          <path :d="edge.path" fill="none" stroke="transparent" stroke-width="14" />
          <text
            :x="edge.labelX"
            :y="edge.labelY"
            fill="var(--muted-foreground)"
            text-anchor="middle"
            font-size="11"
          >
            {{
              edge.relation.name.length > 35
                ? edge.relation.name.slice(0, 32) + '…'
                : edge.relation.name
            }}
          </text>
        </g>
        <g
          v-for="(node, index) in layout.nodes"
          :key="node.key"
          :transform="`translate(${node.x},${node.y})`"
          :aria-label="`查看实体 ${node.table.schema}.${node.table.name}`"
          role="button"
          tabindex="0"
          class="cursor-grab"
          @pointerdown.stop="start($event, node.key)"
          @click.stop="emit('select', node.table)"
          @keydown.enter.prevent="emit('select', node.table)"
        >
          <title>{{ node.table.schema }}.{{ node.table.name }}</title>
          <rect
            :width="erWidth"
            :height="node.height"
            rx="8"
            :fill="node.external ? 'var(--muted)' : 'var(--card)'"
            :stroke="selected === node.key ? 'var(--primary)' : 'var(--border)'"
            :stroke-width="selected === node.key ? 2 : 1"
            :stroke-dasharray="node.external ? '5 4' : undefined"
          />
          <g :clip-path="`url(#er-clip-${graph.snapshotId}-${index})`">
            <text
              x="12"
              y="28"
              fill="var(--foreground)"
              font-family="monospace"
              font-size="13"
              font-weight="600"
            >
              {{ node.table.schema }}.{{ node.table.name }}
            </text>
            <text v-if="node.external" x="12" y="60" fill="var(--muted-foreground)" font-size="11">
              未加载字段，可在右侧加入
            </text>
            <g v-for="(column, i) in node.shown" :key="column.name">
              <text
                x="12"
                :y="erHeader + i * erRow + 15"
                :fill="column.primaryKey ? 'var(--primary)' : 'var(--foreground)'"
                font-family="monospace"
                font-size="11"
              >
                {{ column.primaryKey ? 'PK ' : '' }}{{ column.name }} : {{ column.type }}
              </text>
            </g>
            <text
              v-if="node.shown.length < node.columns.length"
              x="12"
              :y="node.height - 8"
              fill="var(--muted-foreground)"
              font-size="10"
            >
              另 {{ node.columns.length - node.shown.length }} 个字段，右侧可查看
            </text>
          </g>
        </g>
      </svg>
    </div>
  </div>
</template>
