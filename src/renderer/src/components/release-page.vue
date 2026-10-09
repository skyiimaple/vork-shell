<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import history from '../../../shared/release-history.json'
import type { UpdateState, UpdateAction } from '../../../shared/contracts'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const search = ref(''),
  state = ref<UpdateState>({ currentVersion: history.version, status: 'disabled' }),
  error = ref(''),
  working = ref(false)
const entries = computed(() =>
  history.entries.filter((entry) =>
    JSON.stringify(entry).toLowerCase().includes(search.value.toLowerCase().trim()),
  ),
)
const labels: Record<UpdateState['status'], string> = {
  disabled: '此版本未启用在线更新，请从发布渠道获取新版本。',
  idle: '点击检查更新，查看是否有新版本。',
  checking: '正在检查更新…',
  latest: '当前已是最新版本。',
  available: '发现可用更新。',
  downloading: '正在下载更新…',
  downloaded: '更新已下载，可保存工作后重启安装。',
  installing: '正在准备重启安装…',
  error: '更新失败，请稍后重试。',
}
let timer: ReturnType<typeof setInterval> | undefined
async function read() {
  if (!window.vork) return
  try {
    state.value = await window.vork.updateState()
  } catch (e) {
    error.value = (e as Error).message
  }
}
watch(
  () => props.open,
  (open) => {
    clearInterval(timer)
    if (open) {
      void read()
      timer = setInterval(() => void read(), 1000)
    }
  },
)
onBeforeUnmount(() => clearInterval(timer))
async function action(value: UpdateAction) {
  if (working.value) return
  working.value = true
  error.value = ''
  try {
    state.value = await window.vork.updateAction(value)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    working.value = false
  }
}
</script>
<template>
  <Dialog :open="open" @update:open="(value) => emit('update:open', value)"
    ><dialog-content class="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-4xl"
      ><dialog-header
        ><dialog-title class="text-2xl">版本日志</dialog-title
        ><dialog-description
          >Vork Shell · v{{ state?.currentVersion || history.version }} ·
          {{
            history.released ? '已发布' : history.title + ' · 尚未发布'
          }}。按实际开发日期查看功能迭代。</dialog-description
        ></dialog-header
      >
      <div class="bg-muted/30 shrink-0 space-y-3 rounded-lg border p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="text-sm">
            <p>{{ state ? labels[state.status] : '正在读取版本信息…' }}</p>
            <p v-if="state?.version" class="text-muted-foreground mt-1 text-xs">
              新版本 v{{ state.version }}
            </p>
          </div>
          <div class="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              :disabled="
                !state ||
                state.status === 'disabled' ||
                working ||
                ['downloading', 'downloaded', 'installing'].includes(state.status)
              "
              @click="action('check')"
              >检查更新</Button
            ><Button
              v-if="state?.status === 'available'"
              size="sm"
              :disabled="working"
              @click="action('download')"
              >下载更新</Button
            ><Button
              v-if="state?.status === 'downloaded'"
              size="sm"
              :disabled="working"
              @click="action('install')"
              >重启安装</Button
            >
          </div>
        </div>
        <Progress
          v-if="state?.status === 'downloading'"
          :model-value="state.percent || 0"
          aria-label="更新下载进度"
        /><alert v-if="error || state?.error" variant="destructive"
          ><alert-description class="break-all">{{
            error || state?.error
          }}</alert-description></alert
        >
      </div>
      <Input
        v-model="search"
        aria-label="搜索版本日志"
        placeholder="搜索日期或功能，例如 SSH、Redis…"
        class="shrink-0"
      />
      <div
        class="scroll-area min-h-0 flex-1 space-y-7 overflow-auto pr-3"
        aria-label="版本迭代时间线"
      >
        <article
          v-for="entry in entries"
          :key="entry.date"
          class="border-primary/25 relative border-l-2 pl-5"
        >
          <div class="mb-3 flex flex-wrap items-center gap-3">
            <badge variant="secondary" class="font-mono">{{ entry.date }}</badge>
            <h2 class="font-medium">{{ entry.title }}</h2>
          </div>
          <ul class="text-muted-foreground space-y-3 text-sm leading-6">
            <li v-for="change in entry.changes" :key="change">{{ change }}</li>
          </ul>
        </article>
        <p v-if="!entries.length" class="text-muted-foreground py-8 text-center text-sm">
          没有匹配的迭代记录。
        </p>
      </div></dialog-content
    ></Dialog
  >
</template>
