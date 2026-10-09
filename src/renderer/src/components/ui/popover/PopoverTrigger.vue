<script setup lang="ts">
import type { PopoverTriggerProps } from 'reka-ui'
import { PopoverTrigger } from 'reka-ui'

const props = defineProps<PopoverTriggerProps>()
</script>

<template>
  <popover-trigger data-slot="popover-trigger" v-bind="props">
    <slot />
  </popover-trigger>
</template>
