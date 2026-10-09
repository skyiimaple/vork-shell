<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMutation } from '@tanstack/vue-query'
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { RedisKeyDetail, RedisRequest } from '../../../shared/contracts'
type Member = Extract<RedisRequest, { kind: 'member' }>
const props = defineProps<{
  sessionId: string
  database: number
  detail: RedisKeyDetail
  closed: boolean
}>()
const emit = defineEmits<{ changed: [] }>()
const open = ref(false),
  operation = ref<Member['operation']>('add'),
  selection = ref('new'),
  member = ref(''),
  value = ref(''),
  score = ref('0'),
  error = ref('')
let target: Pick<Member, 'database' | 'key' | 'collection'>, snapshot: RedisKeyDetail
const snapshotType = ref('')
const operations = computed(
  () =>
    (snapshotType.value === 'list'
      ? ['update', 'push-head', 'push-tail', 'pop-head', 'pop-tail']
      : snapshotType.value === 'set'
        ? ['add', 'remove']
        : ['add', 'update', 'remove']) as Member['operation'][],
)
const names: Record<Member['operation'], string> = {
  add: '新增成员',
  update: '更新成员',
  remove: '删除成员',
  'push-head': '添加到列表开头',
  'push-tail': '添加到列表末尾',
  'pop-head': '移除列表首项',
  'pop-tail': '移除列表末项',
}
const rows = ref<RedisKeyDetail['rows']>([])
const selected = computed(() =>
  /^row:\d+$/.test(selection.value) ? rows.value[Number(selection.value.slice(4))] : undefined,
)
watch(selection, () => {
  if (selected.value) {
    member.value = String(selected.value[0])
    value.value = String(selected.value[1] ?? '')
    score.value = String(selected.value[1] ?? '0')
  }
})
watch(operation, () => {
  selection.value = 'new'
  member.value = ''
  value.value = ''
  score.value = '0'
  error.value = ''
})
const mutation = useMutation({
  mutationFn: (request: Member) => window.vork.redisRequest(props.sessionId, request),
  retry: false,
  onSuccess() {
    open.value = false
    emit('changed')
  },
  onError(e) {
    error.value = e.message
  },
})
function begin() {
  snapshot = props.detail
  snapshotType.value = snapshot.type
  target = {
    database: props.database,
    key: snapshot.key,
    collection: snapshot.type as Member['collection'],
  }
  rows.value = snapshot.rows.map((row) => [...row])
  operation.value = snapshot.type === 'list' ? 'push-tail' : 'add'
  selection.value = 'new'
  member.value = ''
  value.value = ''
  score.value = '0'
  error.value = ''
  open.value = true
}
function submit() {
  if (props.closed || mutation.isPending.value) return
  const request: Member = { kind: 'member', ...target, operation: operation.value }
  if (operation.value === 'add') {
    request.member = member.value
    request.value = value.value
    request.score = score.value
  } else if (operation.value.startsWith('push')) request.value = value.value
  else if (operation.value.startsWith('pop')) {
    const index = operation.value === 'pop-head' ? 0 : snapshot.size - 1
    const row = rows.value.find((row) => Number(row[0]) === index)
    if (!row) {
      error.value = '当前页没有该端的条目，请先翻到对应页'
      return
    }
    request.expected = String(row[1])
  } else {
    if (!selected.value) {
      error.value = '请选择当前页的成员'
      return
    }
    request.member = String(selected.value[0])
    request.expected = target.collection === 'set' ? undefined : String(selected.value[1])
    request.index = Number(selected.value[0])
    request.value = value.value
    request.score = score.value
  }
  error.value = ''
  mutation.mutate(request)
}
</script>
<template>
  <Button variant="outline" size="xs" :disabled="closed || detail.binaryMembers" @click="begin"
    >编辑集合</Button
  >
  <Dialog
    :open="open"
    @update:open="
      (next) => {
        if (!mutation.isPending.value) open = next
      }
    "
    ><dialog-content class="sm:max-w-lg"
      ><dialog-header
        ><dialog-title>编辑 {{ target?.collection }} 集合</dialog-title
        ><dialog-description class="break-all"
          >db{{ target?.database }} · {{ target?.key }}</dialog-description
        ></dialog-header
      >
      <form class="space-y-4" @submit.prevent="submit">
        <Select v-model="operation" :disabled="mutation.isPending.value"
          ><select-trigger aria-label="Redis 成员操作" class="w-full"
            ><select-value /></select-trigger
          ><select-content
            ><select-item v-for="op in operations" :key="op" :value="op">{{
              names[op]
            }}</select-item></select-content
          ></Select
        >
        <Select
          v-if="['update', 'remove'].includes(operation)"
          v-model="selection"
          :disabled="mutation.isPending.value"
          ><select-trigger aria-label="选择 Redis 成员" class="w-full"
            ><select-value /></select-trigger
          ><select-content
            ><select-item value="new">选择当前页的成员</select-item
            ><select-item v-for="(row, index) in rows" :key="index" :value="'row:' + index"
              ><span class="max-w-[340px] truncate font-mono">{{
                String(row[0]) || '(空成员)'
              }}</span></select-item
            ></select-content
          ></Select
        >
        <Label v-if="operation === 'add'" class="grid gap-2"
          >成员 / 字段<Input
            v-model="member"
            aria-label="Redis 新成员"
            :disabled="mutation.isPending.value"
        /></Label>
        <Label
          v-if="
            (target?.collection === 'hash' || target?.collection === 'list') &&
            !['remove', 'pop-head', 'pop-tail'].includes(operation)
          "
          class="grid gap-2"
          >值<Textarea
            v-model="value"
            aria-label="Redis 成员值"
            :disabled="mutation.isPending.value"
            class="h-28 font-mono text-xs"
        /></Label>
        <Label v-if="target?.collection === 'zset' && operation !== 'remove'" class="grid gap-2"
          >分数<Input
            v-model="score"
            aria-label="Redis 成员分数"
            :disabled="mutation.isPending.value"
        /></Label>
        <p class="text-muted-foreground text-xs leading-5">
          新增 Hash / ZSet
          成员不会覆盖已有值。更新和删除使用当前页快照检查并发修改；列表两端移除也需要对应条目位于当前页。
        </p>
        <alert v-if="error" variant="destructive"
          ><alert-description>{{ error }}</alert-description></alert
        >
        <div class="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            :disabled="mutation.isPending.value"
            @click="open = false"
            >取消</Button
          ><Button
            type="submit"
            :variant="
              ['remove', 'pop-head', 'pop-tail'].includes(operation) ? 'destructive' : 'default'
            "
            :disabled="mutation.isPending.value"
            >{{ mutation.isPending.value ? '处理中…' : '确认操作' }}</Button
          >
        </div>
      </form>
    </dialog-content></Dialog
  >
</template>
