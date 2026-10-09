<script setup lang="ts">
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { computed, reactive, ref, watch } from 'vue'
import { FolderOpen, LoaderCircle, ArrowUpRight } from '@lucide/vue'
import ConnectionTypeIcon from './connection-type-icon.vue'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ConnectionConfig, ConnectionType, Session } from '../../../shared/contracts'
import { testConnection, connectProfile } from '@/lib/connection-actions'
const props = defineProps<{ open: boolean; profile?: ConnectionConfig }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  connected: [session: Session]
  saved: []
}>()
const form = reactive<ConnectionConfig>({
  type: 'ssh',
  name: '',
  group: '',
  favorite: false,
  host: '',
  port: 22,
  username: '',
  password: '',
  database: '',
  authSource: 'admin',
  path: '',
  privateKey: '',
  passphrase: '',
  tls: false,
})
const sshProfiles = ref<ConnectionConfig[]>([])
const tunnelChoice = computed({
  get: () => (form.sshProfileId ? 'profile:' + form.sshProfileId : 'direct'),
  set: (value: string) => {
    form.sshProfileId = value === 'direct' ? undefined : value.slice(8)
  },
})
const connecting = ref(false),
  saving = ref(false),
  testing = ref(false),
  error = ref(''),
  tested = ref('')
