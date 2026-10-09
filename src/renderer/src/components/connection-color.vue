<script setup lang="ts">
import { ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { ColorPicker } from '@/components/ui/color-picker'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import type { ConnectionConfig } from '../../../shared/contracts'
const props = defineProps<{ profile?: ConnectionConfig }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const color = ref(''),
  error = ref(''),
  busy = ref(false)
watch(
  () => props.profile,
  (p) => {
    color.value = p?.connectedColor || ''
    error.value = ''
  },
)
async function save() {
  if (!props.profile?.id || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await window.vork.setConnectionColor(props.profile.id, color.value)
    emit('saved')
    emit('close')
  } catch (e) {
    const message = (e as Error).message
    error.value = message.includes("No handler registered for 'vork:connection-color'")
      ? '应用主进程仍为旧版本，请重启应用后重试。'
      : message
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <Dialog
    :open="Boolean(profile)"
    @update:open="
      (value) => {
        if (!value) emit('close')
      }
    "
    ><dialog-content
      ><dialog-header
        ><dialog-title>连接背景色</dialog-title
        ><dialog-description
          >{{ profile?.name }} · 已连接时显示，当前标签加深。留空恢复默认。</dialog-description
        ></dialog-header
      >
      <color-picker v-model="color" :disabled="busy" />
      <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
      <div class="flex justify-end gap-2">
        <Button variant="outline" :disabled="busy" @click="color = ''">恢复默认</Button
        ><Button :disabled="busy" @click="save">保存</Button>
      </div></dialog-content
    ></Dialog
  >
</template>
