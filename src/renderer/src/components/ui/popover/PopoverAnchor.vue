<script setup lang="ts">
import type { PopoverAnchorProps } from 'reka-ui'
import { PopoverAnchor } from 'reka-ui'

const props = defineProps<PopoverAnchorProps>()
</script>

<template>
  <popover-anchor data-slot="popover-anchor" v-bind="props">
    <slot />
  </popover-anchor>
</template>
