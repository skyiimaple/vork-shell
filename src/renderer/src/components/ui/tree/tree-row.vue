<script setup lang="ts">
import { ChevronRight } from '@lucide/vue'
import { Button } from '@/components/ui/button'
withDefaults(
  defineProps<{
    label: string
    title?: string
    depth?: number
    expandable?: boolean
    expanded?: boolean
    selected?: boolean
    disabled?: boolean
  }>(),
  { depth: 0 },
)
const emit = defineEmits<{
  toggle: []
  activate: [event: MouseEvent]
  doubleActivate: [event: MouseEvent]
}>()
</script>
<template>
  <div
    class="group hover:bg-muted/50 flex h-8 min-w-0 items-center gap-1 rounded-md px-1 text-xs"
    :class="selected ? 'bg-primary/5 text-primary' : 'text-muted-foreground'"
    :style="{ paddingLeft: `${4 + depth * 16}px` }"
  >
    <Button
      v-if="expandable"
      variant="ghost"
      size="icon-xs"
      class="size-5 shrink-0 p-0 hover:bg-transparent"
      :disabled="disabled"
      :aria-label="`展开 ${label}`"
      :aria-expanded="expanded"
      @click="emit('toggle')"
      ><chevron-right :size="12" :class="expanded ? 'rotate-90' : ''"
    /></Button>
    <span v-else class="w-5 shrink-0" />
    <Button
      variant="ghost"
      class="h-7 min-w-0 flex-1 justify-start gap-2 px-1 text-xs font-normal hover:bg-transparent has-[>svg]:px-1 dark:hover:bg-transparent"
      :title="title ?? label"
      :disabled="disabled"
      :aria-pressed="selected"
      @click="emit('activate', $event)"
      @dblclick="emit('doubleActivate', $event)"
      ><slot name="icon" /><span class="min-w-0 truncate font-mono">{{ label }}</span></Button
    >
    <div v-if="$slots.actions" class="flex shrink-0 items-center gap-1">
      <slot name="actions" />
    </div>
  </div>
</template>
