<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import AiSettingsForm from './ai-settings-form.vue'
import type { Session, AiRequest, AiResponse, AiSettingsView } from '../../../shared/contracts'
const props = defineProps<{
  session: Session
  sql: string
  lastError: string
  context: string
  closed: boolean
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ load: [sql: string] }>()
const action = ref<AiRequest['action']>('generate'),
  prompt = ref(''),
  sqlInput = ref(''),
  errorInput = ref(''),
  includeContext = ref(false),
  showSettings = ref(false),
  settings = ref<AiSettingsView>(),
  busy = ref(false),
  error = ref(''),
  response = ref<AiResponse>(),
  streamText = ref(''),
  sqlOutput = ref(''),
  requestId = ref(''),
  followUp = ref(false)
const history = ref<{ role: 'user' | 'assistant'; content: string }[]>([])
const canSend = computed(
  () =>
    !busy.value &&
    !props.closed &&
    Boolean(settings.value?.model) &&
    Boolean(prompt.value.trim() || sqlInput.value.trim()),
)
let mounted = true
const stopProgress = window.vork.onAiProgress((progress) => {
  if (
    progress?.id === requestId.value &&
    typeof progress.text === 'string' &&
    !response.value &&
    open.value
  )
    streamText.value = progress.text
})
watch(open, async (value) => {
  if (value) {
    sqlInput.value = props.sql
    errorInput.value = props.lastError
    error.value = ''
    try {
      settings.value = await window.vork.aiSettings()
      showSettings.value = !settings.value.model
    } catch (e) {
      error.value = (e as Error).message
    }
  } else if (requestId.value) void window.vork.aiCancel(requestId.value).catch(() => {})
})
async function send() {
  if (!canSend.value) return
  const id = crypto.randomUUID()
  requestId.value = id
  busy.value = true
  error.value = ''
  response.value = undefined
  streamText.value = ''
  sqlOutput.value = ''
  try {
    const result = await window.vork.aiComplete(props.session.id, {
      id,
      action: action.value,
      prompt: prompt.value,
      sql: sqlInput.value,
      error: action.value === 'fix' ? errorInput.value : '',
      ...(includeContext.value ? { context: props.context } : {}),
      ...(followUp.value ? { history: history.value.map((message) => ({ ...message })) } : {}),
    })
    if (!mounted || !open.value) return
    response.value = result
    streamText.value = ''
    sqlOutput.value = result.sql || ''
    history.value = [
      ...(followUp.value ? history.value : []),
      { role: 'user' as const, content: prompt.value + '\nSQL:\n' + sqlInput.value },
      { role: 'assistant' as const, content: result.text },
    ].slice(-20)
  } catch (e) {
    if (mounted && open.value) {
      error.value = (e as Error).message
      streamText.value = ''
    }
  } finally {
    if (mounted && requestId.value === id) {
      busy.value = false
      requestId.value = ''
    }
  }
}
async function cancel() {
  try {
    await window.vork.aiCancel(requestId.value)
  } catch (e) {
    error.value = (e as Error).message
  }
}
async function copy() {
  if (!response.value) return
  try {
    await navigator.clipboard.writeText(response.value.text)
  } catch {
    error.value = '复制失败，请检查剪贴板权限'
  }
}
function saved(value: AiSettingsView) {
  settings.value = value
  showSettings.value = false
  error.value = ''
}
function apply() {
  if (sqlOutput.value.trim()) {
    emit('load', sqlOutput.value)
    open.value = false
  }
}
function clear() {
  history.value = []
  response.value = undefined
  streamText.value = ''
  sqlOutput.value = ''
  followUp.value = false
  error.value = ''
}
onBeforeUnmount(() => {
  mounted = false
  stopProgress()
  if (requestId.value) void window.vork.aiCancel(requestId.value).catch(() => {})
})
</script>
<template>
  <Dialog v-model:open="open"
    ><dialog-content class="flex max-h-[90vh] flex-col sm:max-w-4xl"
      ><dialog-header
        ><dialog-title>AI SQL 助手</dialog-title
        ><dialog-description
          >{{ session.type.toUpperCase() }} ·
          内容发送至你配置的模型服务。回答逐步显示，生成结果需审查，不会自动执行。</dialog-description
        ></dialog-header
      >
      <div class="min-h-0 space-y-4 overflow-auto">
        <div class="flex items-center justify-between gap-3 text-sm">
          <span class="min-w-0 truncate">{{ settings?.model || '尚未配置模型' }}</span
          ><Button
            variant="outline"
            size="sm"
            :disabled="busy"
            @click="showSettings = !showSettings"
            >模型配置</Button
          >
        </div>
        <ai-settings-form
          v-if="showSettings"
          :disabled="busy"
          @loaded="settings = $event"
          @saved="saved"
        />
        <div class="grid gap-3 sm:grid-cols-[150px_1fr]">
          <Select v-model="action" :disabled="busy"
            ><select-trigger aria-label="AI SQL 操作"><select-value /></select-trigger
            ><select-content
              ><select-item value="generate">生成 SQL</select-item
              ><select-item value="explain">解释 SQL</select-item
              ><select-item value="optimize">优化 SQL</select-item
              ><select-item value="fix">修复 SQL</select-item></select-content
            ></Select
          ><Textarea
            v-model="prompt"
            aria-label="AI 需求"
            placeholder="描述需求、说明希望修改的地方，或继续追问…"
            :disabled="busy"
          />
        </div>
        <Label class="grid gap-2"
          ><span>本次发送的 SQL（可修改）</span
          ><Textarea
            v-model="sqlInput"
            aria-label="AI SQL 输入"
            class="min-h-24 font-mono text-xs"
            :disabled="busy"
        /></Label>
        <Label v-if="action === 'fix'" class="grid gap-2"
          ><span>错误信息（可修改）</span
          ><Textarea v-model="errorInput" aria-label="AI 错误信息" :disabled="busy"
        /></Label>
        <div class="flex flex-wrap gap-4 text-sm">
          <Label class="flex items-center gap-2"
            ><checkbox
              v-model="includeContext"
              :disabled="busy || !context"
            />附带已加载的表名和字段</Label
          ><Label class="flex items-center gap-2"
            ><checkbox
              v-model="followUp"
              :disabled="busy || !history.length"
            />携带本次对话继续追问</Label
          >
        </div>
        <pre
          v-if="includeContext"
          class="max-h-32 overflow-auto rounded-md border p-3 text-xs whitespace-pre-wrap"
          >{{ context }}</pre>
        <div class="flex gap-2">
          <Button :disabled="!canSend" @click="send">发送给 AI</Button
          ><Button v-if="busy" variant="outline" @click="cancel">取消 AI 请求</Button
          ><Button variant="ghost" :disabled="busy" @click="clear">清空对话</Button>
        </div>
        <alert v-if="error" variant="destructive"
          ><alert-description>{{ error }}</alert-description></alert
        >
        <template v-if="response || streamText"
          ><p v-if="response?.truncated" class="text-destructive text-sm">
            模型输出达到上限，请增加上限或缩小问题；当前内容可能不完整。
          </p>
          <p v-if="busy && !response" class="text-muted-foreground text-sm">
            正在接收模型输出，完成后才能填入 SQL。
          </p>
          <pre
            aria-label="AI 回答"
            class="max-h-72 overflow-auto rounded-md border p-4 text-sm break-all whitespace-pre-wrap"
            >{{ response?.text || streamText }}</pre>
          <Label v-if="sqlOutput && response" class="grid gap-2"
            ><span>待填入的 SQL（可编辑）</span
            ><Textarea
              v-model="sqlOutput"
              aria-label="AI SQL 建议"
              class="min-h-32 font-mono text-xs"
          /></Label>
          <div class="flex gap-2">
            <Button
              v-if="sqlOutput && response"
              :disabled="busy || response.truncated"
              @click="apply"
              >替换编辑器内容</Button
            ><Button variant="outline" :disabled="!response" @click="copy">复制回答</Button>
          </div></template
        >
      </div>
    </dialog-content></Dialog
  >
</template>
