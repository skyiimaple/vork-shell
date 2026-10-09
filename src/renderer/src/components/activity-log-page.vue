<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import type { ActivityEntry } from '../../../shared/contracts'
const open = defineModel<boolean>('open', { default: false })
const rows = ref<ActivityEntry[]>([]),
  path = ref(''),
  search = ref(''),
  level = ref('all'),
  error = ref(''),
  message = ref(''),
  busy = ref(false)
const visible = computed(() =>
  rows.value.filter(
    (row) =>
      (level.value === 'all' || row.level === level.value) &&
      [row.action, row.connection, row.message]
        .join(' ')
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
)
async function read() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await window.vork.activityLogs()
    rows.value = result.entries
    path.value = result.path
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function exportLogs() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const file = await window.vork.exportActivityLogs()
    if (file) message.value = '已导出到 ' + file
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
watch(open, (value) => {
  if (value) void read()
})
const labels: Record<string, string> = {
  connect: '连接',
  disconnect: '关闭连接',
  reconnect: '重新连接',
  execute: '执行命令 / 查询',
  'execute-script': '执行脚本',
  'save-profile': '保存配置',
  'delete-profile': '删除配置',
  'import-confirm': '导入配置',
  'export-connections': '导出配置',
  closed: '连接关闭',
  error: '连接异常',
}
</script>
<template>
  <Dialog v-model:open="open"
    ><dialog-content class="flex max-h-[90vh] flex-col sm:max-w-5xl"
      ><dialog-header
        ><dialog-title>操作与错误日志</dialog-title
        ><dialog-description
          >显示最近 2000 条，导出包含保留文件中的全部记录。每个文件最多约 5
          MiB，保留当前与上一份文件。时间按本地时区显示。</dialog-description
        ></dialog-header
      >
      <p class="text-muted-foreground text-xs break-all">本地文件：{{ path || '读取中…' }}</p>
      <div class="flex flex-wrap gap-2">
        <Input
          v-model="search"
          aria-label="搜索操作日志"
          placeholder="搜索连接、操作或错误"
          class="min-w-40 flex-1"
        /><Select v-model="level"
          ><select-trigger aria-label="日志级别" class="w-32"><select-value /></select-trigger
          ><select-content
            ><select-item value="all">全部日志</select-item
            ><select-item value="info">操作日志</select-item
            ><select-item value="error">错误日志</select-item></select-content
          ></Select
        ><Button variant="outline" :disabled="busy" @click="read">刷新</Button
        ><Button :disabled="busy" @click="exportLogs">导出日志</Button>
      </div>
      <p v-if="error" role="alert" class="text-destructive text-sm">{{ error }}</p>
      <p v-if="message" role="status" class="text-sm break-all">{{ message }}</p>
      <div class="min-h-0 overflow-auto rounded-lg border">
        <Table
          ><table-header
            ><table-row
              ><table-head>时间</table-head><table-head>级别</table-head
              ><table-head>操作</table-head><table-head>连接</table-head
              ><table-head>详情</table-head></table-row
            ></table-header
          ><table-body
            ><table-row v-for="(row, index) in visible" :key="index"
              ><table-cell class="text-xs whitespace-nowrap">{{
                new Date(row.time).toLocaleString()
              }}</table-cell
              ><table-cell :class="row.level === 'error' ? 'text-destructive' : ''">{{
                row.level === 'error' ? '错误' : '操作'
              }}</table-cell
              ><table-cell>{{ labels[row.action] || row.action }}</table-cell
              ><table-cell class="max-w-48 break-all">{{ row.connection || '—' }}</table-cell
              ><table-cell class="max-w-80 break-all whitespace-normal">{{
                row.message
              }}</table-cell></table-row
            ><table-row v-if="!visible.length"
              ><table-cell :colspan="5" class="text-muted-foreground py-8 text-center">{{
                busy ? '读取中…' : '暂无匹配日志'
              }}</table-cell></table-row
            ></table-body
          ></Table
        >
      </div>
    </dialog-content></Dialog
  >
</template>
