<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useMutation } from '@tanstack/vue-query'
import {
  Folder,
  File,
  Download,
  Upload,
  RefreshCw,
  ArrowUp,
  Plus,
  X,
  Pencil,
  Trash2,
} from '@lucide/vue'
import TransferMeter from './transfer-meter.vue'
import TerminalPanel from './terminal-panel.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from '@/components/ui/table'
import type {
  Session,
  SshRequest,
  SshResponse,
  Tunnel,
  SshBatchTransferResult,
  TransferProgress,
} from '../../../shared/contracts'
const props = defineProps<{ session: Session; active: boolean; closed: boolean }>()
const selectedFiles = ref<string[]>([]),
  batchResults = ref<SshBatchTransferResult['results']>([])
const mode = ref('terminal'),
  path = ref('.'),
  listing = ref<Extract<SshResponse, { kind: 'listing' }>>(),
  tunnels = ref<Tunnel[]>([]),
  error = ref(''),
  notice = ref('')
const modal = ref<'mkdir' | 'tunnel' | 'rename' | 'delete' | null>(null),
  directoryName = ref(''),
  host = ref('127.0.0.1'),
  port = ref('3306'),
  localPort = ref('0')
const fileTarget = ref(''),
  progress = ref<TransferProgress>()
function fileAction(kind: 'rename' | 'delete', name: string) {
  fileTarget.value = child(name)
  directoryName.value = name
  error.value = ''
  modal.value = kind
}
async function cancelTransfer() {
  try {
    await window.vork.sshTransferCancel(props.session.id)
  } catch (e) {
    error.value = (e as Error).message
  }
}
const defaultPrepared = ref(false)
const terminalIds = ref(['default']),
  focusedTerminal = ref('default'),
  splitDirection = ref<'horizontal' | 'vertical'>('horizontal'),
  terminalBusy = ref(false)
