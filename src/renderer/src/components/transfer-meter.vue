<script setup lang="ts">
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import { computed } from 'vue'
import type { TransferProgress } from '../../../shared/contracts'
const props = defineProps<{ progress: TransferProgress }>()
defineEmits<{ cancel: [] }>()
const percent = computed(() =>
  props.progress.total
    ? Math.min(100, Math.round((props.progress.bytes / props.progress.total) * 100))
    : 0,
)
</script>
<template>
  <div class="space-y-2 border-b px-4 py-3" role="status">
    <div class="flex items-center justify-between gap-3 text-xs">
      <span class="min-w-0 truncate font-mono"
        >{{ progress.file }} · {{ progress.bytes }} / {{ progress.total }} bytes ·
        {{ progress.state === 'committing' ? '提交文件中…' : `${percent}%` }}</span
      ><Button
        variant="outline"
        size="xs"
        :disabled="progress.state !== 'transferring'"
        @click="$emit('cancel')"
        >取消传输</Button
      >
    </div>
    <Progress :model-value="percent" aria-label="文件传输进度" />
  </div>
</template>
