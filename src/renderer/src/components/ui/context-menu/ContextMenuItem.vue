<script setup lang="ts">
import { ContextMenuItem } from 'reka-ui'
defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ select: [event: Event] }>()
</script>
<template>
  <context-menu-item
    :disabled="disabled"
    class="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground flex cursor-default items-center rounded-sm px-2 py-1.5 text-xs outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
    @select="emit('select', $event)"
    ><slot
  /></context-menu-item>
</template>