let panelDisposed = false
let unsubscribeTerminal: (() => void) | undefined
async function split(direction: 'horizontal' | 'vertical') {
  if (props.closed || terminalBusy.value || terminalIds.value.length >= 4) return
  terminalBusy.value = true
  error.value = ''
  try {
    const id = await window.vork.sshTerminalOpen(props.session.id)
    if (panelDisposed || props.closed) {
      await window.vork.sshTerminalClose(props.session.id, id)
      return
    }
    terminalIds.value.push(id)
    focusedTerminal.value = id
    splitDirection.value = direction
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    terminalBusy.value = false
  }
}
async function closeTerminal(id: string) {
  if (props.closed || terminalBusy.value || terminalIds.value.length <= 1) return
  terminalBusy.value = true
  try {
    await window.vork.sshTerminalClose(props.session.id, id)
    terminalIds.value = terminalIds.value.filter((value) => value !== id)
    focusedTerminal.value = terminalIds.value[0]!
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    terminalBusy.value = false
  }
}
onMounted(async () => {
  unsubscribeTerminal = window.vork.onEvent((event) => {
    if (event.sessionId !== props.session.id) return
    if (event.type === 'transfer') {
      progress.value = JSON.parse(event.data) as TransferProgress
      return
    }
    if (!event.channelId || event.type === 'data') return
    if (event.type === 'error') error.value = event.data
    terminalIds.value = terminalIds.value.filter((id) => id !== event.channelId)
    focusedTerminal.value = terminalIds.value[0] || ''
  })
  try {
    if (!props.closed) await window.vork.sshTerminalOpen(props.session.id, 'default')
    if (!panelDisposed) defaultPrepared.value = true
  } catch (e) {
    if (!panelDisposed) error.value = `无法恢复默认终端：${(e as Error).message}`
  }
})
onBeforeUnmount(() => {
  panelDisposed = true
  unsubscribeTerminal?.()
  for (const id of terminalIds.value)
    if (id !== 'default') void window.vork.sshTerminalClose(props.session.id, id).catch(() => {})
})
const tunnelsLoaded = ref(false)
watch(mode, () => {
  tunnelsLoaded.value = false
})
const currentPath = computed(() => listing.value?.path || '.')
function child(name: string) {
  return (currentPath.value === '/' ? '' : currentPath.value) + '/' + name
}
const mutation = useMutation({
  mutationFn: (request: SshRequest) => window.vork.sshRequest(props.session.id, request),
  retry: false,
  async onSuccess(response, request) {
    error.value = ''
    if (response.kind === 'listing') {
      listing.value = response
      path.value = response.path
      selectedFiles.value = []
    }
    if (response.kind === 'tunnels') tunnels.value = response.tunnels
    if (response.kind === 'done' && request.kind === 'tunnel-stop')
      tunnels.value = tunnels.value.filter((tunnel) => tunnel.id !== request.id)
    if (response.kind === 'done') {
      modal.value = null
      notice.value = '操作完成'
      if (['rename', 'delete', 'mkdir'].includes(request.kind)) {
        try {
          const fresh = await window.vork.sshRequest(props.session.id, {
            kind: 'list',
            path: currentPath.value,
          })
          if (fresh.kind === 'listing') {
            listing.value = fresh
            selectedFiles.value = []
          }
        } catch (e) {
          error.value = (e as Error).message
        }
      }
    }
    if (response.kind === 'tunnels') modal.value = null
  },
  onError(e) {
    error.value = e.message
  },
})
const transfer = useMutation({
  mutationFn: ({ kind, path }: { kind: 'upload' | 'download'; path: string }) =>
    window.vork.sshTransfer(props.session.id, kind, path),
  retry: false,
  onSuccess(result) {
    if (result.canceled) notice.value = '传输已取消，SSH 连接仍可使用'
    else {
      notice.value = `传输完成：${result.file} · ${result.bytes} bytes`
      notice.value += ' · 请刷新目录'
    }
  },
  onError(e) {
    error.value = e.message
  },
})
const batchTransfer = useMutation({
  mutationFn: ({
    kind,
    selection,
  }: {
    kind: 'upload' | 'download'
    selection: string | string[]
  }) => window.vork.sshTransferBatch(props.session.id, kind, selection),
  retry: false,
  onSuccess(result) {
    batchResults.value = result.results
    if (result.canceled) notice.value = '批量传输已取消，已完成的文件保留；SSH 连接仍可使用'
    else {
      notice.value = `批量传输完成：${result.results.filter((file) => file.ok).length} 成功，${result.results.filter((file) => !file.ok).length} 失败 · 请刷新目录`
    }
  },
  onError(e) {
    error.value = e.message
  },
})
function selectable(entry: { name: string; regularFile?: boolean }) {
  return (
    entry.regularFile === true && !/[/\\:\0�]/.test(entry.name) && !['.', '..'].includes(entry.name)
  )
}
const downloadable = computed(
  () =>
    listing.value?.entries
      .filter(selectable)
      .slice(0, 100)
      .map((entry) => entry.name) || [],
)
function toggleSelection(name: string, checked: unknown) {
  if (checked === true && !selectedFiles.value.includes(name) && selectedFiles.value.length < 100)
    selectedFiles.value.push(name)
  else if (checked !== true)
    selectedFiles.value = selectedFiles.value.filter((value) => value !== name)
}
function selectAll(checked: unknown) {
  selectedFiles.value = checked === true ? [...downloadable.value] : []
}
function downloadSelected() {
  if (!props.closed && !busy.value && selectedFiles.value.length) {
    error.value = ''
    progress.value = undefined
    batchResults.value = []
    batchTransfer.mutate({ kind: 'download', selection: selectedFiles.value.map(child) })
  }
}
const busy = computed(
  () => mutation.isPending.value || transfer.isPending.value || batchTransfer.isPending.value,
)
function request(request: SshRequest) {
  if (props.closed || busy.value) return
  error.value = ''
  mutation.mutate(request)
}
function load(next = path.value) {
  request({ kind: 'list', path: next })
}
function up() {
  load(currentPath.value.split('/').slice(0, -1).join('/') || '/')
}
function download(name: string) {
  if (!props.closed && !busy.value) {
    error.value = ''
    progress.value = undefined
    transfer.mutate({ kind: 'download', path: child(name) })
  }
}
function upload() {
  if (!props.closed && !busy.value && listing.value) {
    error.value = ''
    progress.value = undefined
    batchResults.value = []
    batchTransfer.mutate({ kind: 'upload', selection: currentPath.value })
  }
}
function submit() {
  if (modal.value === 'rename') {
    request({ kind: 'rename', path: fileTarget.value, newName: directoryName.value })
    return
  }
  if (modal.value === 'delete') {
    request({ kind: 'delete', path: fileTarget.value })
    return
  }
  if (modal.value === 'mkdir') {
    if (
      !directoryName.value ||
      /[/\0]/.test(directoryName.value) ||
      ['.', '..'].includes(directoryName.value)
    ) {
      error.value = '请输入不含斜杠的目录名'
      return
    }
    request({ kind: 'mkdir', path: child(directoryName.value) })
  } else
    request({
      kind: 'tunnel-start',
      host: host.value.trim(),
      port: Number(port.value),
      localPort: Number(localPort.value),
    })
}
function stopTunnel(id: string) {
  request({ kind: 'tunnel-stop', id })
}
watch([mode, busy], ([next, pending]) => {
  if (next === 'tunnels' && !pending && !props.closed && !tunnelsLoaded.value) {
    tunnelsLoaded.value = true
    request({ kind: 'tunnels' })
  }
})
watch(
  () => props.closed,
  (closed) => {
    if (closed) tunnels.value = []
  },
)
async function cancel() {
  try {
    await window.vork.cancel(props.session.id)
  } catch (e) {
    error.value = (e as Error).message
  }
}
function openDirectoryDialog() {
  directoryName.value = ''
  modal.value = 'mkdir'
}
</script>
<template>
  <tabs v-model="mode" class="flex h-full min-h-0 flex-col">
    <div class="flex h-11 shrink-0 items-center justify-between border-b px-4">
      <tabs-list class="h-8"
        ><tabs-trigger value="terminal" class="text-xs">终端</tabs-trigger
        ><tabs-trigger value="files" class="text-xs">SFTP 文件</tabs-trigger
        ><tabs-trigger value="tunnels" class="text-xs">SSH 隧道</tabs-trigger></tabs-list
      ><Button
        v-if="busy && !transfer.isPending.value && !batchTransfer.isPending.value"
        variant="outline"
        size="xs"
        @click="cancel"
        >停止并断开</Button
      >
    </div>
    <alert v-if="error" variant="destructive" class="m-3 w-auto"
      ><alert-description class="text-xs break-all">{{ error }}</alert-description></alert
    ><alert v-if="notice" class="m-3 w-auto"
      ><alert-description class="text-xs break-all"
        >{{ notice
        }}<Button variant="ghost" size="xs" aria-label="关闭 SSH 提示" @click="notice = ''"
          ><x :size="12" /></Button></alert-description
    ></alert>
    <tabs-content
      v-show="mode === 'terminal'"
      value="terminal"
      force-mount
      class="flex min-h-0 flex-1 flex-col"
    >
      <div class="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <Button
          variant="outline"
          size="xs"
          :disabled="closed || terminalBusy || terminalIds.length >= 4"
          @click="split('horizontal')"
          >水平分屏</Button
        ><Button
          variant="outline"
          size="xs"
          :disabled="closed || terminalBusy || terminalIds.length >= 4"
          @click="split('vertical')"
          >垂直分屏</Button
        ><span class="text-muted-foreground text-xs">{{ terminalIds.length }} / 4 个独立终端</span>
      </div>
      <div
        class="flex min-h-0 flex-1"
        :class="splitDirection === 'horizontal' ? 'flex-row' : 'flex-col'"
      >
        <div
          v-for="(id, index) in terminalIds"
          :key="id"
          class="flex min-h-0 min-w-0 flex-1 flex-col border"
          :class="focusedTerminal === id ? 'border-primary/50' : 'border-border'"
          @focusin="focusedTerminal = id"
          @pointerdown="focusedTerminal = id"
        >
          <div class="flex shrink-0 items-center justify-between border-b px-3 py-1">
            <span class="text-muted-foreground text-[10px]">终端 {{ index + 1 }}</span
            ><Button
              v-if="terminalIds.length > 1"
              variant="ghost"
              size="xs"
              :aria-label="`关闭终端 ${index + 1}`"
              :disabled="closed || terminalBusy"
              @click.stop="closeTerminal(id)"
              ><x :size="12"
            /></Button>
          </div>
          <terminal-panel
            v-if="id !== 'default' || defaultPrepared"
            class="min-h-0 flex-1"
            :session-id="session.id"
            :channel-id="id"
            :active="active && mode === 'terminal'"
          />
        </div>
      </div>
      <p v-if="!terminalIds.length" class="text-muted-foreground p-5 text-xs">
        终端已结束，可点击分屏创建新的终端。
      </p>
    </tabs-content>
    <tabs-content
      v-show="mode === 'files'"
      value="files"
      force-mount
      class="flex min-h-0 flex-1 flex-col"
    >
      <form class="flex shrink-0 items-center gap-2 border-b p-3" @submit.prevent="load()">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="size-8"
          aria-label="SFTP 上级目录"
          :disabled="closed || busy || !listing"
          @click="up"
          ><arrow-up :size="14" /></Button
        ><Input
          v-model="path"
          aria-label="SFTP 路径"
          class="h-8 min-w-0 flex-1 font-mono text-xs"
          :disabled="closed || busy"
        /><Button type="submit" variant="outline" size="sm" :disabled="closed || busy"
          ><refresh-cw :size="13" />读取目录</Button
        ><Button
          type="button"
          variant="outline"
          size="sm"
          :disabled="closed || busy || !listing"
          @click="openDirectoryDialog()"
          ><plus :size="13" />新建目录</Button
        ><Button
          type="button"
          variant="outline"
          size="sm"
          :disabled="closed || busy || !listing"
          @click="upload"
          ><Upload :size="13" />多选上传</Button
        ><Button
          type="button"
          variant="outline"
          size="sm"
          :disabled="closed || busy || !selectedFiles.length"
          @click="downloadSelected"
          ><Download :size="13" />下载选中 ({{ selectedFiles.length }})</Button
        >
      </form>
      <transfer-meter
        v-if="progress && (transfer.isPending.value || batchTransfer.isPending.value)"
        :progress="progress"
        @cancel="cancelTransfer"
      />
      <div class="scroll-area min-h-0 flex-1 overflow-auto">
        <Table v-if="listing"
          ><table-header
            ><table-row
              ><table-head class="w-10"
                ><checkbox
                  :model-value="
                    downloadable.length > 0 &&
                    downloadable.every((name) => selectedFiles.includes(name))
                  "
                  :disabled="closed || busy || !downloadable.length"
                  aria-label="选择前 100 个普通文件"
                  @update:model-value="selectAll" /></table-head
              ><table-head>名称</table-head><table-head>大小</table-head
              ><table-head>修改时间</table-head
              ><table-head class="w-28" /></table-row></table-header
          ><table-body
            ><table-row v-for="entry in listing.entries" :key="entry.name"
              ><table-cell
                ><checkbox
                  v-if="selectable(entry)"
                  :model-value="selectedFiles.includes(entry.name)"
                  :disabled="
                    closed ||
                    busy ||
                    (!selectedFiles.includes(entry.name) && selectedFiles.length >= 100)
                  "
                  :aria-label="`选择文件 ${entry.name}`"
                  @update:model-value="
                    (checked) => toggleSelection(entry.name, checked)
                  " /></table-cell
              ><table-cell class="max-w-[450px]"
                ><Button
                  variant="ghost"
                  class="h-auto max-w-full justify-start px-1 py-1 text-left font-mono text-xs has-[>svg]:px-1"
                  :title="entry.name"
                  :disabled="closed || busy || entry.name.includes('�')"
                  @click="entry.directory ? load(child(entry.name)) : download(entry.name)"
                  ><folder v-if="entry.directory" class="text-primary size-4 shrink-0" /><file
                    v-else
                    class="size-4 shrink-0"
                  /><span class="min-w-0 truncate">{{ entry.name }}</span></Button
                ></table-cell
              ><table-cell class="text-muted-foreground text-xs">{{
                entry.directory ? '—' : `${entry.size} bytes`
              }}</table-cell
              ><table-cell class="text-muted-foreground text-xs">{{
                new Date(entry.modified * 1000).toLocaleString()
              }}</table-cell
              ><table-cell
                ><div class="flex items-center justify-end">
                  <Button
                    variant="ghost"
                    size="icon"
                    class="size-7"
                    :aria-label="`重命名 ${entry.name}`"
                    :disabled="closed || busy || entry.name.includes('�')"
                    @click="fileAction('rename', entry.name)"
                    ><pencil :size="13" /></Button
                  ><Button
                    variant="ghost"
                    size="icon"
                    class="text-destructive size-7"
                    :aria-label="`删除 ${entry.name}`"
                    :disabled="closed || busy || entry.name.includes('�')"
                    @click="fileAction('delete', entry.name)"
                    ><trash2 :size="13" /></Button
                  ><Button
                    v-if="!entry.directory"
                    variant="ghost"
                    size="icon"
                    class="size-7"
                    :aria-label="`下载 ${entry.name}`"
                    :disabled="closed || busy || entry.name.includes('�')"
                    @click="download(entry.name)"
                    ><Download :size="13"
                  /></Button></div></table-cell></table-row></table-body
        ></Table>
        <p v-else class="text-muted-foreground p-10 text-center text-sm">
          点击读取目录，使用当前 SSH 身份浏览文件。
        </p>
        <p v-if="listing?.truncated" class="text-muted-foreground p-3 text-xs">
          仅展示前 2000 项，请进入具体子目录。
        </p>
      </div>
      <div v-if="batchResults.length" class="max-h-40 shrink-0 overflow-auto border-t px-4 py-2">
        <div class="mb-1 flex items-center justify-between">
          <span class="text-xs">逐文件结果</span
          ><Button
            variant="ghost"
            size="xs"
            aria-label="关闭批量传输结果"
            @click="batchResults = []"
            ><x :size="12"
          /></Button>
        </div>
        <p
          v-for="(result, index) in batchResults"
          :key="index"
          class="py-1 text-xs break-all"
          :class="result.ok ? 'text-muted-foreground' : 'text-destructive'"
        >
          {{ result.name }} · {{ result.ok ? `完成 ${result.bytes} bytes` : result.error }}
        </p>
      </div>
      <p class="text-muted-foreground shrink-0 border-t px-4 py-2 text-[10px]">
        每批最多 100 个普通文件 · 批量下载不覆盖本地文件 · 上传不覆盖已有远端文件 · 普通文件上限 100
        MiB · 取消传输保留 SSH 连接 · 删除目录仅限空目录
      </p>
    </tabs-content>
    <tabs-content
      v-show="mode === 'tunnels'"
      value="tunnels"
      force-mount
      class="min-h-0 flex-1 overflow-auto p-5"
      ><div class="mb-5 flex items-center justify-between">
        <p class="text-muted-foreground text-xs">
          通过当前 SSH 连接转发本机端口，可在数据库连接表单中使用 127.0.0.1。
        </p>
        <Button size="sm" :disabled="closed || busy" @click="modal = 'tunnel'"
          ><plus :size="13" />新建隧道</Button
        >
      </div>
      <div
        v-for="tunnel in tunnels"
        :key="tunnel.id"
        class="mb-3 flex items-center justify-between rounded border p-4"
      >
        <span class="font-mono text-xs"
          >127.0.0.1:{{ tunnel.localPort }} → {{ tunnel.host }}:{{ tunnel.port }}</span
        ><Button
          variant="outline"
          size="xs"
          :disabled="closed || busy"
          @click="stopTunnel(tunnel.id)"
          >关闭隧道</Button
        >
      </div>
      <p v-if="!tunnels.length" class="text-muted-foreground p-10 text-center text-xs">
        尚未创建隧道。只监听本机回环地址，关闭 SSH 会话时自动释放。
      </p></tabs-content
    >
    <Dialog
      :open="modal !== null"
      @update:open="
        (next) => {
          if (!next && !busy) modal = null
        }
      "
      ><dialog-content
        ><dialog-header
          ><dialog-title>{{
            modal === 'mkdir'
              ? '新建远端目录'
              : modal === 'rename'
                ? '重命名远端文件'
                : modal === 'delete'
                  ? '确认删除远端文件'
                  : '新建 SSH 本地隧道'
          }}</dialog-title
          ><dialog-description>{{
            modal === 'rename' || modal === 'delete'
              ? fileTarget
              : modal === 'mkdir'
                ? currentPath
                : '目标主机与端口由 SSH 服务器访问。本地端口 0 表示自动分配。'
          }}</dialog-description></dialog-header
        >
        <form class="space-y-4" @submit.prevent="submit">
          <Label v-if="modal === 'mkdir' || modal === 'rename'" class="grid gap-2"
            >名称<Input v-model="directoryName" aria-label="SFTP 新目录名" :disabled="busy"
          /></Label>
          <p v-else-if="modal === 'delete'" class="text-destructive text-sm">
            删除无法恢复。目录仅允许删除空目录，不会递归删除内容。
          </p>
          <template v-else
            ><Label class="grid gap-2"
              >远端目标主机<Input
                v-model="host"
                aria-label="隧道目标主机"
                :disabled="busy" /></Label
            ><Label class="grid gap-2"
              >远端目标端口<Input
                v-model="port"
                aria-label="隧道目标端口"
                type="number"
                min="1"
                max="65535"
                :disabled="busy" /></Label
            ><Label class="grid gap-2"
              >本地监听端口<Input
                v-model="localPort"
                aria-label="隧道本地端口"
                type="number"
                min="0"
                max="65535"
                :disabled="busy" /></Label></template
          ><alert v-if="error" variant="destructive"
            ><alert-description>{{ error }}</alert-description></alert
          >
          <div class="flex justify-end gap-2">
            <Button type="button" variant="outline" :disabled="busy" @click="modal = null"
              >取消</Button
            ><Button type="submit" :disabled="closed || busy">{{
              busy
                ? '处理中…'
                : modal === 'delete'
                  ? '确认删除'
                  : modal === 'rename'
                    ? '确认重命名'
                    : '创建'
            }}</Button>
          </div>
        </form></dialog-content
      ></Dialog
    >
  </tabs>
</template>
