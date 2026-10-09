<script setup lang="ts">
import { ContextMenuContent, ContextMenuPortal } from 'reka-ui'
</script>
<template>
  <context-menu-portal
    ><context-menu-content
      class="bg-popover text-popover-foreground z-50 min-w-44 rounded-md border p-1 shadow-md"
      ><slot /></context-menu-content
  ></context-menu-portal>
</template>