const busy = computed(() => connecting.value || saving.value || testing.value)
const types: { type: ConnectionType; label: string; hint: string }[] = [
  { type: 'ssh', label: 'SSH', hint: '远程终端' },
  { type: 'sqlite', label: 'SQLite', hint: '本地数据库' },
  { type: 'mysql', label: 'MySQL', hint: '关系型数据库' },
  { type: 'postgresql', label: 'PostgreSQL', hint: '关系型数据库' },
  { type: 'redis', label: 'Redis', hint: '键值数据库' },
  { type: 'mongodb', label: 'MongoDB', hint: '文档数据库' },
]
watch(
  () => props.open,
  async (open) => {
    error.value = ''
    tested.value = ''
    if (open)
      Object.assign(
        form,
        {
          id: undefined,
          type: 'ssh',
          name: '',
          group: '',
          favorite: false,
          host: 'localhost',
          port: 22,
          username: '',
          password: '',
          database: '',
          authSource: 'admin',
          path: '',
          privateKey: '',
          passphrase: '',
          tls: false,
          sshProfileId: undefined,
        },
        props.profile || {},
      )
    if (open) {
      try {
        sshProfiles.value = (await window.vork.profiles()).filter(
          (profile) => profile.type === 'ssh',
        )
      } catch (e) {
        error.value = (e as Error).message
      }
    } else {
      form.password = ''
      form.passphrase = ''
    }
  },
)
function select(type: ConnectionType) {
  if (busy.value || form.type === type) return
  form.type = type
  if (['ssh', 'sqlite', 'mongodb'].includes(type)) form.sshProfileId = undefined
  form.port = { ssh: 22, sqlite: 0, mysql: 3306, postgresql: 5432, redis: 6379, mongodb: 27017 }[
    type
  ]
  form.id = undefined
  error.value = ''
}
async function pick(kind: 'sqlite' | 'key') {
  try {
    const path = await window.vork.pickFile(kind)
    if (path) {
      if (kind === 'sqlite') form.path = path
      else form.privateKey = path
    }
  } catch (e) {
    error.value = (e as Error).message
  }
}
function config() {
  return {
    ...form,
    authSource: form.type === 'mongodb' ? form.authSource : undefined,
    name:
      form.name.trim() ||
      `${types.find((t) => t.type === form.type)!.label} · ${form.type === 'sqlite' ? form.path?.split('/').pop() || 'local' : form.host}`,
    port: Number(form.port),
  }
}
async function connect() {
  if (busy.value) return
  connecting.value = true
  error.value = ''
  try {
    const session = await connectProfile(window.vork, config())
    emit('saved')
    emit('connected', session)
    emit('update:open', false)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    connecting.value = false
  }
}
async function save() {
  if (busy.value) return
  saving.value = true
  error.value = ''
  try {
    await window.vork.saveProfile(config())
    emit('saved')
    emit('update:open', false)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}
watch(form, () => {
  tested.value = ''
  error.value = ''
})
async function test() {
  if (busy.value) return
  testing.value = true
  error.value = ''
  tested.value = ''
  try {
    await testConnection(window.vork, config())
    tested.value = '连接测试成功，测试会话已释放。'
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    testing.value = false
  }
}
</script>
<template>
  <Dialog
    :open="open"
    @update:open="
      (v) => {
        if (!busy) emit('update:open', v)
      }
    "
  >
    <dialog-content
      class="max-h-[calc(100vh-2rem)] gap-3 overflow-y-auto px-6 py-4 sm:max-w-[660px]"
    >
      <dialog-header class="gap-1"
        ><dialog-title class="text-xl">{{ profile?.id ? '编辑连接' : '新建连接' }}</dialog-title
        ><dialog-description
          >选择连接类型，进入你的服务器或数据库。</dialog-description
        ></dialog-header
      >
      <div class="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <Button
          v-for="t in types"
          :key="t.type"
          variant="ghost"
          class="h-auto whitespace-normal shadow-none"
          type="button"
          :disabled="busy"
          :class="[
            'hover:bg-accent flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2.5 transition-colors',
            form.type === t.type
              ? 'border-primary bg-accent text-primary'
              : 'text-muted-foreground',
          ]"
          @click="select(t.type)"
        >
          <connection-type-icon :type="t.type" :size="21" /><span class="text-xs font-medium">{{
            t.label
          }}</span>
        </Button>
      </div>
      <!-- Let main-process validation report inline errors instead of silently blocking submission. -->
      <form class="space-y-3" novalidate @submit.prevent="connect">
        <fieldset :disabled="busy" class="space-y-3">
          <Label class="grid gap-2"
            ><span>连接名称</span><Input v-model="form.name" placeholder="例如：开发服务器"
          /></Label>
          <p class="text-muted-foreground text-xs">
            连接自动按类型分组。保存后，可从连接操作菜单加入项目。
          </p>
          <template v-if="form.type === 'sqlite'">
            <Label class="grid gap-2"
              ><span>数据库文件</span>
              <div class="flex gap-2">
                <Input v-model="form.path" placeholder="选择文件，或输入 :memory:" /><Button
                  type="button"
                  variant="outline"
                  @click="pick('sqlite')"
                  ><folder-open :size="16" />浏览</Button
                >
              </div></Label
            >
            <p class="text-muted-foreground text-xs">
              :memory: 创建临时数据库，断开连接后数据会释放。
            </p>
          </template>
          <template v-else>
            <div class="grid grid-cols-[1fr_110px] gap-4">
              <Label class="grid gap-2"
                ><span>主机</span><Input v-model="form.host" placeholder="localhost 或 IP" /></Label
              ><Label class="grid gap-2"
                ><span>端口</span><Input v-model="form.port" type="number" min="1" max="65535"
              /></Label>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <Label class="grid gap-2"
                ><span>用户名{{ ['redis', 'mongodb'].includes(form.type) ? '（可选）' : '' }}</span
                ><Input v-model="form.username" autocomplete="off" /></Label
              ><Label class="grid gap-2"
                ><span>密码{{ form.privateKey ? '（可选）' : '' }}</span
                ><Input v-model="form.password" type="password" autocomplete="new-password"
              /></Label>
            </div>
            <template v-if="form.type === 'ssh'"
              ><Label class="grid gap-2"
                ><span>私钥文件（可选）</span>
                <div class="flex gap-2">
                  <Input v-model="form.privateKey" placeholder="使用密码或私钥认证" /><Button
                    variant="outline"
                    type="button"
                    @click="pick('key')"
                    ><folder-open :size="16"
                  /></Button></div></Label
              ><Label v-if="form.privateKey" class="grid gap-2"
                ><span>私钥口令（可选）</span
                ><Input v-model="form.passphrase" type="password" /></Label
            ></template>
            <template v-else
              ><Label class="grid gap-2"
                ><span>{{ form.type === 'redis' ? '数据库编号' : '数据库名称（可选）' }}</span
                ><Input
                  v-model="form.database"
                  :placeholder="form.type === 'redis' ? '0' : '默认数据库'" /></Label
              ><Label v-if="form.type === 'mongodb'" class="grid gap-2"
                ><span>认证数据库</span
                ><Input
                  v-model="form.authSource"
                  placeholder="admin"
                  aria-label="MongoDB 认证数据库"
                />
                <span class="text-muted-foreground text-xs"
                  >没有启用认证时，用户名和密码均可留空。首版使用主机与端口连接。</span
                > </Label
              ><Label class="flex items-center gap-2 text-sm"
                ><checkbox
                  v-model="form.tls"
                  :disabled="busy"
                  aria-label="使用 TLS（验证服务器证书）"
                />使用 TLS（验证服务器证书）</Label
              ><Label v-if="form.type !== 'mongodb'" class="grid gap-2"
                ><span>SSH 隧道（可选）</span
                ><Select v-model="tunnelChoice" :disabled="busy"
                  ><select-trigger aria-label="数据库 SSH 隧道"><select-value /></select-trigger
                  ><select-content
                    ><select-item value="direct">直接连接</select-item
                    ><select-item
                      v-for="sshProfile in sshProfiles"
                      :key="sshProfile.id"
                      :value="'profile:' + sshProfile.id"
                      >{{ sshProfile.name }}</select-item
                    ></select-content
                  ></Select
                ><span class="text-muted-foreground text-xs"
                  >选择已保存的 SSH 配置；主机和端口由 SSH
                  服务器访问。隧道随此数据库连接关闭。</span
                ></Label
              ></template
            >
          </template>
        </fieldset>
        <alert v-if="tested" class="text-sm"
          ><alert-description>{{ tested }}</alert-description></alert
        >
        <alert
          v-if="error"
          variant="destructive"
          class="bg-destructive/10 text-destructive rounded-md p-3 text-sm break-all"
          ><alert-description>{{ error }}</alert-description></alert
        >
        <div class="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <span class="text-muted-foreground max-w-[180px] text-xs"
            >保存配置时，密码与私钥口令使用系统加密保存。</span
          >
          <div class="flex gap-2">
            <Button variant="outline" type="button" :disabled="busy" @click="test"
              ><loader-circle v-if="testing" :size="14" class="animate-spin" />{{
                testing ? '测试中…' : '测试连接'
              }}</Button
            ><Button variant="outline" type="button" :disabled="busy" @click="save">保存配置</Button
            ><Button type="submit" :disabled="busy"
              ><loader-circle v-if="connecting" :size="16" class="animate-spin" /><arrow-up-right
                v-else
                :size="16"
              />{{ connecting ? '连接中…' : '连接' }}</Button
            >
          </div>
        </div>
      </form>
    </dialog-content>
  </Dialog>
</template>
