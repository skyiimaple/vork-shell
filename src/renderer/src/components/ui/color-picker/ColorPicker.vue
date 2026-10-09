<script setup lang="ts">
import { computed } from 'vue'
import { Input } from '@/components/ui/input'
const value = defineModel<string>({ default: '' })
defineProps<{ disabled?: boolean }>()
const selected = computed(() => (/^#[0-9a-f]{6}$/i.test(value.value) ? value.value : '#3b82f6'))
</script>
<template>
  <div class="grid gap-3">
    <div class="flex items-center gap-3">
      <Input
        type="color"
        :model-value="selected"
        :disabled="disabled"
        aria-label="打开颜色选择器"
        class="h-12 w-16 shrink-0 cursor-pointer p-1"
        @input="value = ($event.target as HTMLInputElement).value"
      />
      <div class="min-w-0 flex-1">
        <p class="text-sm">点击色块选择颜色</p>
        <p class="text-muted-foreground text-xs">{{ value || '默认背景色' }}</p>
      </div>
    </div>
    <Input
      v-model="value"
      :disabled="disabled"
      aria-label="自定义连接背景色"
      placeholder="#3b82f6，或恢复默认"
    />
    <div
      class="rounded-lg border p-3 text-sm"
      :style="
        value && /^#[0-9a-f]{6}$/i.test(value) ? { backgroundColor: value + '40' } : undefined
      "
    >
      已连接背景预览
    </div>
  </div>
</template>
