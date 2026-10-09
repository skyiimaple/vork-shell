<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Upload, LoaderCircle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { ConnectionImportPreview } from '../../../shared/contracts'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  imported: [result: { imported: number; skipped: number }]
}>()
const preview = ref<ConnectionImportPreview | null>(null),
  selected = ref<number[]>([]),
  busy = ref(false),
  error = ref('')
const ready = computed(() => preview.value?.rows.filter((row) => row.status === 'ready') || [])
const allSelected = computed(
  () => ready.value.length > 0 && selected.value.length === ready.value.length,
)
watch(
  () => props.open,
  async (open) => {
    if (open) {
      preview.value = null
      selected.value = []
      error.value = ''
    } else {
      preview.value = null
      selected.value = []
      try {
        await window.vork.cancelConnectionImport()
      } catch {
        /* Window may already be closed. */
      }
    }
  },
)
async function choose() {
  busy.value = true
  error.value = ''
  try {
    preview.value = await window.vork.previewConnectionImport()
    selected.value = ready.value.map((row) => row.index)
  } catch (e) {
    preview.value = null
    selected.value = []
    error.value = e instanceof Error ? e.message : '读取失败'
  } finally {
    busy.value = false
  }
}
function toggle(index: number, value: boolean | 'indeterminate') {
  selected.value =
    value === true
      ? [...selected.value.filter((i) => i !== index), index]
      : selected.value.filter((i) => i !== index)
}
function selectAll(value: boolean | 'indeterminate') {
  selected.value = value === true ? ready.value.map((row) => row.index) : []
}
async function importSelected() {
  if (!preview.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await window.vork.confirmConnectionImport(preview.value.token, [
      ...selected.value,
    ])
    emit('imported', result)
    emit('update:open', false)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '导入失败'
  } finally {
    busy.value = false
  }
}
function setOpen(value: boolean) {
  if (!busy.value) emit('update:open', value)
}
</script>
<template>
  <Dialog :open="open" @update:open="setOpen">
    <dialog-content class="flex max-h-[85vh] flex-col sm:max-w-3xl">
      <dialog-header
        ><dialog-title>导入连接配置</dialog-title
        ><dialog-description
          >支持 Vork Shell JSON、Another Redis Desktop Manager 的 .ano 和 Redis 连接
          JSON。预览后保存，不会自动连接或覆盖已有连接。</dialog-description
        ></dialog-header
      >
      <Button variant="outline" class="self-start" :disabled="busy" @click="choose"
        ><loader-circle v-if="busy" :size="14" class="animate-spin" /><Upload v-else :size="14" />{{
          preview ? '重新选择文件' : '选择配置文件'
        }}</Button
      >
      <alert v-if="error" variant="destructive"
        ><alert-description>{{ error }}</alert-description></alert
      >
      <template v-if="preview">
        <p class="text-muted-foreground text-sm">
          {{ preview.fileName }} · 共 {{ preview.rows.length }} 条 · 可导入 {{ ready.length }} 条 ·
          已选择 {{ selected.length }} 条
        </p>
        <p class="text-muted-foreground text-xs">
          密码仅在主进程读取并加密保存；重复连接按地址、端口、用户、数据库和 TLS
          判断。重复或不支持的配置不可选择。
        </p>
        <div class="min-h-0 overflow-auto rounded-md border">
          <Table
            ><table-header
              ><table-row
                ><table-head class="w-10"
                  ><checkbox
                    aria-label="选择全部可导入连接"
                    :model-value="allSelected"
                    :disabled="busy || !ready.length"
                    @update:model-value="selectAll" /></table-head
                ><table-head>连接</table-head><table-head>地址</table-head
                ><table-head>状态</table-head></table-row
              ></table-header
            >
            <table-body
              ><table-row v-for="row in preview.rows" :key="row.index">
                <table-cell
                  ><checkbox
                    :aria-label="`选择导入 ${row.name}`"
                    :disabled="busy || row.status !== 'ready'"
                    :model-value="selected.includes(row.index)"
                    @update:model-value="(value) => toggle(row.index, value)"
                /></table-cell>
                <table-cell class="max-w-48 break-all"
                  >{{ row.name
                  }}<span v-if="row.hasPassword" class="text-muted-foreground block text-xs"
                    >含密码</span
                  ></table-cell
                >
                <table-cell class="max-w-56 font-mono text-xs break-all">{{
                  row.host ? `${row.host}:${row.port}` : '—'
                }}</table-cell>
                <table-cell
                  class="max-w-64 text-xs"
                  :class="row.status === 'invalid' ? 'text-destructive' : 'text-muted-foreground'"
                  >{{
                    row.status === 'ready'
                      ? '可导入'
                      : row.status === 'duplicate'
                        ? '重复，跳过'
                        : row.error
                  }}</table-cell
                >
              </table-row></table-body
            >
          </Table>
        </div>
      </template>
      <dialog-footer
        ><Button variant="outline" :disabled="busy" @click="setOpen(false)">取消</Button
        ><Button :disabled="busy || !selected.length" @click="importSelected">{{
          busy ? '处理中…' : `确认导入 ${selected.length} 条`
        }}</Button></dialog-footer
      >
    </dialog-content>
  </Dialog>
</template>
