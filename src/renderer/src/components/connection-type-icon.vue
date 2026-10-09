<script setup lang="ts">
import { Terminal, HardDrive, DatabaseZap, Database, Layers, Leaf } from '@lucide/vue'
import type { ConnectionType } from '../../../shared/contracts'
withDefaults(defineProps<{ type: ConnectionType; size?: number }>(), { size: 16 })
const icons = {
  ssh: Terminal,
  sqlite: HardDrive,
  mysql: DatabaseZap,
  postgresql: Database,
  redis: Layers,
  mongodb: Leaf,
}
const labels = {
  ssh: 'SSH',
  sqlite: 'SQLite',
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  redis: 'Redis',
  mongodb: 'MongoDB',
}
const colors = {
  ssh: 'text-amber-600 dark:text-amber-400',
  sqlite: 'text-slate-600 dark:text-slate-300',
  mysql: 'text-sky-600 dark:text-sky-400',
  postgresql: 'text-indigo-600 dark:text-indigo-400',
  redis: 'text-red-600 dark:text-red-400',
  mongodb: 'text-green-600 dark:text-green-400',
}
</script>
<template>
  <component
    :is="icons[type]"
    :size="size"
    :class="colors[type]"
    class="shrink-0"
    role="img"
    :aria-label="`${labels[type]} 连接`"
    ><title>{{ labels[type] }}</title></component
  >
</template>
