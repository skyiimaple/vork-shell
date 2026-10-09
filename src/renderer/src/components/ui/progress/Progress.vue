<script setup lang="ts">
import { ProgressRoot, ProgressIndicator } from 'reka-ui'
import { cn } from '@/lib/utils'
import type { HTMLAttributes } from 'vue'
defineProps<{ modelValue: number; class?: HTMLAttributes['class'] }>()
</script>
<template>
  <progress-root
    :model-value="modelValue"
    :max="100"
    :class="cn('bg-primary/20 relative h-2 overflow-hidden rounded-full', $props.class)"
    ><progress-indicator
      class="bg-primary h-full w-full transition-transform"
      :style="{ transform: `translateX(-${100 - Math.min(100, Math.max(0, modelValue))}%)` }"
  /></progress-root>
</template>
