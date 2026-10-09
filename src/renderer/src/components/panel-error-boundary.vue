<script setup lang="ts">
import { onErrorCaptured, ref } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
const error = ref(''),
  generation = ref(0)
onErrorCaptured((value) => {
  error.value = value instanceof Error ? value.message : String(value)
  return false
})
function reset() {
  error.value = ''
  generation.value++
}
</script>
<template>
  <alert v-if="error" variant="destructive" class="m-4 w-auto" role="alert"
    ><alert-title>此面板遇到错误</alert-title
    ><alert-description class="space-y-3"
      ><p class="break-all">{{ error }}</p>
      <Button variant="outline" size="sm" @click="reset">重新加载面板</Button></alert-description
    ></alert
  >
  <div v-else :key="generation" class="h-full min-h-0"><slot /></div>
</template>
