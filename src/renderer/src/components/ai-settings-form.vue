<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { AiSettings, AiSettingsView } from '../../../shared/contracts'
const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{
  saved: [settings: AiSettingsView]
  loaded: [settings: AiSettingsView]
}>()
const provider = ref<AiSettings['provider']>('openai-compatible'),
  baseUrl = ref(''),
  model = ref(''),
  maxTokens = ref(4096),
  apiKey = ref(''),
  hasKey = ref(false),
  clearKey = ref(false),
  proxyUrl = ref(''),
  proxyUsername = ref(''),
  proxyPassword = ref(''),
  hasProxyPassword = ref(false),
  clearProxyPassword = ref(false),
  busy = ref(false),
  loaded = ref(false),
  error = ref(''),
  notice = ref('')
function changeProvider(value: unknown) {
  provider.value = value as AiSettings['provider']
  if (
    !baseUrl.value ||
    ['https://api.openai.com/v1', 'https://api.anthropic.com/v1'].includes(baseUrl.value)
  )
    baseUrl.value =
      provider.value === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'
}
async function load() {
  busy.value = true
  error.value = ''
  try {
    const settings = await window.vork.aiSettings()
    provider.value = settings.provider
    baseUrl.value = settings.baseUrl
    model.value = settings.model
    maxTokens.value = settings.maxTokens || 4096
    hasKey.value = settings.hasApiKey
    proxyUrl.value = settings.proxyUrl || ''
    proxyUsername.value = settings.proxyUsername || ''
    hasProxyPassword.value = settings.hasProxyPassword
    loaded.value = true
    emit('loaded', settings)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function save() {
  if (busy.value || props.disabled || !loaded.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const settings = await window.vork.saveAiSettings({
      provider: provider.value,
      baseUrl: baseUrl.value,
      model: model.value,
      maxTokens: Number(maxTokens.value),
      proxyUrl: proxyUrl.value,
      proxyUsername: proxyUsername.value,
      ...(clearKey.value ? { apiKey: '' } : apiKey.value ? { apiKey: apiKey.value } : {}),
      ...(clearProxyPassword.value
        ? { proxyPassword: '' }
        : proxyPassword.value
          ? { proxyPassword: proxyPassword.value }
          : {}),
    })
    hasKey.value = settings.hasApiKey
    apiKey.value = ''
    clearKey.value = false
    proxyUrl.value = settings.proxyUrl || ''
    proxyUsername.value = settings.proxyUsername || ''
    proxyPassword.value = ''
    hasProxyPassword.value = settings.hasProxyPassword
    clearProxyPassword.value = false
    notice.value = 'AI 配置已保存'
    emit('saved', settings)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
onMounted(load)
</script>
<template>
  <form class="space-y-3 rounded-md border p-4" @submit.prevent="save">
    <p class="text-sm font-medium">AI 服务配置</p>
    <Label class="grid gap-2"
      ><span>服务类型</span
      ><Select
        :model-value="provider"
        :disabled="busy || disabled"
        @update:model-value="changeProvider"
        ><select-trigger aria-label="AI 服务类型"><select-value /></select-trigger
        ><select-content
          ><select-item value="openai">OpenAI</select-item
          ><select-item value="openai-compatible">OpenAI 兼容 / 本地模型</select-item
          ><select-item value="anthropic">Claude / Anthropic</select-item></select-content
        ></Select
      ></Label
    >
    <Label class="grid gap-2"
      ><span>API 基础地址（含 /v1）</span
      ><Input
        v-model="baseUrl"
        aria-label="AI 服务地址"
        placeholder="http://127.0.0.1:11434/v1"
        :disabled="busy || disabled"
    /></Label>
    <div class="grid gap-3 sm:grid-cols-2">
      <Label class="grid gap-2"
        ><span>模型名称</span
        ><Input
          v-model="model"
          aria-label="AI 模型名称"
          placeholder="填写服务提供的模型 ID"
          :disabled="busy || disabled" /></Label
      ><Label class="grid gap-2"
        ><span>输出 Token 上限</span
        ><Input
          v-model="maxTokens"
          type="number"
          min="256"
          max="16384"
          aria-label="AI 输出上限"
          :disabled="busy || disabled"
      /></Label>
    </div>
    <Label class="grid gap-2"
      ><span>API Key {{ hasKey ? '（已保存，留空保留）' : '（本地无认证服务可留空）' }}</span
      ><Input
        v-model="apiKey"
        aria-label="AI API Key"
        type="password"
        autocomplete="new-password"
        :disabled="busy || disabled || clearKey"
    /></Label>
    <Label v-if="hasKey" class="flex items-center gap-2 text-sm"
      ><checkbox v-model="clearKey" :disabled="busy || disabled" />清除已保存的 Key</Label
    >
    <Label class="grid gap-2"
      ><span>HTTP(S) 代理（可选，仅用于连接 AI 服务）</span
      ><Input
        v-model="proxyUrl"
        aria-label="AI 代理地址"
        placeholder="http://127.0.0.1:7890"
        :disabled="busy || disabled"
    /></Label>
    <div class="grid gap-3 sm:grid-cols-2">
      <Label class="grid gap-2"
        ><span>代理用户名（可选）</span
        ><Input
          v-model="proxyUsername"
          aria-label="AI 代理用户名"
          autocomplete="off"
          :disabled="busy || disabled" /></Label
      ><Label class="grid gap-2"
        ><span>代理密码 {{ hasProxyPassword ? '（已保存，留空保留）' : '（无认证可留空）' }}</span
        ><Input
          v-model="proxyPassword"
          aria-label="AI 代理密码"
          type="password"
          autocomplete="new-password"
          :disabled="busy || disabled || clearProxyPassword"
      /></Label>
    </div>
    <Label v-if="hasProxyPassword" class="flex items-center gap-2 text-sm"
      ><checkbox
        v-model="clearProxyPassword"
        :disabled="busy || disabled"
      />清除已保存的代理密码</Label
    >
    <p class="text-muted-foreground text-xs">
      Key 与代理密码由系统加密保存，不回传界面。更换服务类型或服务域名时，留空会清除旧
      Key。更换代理主机或端口且留空密码时，不保留旧密码。请求仅在主动发送时发生，默认流式输出；服务若返回完整
      JSON 仍可使用。
    </p>
    <alert v-if="error" variant="destructive"
      ><alert-description>{{ error }}</alert-description></alert
    >
    <p v-if="notice" role="status" class="text-sm">{{ notice }}</p>
    <div class="flex gap-2">
      <Button
        type="submit"
        variant="outline"
        :disabled="busy || disabled || !loaded || !model.trim()"
        >保存 AI 配置</Button
      ><Button v-if="!loaded" type="button" variant="ghost" :disabled="busy" @click="load"
        >重新读取配置</Button
      >
    </div>
  </form>
</template>
