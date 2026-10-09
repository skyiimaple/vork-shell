<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { shortcuts, saveShortcuts } from '@/composables/use-shortcuts'
import { defaultShortcuts, type Shortcuts } from '@/lib/shortcuts'
const open = defineModel<boolean>('open', { default: false })
const draft = reactive({ ...shortcuts.value }),
  error = ref('')
const labels: Record<keyof Shortcuts, string> = {
  newConnection: '新建连接',
  close: '关闭当前会话',
  execute: '执行查询/命令',
  searchHistory: '搜索查询历史',
}
watch(open, (value) => {
  if (value) {
    Object.assign(draft, shortcuts.value)
    error.value = ''
  }
})
function save() {
  try {
    saveShortcuts(draft)
    open.value = false
  } catch (e) {
    error.value = (e as Error).message
  }
}
</script>
<template>
  <Dialog v-model:open="open"
    ><dialog-content
      ><dialog-header
        ><dialog-title>键盘快捷键</dialog-title
        ><dialog-description
          >Mod 表示 macOS 的 Command 或其他系统的 Ctrl。使用 Mod-Shift-k
          等格式。</dialog-description
        ></dialog-header
      >
      <form class="space-y-4" @submit.prevent="save">
        <Label v-for="(label, key) in labels" :key="key" class="grid gap-2"
          ><span>{{ label }}</span
          ><Input v-model="draft[key]" :aria-label="label + '快捷键'"
        /></Label>
        <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
        <div class="flex justify-between">
          <Button type="button" variant="outline" @click="Object.assign(draft, defaultShortcuts)"
            >恢复默认</Button
          ><Button type="submit">保存快捷键</Button>
        </div>
      </form></dialog-content
    ></Dialog
  >
</template>
