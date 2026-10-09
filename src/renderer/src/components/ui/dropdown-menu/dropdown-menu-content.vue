<script setup lang="ts">
import { DropdownMenuContent, DropdownMenuPortal } from 'reka-ui'
</script>
<template>
  <dropdown-menu-portal
    ><dropdown-menu-content
      align="end"
      :side-offset="4"
      class="bg-popover text-popover-foreground z-50 min-w-40 rounded-md border p-1 shadow-md"
      ><slot /></dropdown-menu-content
  ></dropdown-menu-portal>
</template>
