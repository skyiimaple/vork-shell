<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { theme, setTheme, type ThemeMode } from '@/composables/use-theme'
import { playgroundCard } from '@/composables/use-playground-card'
import history from '../../../shared/release-history.json'
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ import: []; release: []; shortcuts: []; logs: [] }>()
const error = ref(''),
  message = ref(''),
  busy = ref(false)
function navigate(kind: 'import' | 'release' | 'shortcuts' | 'logs') {
  open.value = false
  if (kind === 'import') emit('import')
  else if (kind === 'release') emit('release')
  else if (kind === 'logs') emit('logs')
  else emit('shortcuts')
}
async function exportConfig() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const path = await window.vork.exportConnections()
    if (path) message.value = '已导出到 ' + path
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function project() {
  try {
    await window.vork.openProject()
  } catch (e) {
    error.value = (e as Error).message
  }
}
</script>
<template>
  <Dialog v-model:open="open"
    ><dialog-content class="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
      ><dialog-header
        ><dialog-title>设置</dialog-title
        ><dialog-description
          >外观、连接配置、版本更新与本地日志。</dialog-description
        ></dialog-header
      >
      <section class="space-y-4 rounded-lg border p-4">
        <h3 class="font-semibold">外观</h3>
        <Button
          variant="outline"
          :disabled="playgroundCard === 'expanded'"
          @click="playgroundCard = 'expanded'"
          >显示本地试验台</Button
        >
        <div class="grid gap-2">
          <span class="text-sm">主题模式</span
          ><Select
            :model-value="theme"
            @update:model-value="(value) => setTheme(value as ThemeMode)"
            ><select-trigger aria-label="设置主题"><select-value /></select-trigger
            ><select-content
              ><select-item value="system">跟随系统</select-item
              ><select-item value="light">亮色</select-item
              ><select-item value="dark">深色</select-item></select-content
            ></Select
          >
        </div>
      </section>
      <section class="space-y-3 rounded-lg border p-4">
        <h3 class="font-semibold">连接配置</h3>
        <p class="text-muted-foreground text-sm">
          导出 JSON 支持所有连接类型，不含密码、私钥或口令；导入后请补充凭据。支持导入 .ano 与 Redis
          JSON。
        </p>
        <div class="flex gap-2">
          <Button variant="outline" @click="navigate('import')">导入配置</Button
          ><Button variant="outline" :disabled="busy" @click="exportConfig">{{
            busy ? '导出中…' : '导出 JSON'
          }}</Button>
        </div>
      </section>
      <section class="space-y-3 rounded-lg border p-4">
        <h3 class="font-semibold">当前版本 v{{ history.version }}</h3>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" @click="navigate('release')">版本更新与迭代日志</Button
          ><Button variant="outline" @click="navigate('shortcuts')">快捷键</Button
          ><Button variant="outline" @click="navigate('logs')">操作与错误日志</Button
          ><Button variant="outline" @click="project">项目主页</Button>
        </div>
        <p class="text-muted-foreground text-xs break-all">
          https://github.com/skyiimaple/vork-shell
        </p>
      </section>
      <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
      <p v-if="message" role="status" class="text-sm break-all">{{ message }}</p>
    </dialog-content></Dialog
  >
</template>
