<script setup lang="ts">
import { DropdownMenuItem } from 'reka-ui'
defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ select: [event: Event] }>()
</script>
<template>
  <dropdown-menu-item
    :disabled="disabled"
    class="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground flex cursor-default items-center gap-2 rounded-sm px-2 py-2 text-xs outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
    @select="emit('select', $event)"
    ><slot
  /></dropdown-menu-item>
</template>
