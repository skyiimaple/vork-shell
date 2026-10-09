<script setup lang="ts">
import { ref } from 'vue'
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
import type { RedisRequest } from '../../../shared/contracts'
const props = defineProps<{ sessionId: string; database: number; closed: boolean }>()
const emit = defineEmits<{ created: [key: string, database: number] }>()
const open = ref(false),
  busy = ref(false),
  creationDatabase = ref(0),
  key = ref(''),
  value = ref(''),
  member = ref('field'),
  score = ref('0'),
  ttl = ref(''),
  error = ref('')
const type = ref<Extract<RedisRequest, { kind: 'create' }>['type']>('string')
function begin() {
  creationDatabase.value = props.database
  key.value = ''
  value.value = ''
  ttl.value = ''
  error.value = ''
  open.value = true
}
async function create() {
  if (busy.value || props.closed) return
  if (ttl.value && !/^\d+$/.test(ttl.value)) {
    error.value = 'TTL 请输入正整数，留空表示永久保留'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await window.vork.redisRequest(props.sessionId, {
      kind: 'create',
      database: creationDatabase.value,
      key: key.value,
      type: type.value,
      value: value.value,
      member: member.value,
      score: score.value,
      seconds: ttl.value ? Number(ttl.value) : undefined,
    })
    open.value = false
    emit('created', key.value, creationDatabase.value)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <Button variant="outline" size="xs" :disabled="closed || busy" @click="begin">新建键</Button
  ><Dialog
    :open="open"
    @update:open="
      (next) => {
        if (!busy) open = next
      }
    "
    ><dialog-content
      ><dialog-header
        ><dialog-title>新建 Redis 键</dialog-title
        ><dialog-description
          >db{{ creationDatabase }} · 同名键不会覆盖。集合通过初始成员创建。</dialog-description
        ></dialog-header
      >
      <form class="space-y-4" @submit.prevent="create">
        <Label class="grid gap-2"
          >键名<Input v-model="key" aria-label="新 Redis 键名" :disabled="busy" /></Label
        ><Label class="grid gap-2"
          >类型<Select v-model="type" :disabled="busy"
            ><select-trigger aria-label="新 Redis 键类型"><select-value /></select-trigger
            ><select-content
              ><select-item
                v-for="item in ['string', 'hash', 'list', 'set', 'zset', 'stream']"
                :key="item"
                :value="item"
                >{{ item }}</select-item
              ></select-content
            ></Select
          ></Label
        ><Label v-if="type === 'hash' || type === 'stream'" class="grid gap-2"
          >初始字段<Input v-model="member" aria-label="新 Redis 初始字段" :disabled="busy" /></Label
        ><Label v-if="type === 'zset'" class="grid gap-2"
          >分数<Input v-model="score" aria-label="新 Redis 初始分数" :disabled="busy" /></Label
        ><Label class="grid gap-2"
          >{{ type === 'set' || type === 'zset' ? '初始成员' : '初始值'
          }}<Textarea
            v-model="value"
            aria-label="新 Redis 初始值"
            class="max-h-48 font-mono text-xs"
            :disabled="busy" /></Label
        ><Label class="grid gap-2"
          >TTL 秒数（留空永久保留）<Input
            v-model="ttl"
            aria-label="新 Redis TTL"
            :disabled="busy" /></Label
        ><alert v-if="error" variant="destructive"
          ><alert-description class="break-all">{{ error }}</alert-description></alert
        >
        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" :disabled="busy" @click="open = false"
            >取消</Button
          ><Button type="submit" :disabled="closed || busy">{{
            busy ? '创建中…' : '确认创建'
          }}</Button>
        </div>
      </form></dialog-content
    ></Dialog
  >
</template>
