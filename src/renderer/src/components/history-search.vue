<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { QueryHistoryEntry } from '../../../shared/contracts'
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ restore: [entry: QueryHistoryEntry] }>()
const entries = ref<QueryHistoryEntry[]>([]),
  search = ref(''),
  error = ref(''),
  loading = ref(false)
let request = 0
watch(open, async (value) => {
  const current = ++request
  if (!value) return
  loading.value = true
  error.value = ''
  try {
    const data = await window.vork.queryHistory()
    if (current === request) entries.value = data
  } catch (e) {
    if (current === request) error.value = (e as Error).message
  } finally {
    if (current === request) loading.value = false
  }
})
const matches = computed(() =>
  entries.value.filter((entry) =>
    `${entry.name} ${entry.target} ${entry.sql}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
)
function restore(entry: QueryHistoryEntry) {
  emit('restore', entry)
  open.value = false
}
</script>
<template>
  <Dialog v-model:open="open"
    ><dialog-content class="sm:max-w-[780px]"
      ><dialog-header
        ><dialog-title>跨连接搜索查询历史</dialog-title
        ><dialog-description
          >搜索连接名称、目标与 SQL。恢复到对应连接编辑器后需手动执行；内存 SQLite
          重连会创建空数据库。</dialog-description
        ></dialog-header
      ><Input v-model="search" aria-label="搜索全部查询历史" placeholder="搜索连接或 SQL…" />
      <div class="scroll-area max-h-[55vh] space-y-2 overflow-auto">
        <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
        <p v-else-if="loading" class="text-muted-foreground p-6 text-center text-sm">读取历史…</p>
        <template v-else
          ><Button
            v-for="entry in matches"
            :key="entry.id"
            variant="outline"
            class="h-auto w-full flex-col items-start p-3 text-left whitespace-normal"
            @click="restore(entry)"
            ><span class="text-muted-foreground text-xs"
              >{{ entry.name }} · {{ entry.type }} ·
              {{ new Date(entry.timestamp).toLocaleString() }}</span
            ><span class="text-muted-foreground max-w-full truncate text-[10px]">{{
              entry.target
            }}</span>
            <pre
              class="line-clamp-4 max-w-full overflow-hidden font-mono text-xs break-all whitespace-pre-wrap"
              >{{ entry.sql }}</pre>
          </Button>
          <p v-if="!matches.length" class="text-muted-foreground p-6 text-center text-sm">
            没有匹配的查询历史
          </p></template
        >
      </div></dialog-content
    ></Dialog
  >
</template>
