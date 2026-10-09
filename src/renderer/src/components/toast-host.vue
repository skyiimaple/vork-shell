<script setup lang="ts">
import { notifications } from '@/composables/use-notifications'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { X } from '@lucide/vue'
const { items, dismiss } = notifications
</script>
<template>
  <div
    class="fixed right-5 bottom-11 z-50 flex max-w-md flex-col gap-2"
    aria-live="polite"
    aria-relevant="additions"
  >
    <alert
      v-for="item in items"
      :key="item.id"
      :variant="item.kind === 'error' ? 'destructive' : 'default'"
      class="bg-popover flex items-start gap-3 shadow-lg"
      ><alert-description class="min-w-0 flex-1 break-all">{{ item.message }}</alert-description
      ><Button
        variant="ghost"
        size="icon"
        class="size-6 shrink-0"
        aria-label="关闭通知"
        @click="dismiss(item.id)"
        ><x :size="14" /></Button
    ></alert>
  </div>
</template>
