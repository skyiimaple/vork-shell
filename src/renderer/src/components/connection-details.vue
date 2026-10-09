<script setup lang="ts">
import { ref, computed } from 'vue'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { Session, ConnectionDetails, RedisOverview } from '../../../shared/contracts'
const props = defineProps<{ session: Session; database?: number; closed?: boolean }>()
const open = ref(false),
  details = ref<ConnectionDetails>(),
  error = ref(''),
  loading = ref(false),
  overview = ref<RedisOverview>(),
  runtime = ref<{ key: string; value: string }[]>([]),
  runtimeError = ref(''),
  search = ref('')
const infoRows = computed(() =>
  Object.entries(overview.value?.info || {})
    .filter(([key, value]) =>
      (key + ' ' + value).toLowerCase().includes(search.value.toLowerCase()),
    )
    .sort(([a], [b]) => a.localeCompare(b)),
)
const cards = computed(() => {
  const info = overview.value?.info || {}
  return [
    { title: '服务器', fields: ['redis_version', 'os', 'process_id'] },
    { title: '内存', fields: ['used_memory_human', 'used_memory_peak_human', 'used_memory_lua'] },
    {
      title: '状态',
      fields: ['connected_clients', 'total_connections_received', 'total_commands_processed'],
    },
  ].map((card) => ({ ...card, rows: card.fields.map((key) => ({ key, value: info[key] || '—' })) }))
})
async function show() {
  open.value = true
  details.value = undefined
  overview.value = undefined
  runtime.value = []
  runtimeError.value = ''
  error.value = ''
  loading.value = true
  try {
    details.value = await window.vork.connectionDetails(props.session.id)
    try {
      if (props.session.type === 'redis') {
        const result = await window.vork.redisRequest(props.session.id, {
          kind: 'info',
          database: props.database ?? props.session.database ?? 0,
        })
        if (result.kind !== 'info') throw new Error('运行信息响应无效')
        overview.value = result
      } else if (props.session.type === 'mongodb') {
        const result = await window.vork.mongoRequest(props.session.id, { kind: 'info' })
        if (result.kind === 'info')
          runtime.value = [
            { key: 'MongoDB 版本', value: result.version },
            { key: '默认数据库', value: result.database || '未指定' },
          ]
      } else if (props.session.type !== 'ssh') {
        const sql = {
          sqlite: 'SELECT sqlite_version() AS sqlite_version;',
          mysql:
            'SELECT VERSION() AS version, DATABASE() AS current_database, CURRENT_USER() AS authenticated_user, @@hostname AS hostname, @@port AS port, @@character_set_server AS character_set, @@collation_server AS collation;',
          postgresql:
            "SELECT version() AS version, current_database() AS current_database, current_user AS current_user, inet_server_addr()::text AS server_address, inet_server_port() AS port, current_setting('server_encoding') AS encoding;",
        }[props.session.type]
        const result = await window.vork.execute(props.session.id, sql)
        runtime.value = result.columns.map((key, index) => ({
          key,
          value: String(result.rows[0]?.[index] ?? '—'),
        }))
        if (props.session.type === 'sqlite') {
          for (const pragma of ['page_size', 'page_count', 'freelist_count', 'journal_mode']) {
            const result = await window.vork.execute(props.session.id, 'PRAGMA ' + pragma)
            runtime.value.push({ key: pragma, value: String(result.rows[0]?.[0] ?? '—') })
          }
        }
      }
    } catch (e) {
      runtimeError.value = e instanceof Error ? e.message : '运行信息读取失败'
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : '读取失败'
    error.value = message.includes("No handler registered for 'vork:connection-details'")
      ? '应用主进程仍为旧版本，请重启应用后重新连接。'
      : message
  } finally {
    loading.value = false
  }
}
</script>
<template>
  <Button variant="outline" size="xs" :disabled="closed" aria-label="查看当前连接详情" @click="show"
    >连接详情</Button
  >
  <Dialog v-model:open="open"
    ><dialog-content class="flex max-h-[90vh] flex-col sm:max-w-5xl"
      ><dialog-header
        ><dialog-title>当前连接详情</dialog-title
        ><dialog-description
          >本次连接使用的配置，密码和密钥不在详情中显示。</dialog-description
        ></dialog-header
      >
      <p v-if="loading" class="text-muted-foreground text-sm">读取中…</p>
      <alert v-if="error" variant="destructive"
        ><alert-description>{{ error }}</alert-description></alert
      >
      <div class="min-h-0 space-y-4 overflow-y-auto pr-1">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold">连接配置</h3>
          <Button variant="outline" size="sm" :disabled="loading || closed" @click="show"
            >刷新</Button
          >
        </div>
        <dl v-if="details" class="grid grid-cols-[90px_1fr] gap-3 text-sm">
          <dt>名称</dt>
          <dd class="break-all">{{ details.name }}</dd>
          <dt>类型</dt>
          <dd>{{ details.type }}</dd>
          <dt>目标</dt>
          <dd class="font-mono break-all">
            {{ details.host ? `${details.host}:${details.port}` : details.path }}
          </dd>
          <dt v-if="session.type !== 'sqlite'">用户</dt>
          <dd v-if="session.type !== 'sqlite'" class="break-all">
            {{ details.username || '默认用户' }}
          </dd>
          <dt v-if="session.type === 'mongodb'">认证数据库</dt>
          <dd v-if="session.type === 'mongodb'">{{ details.authSource || 'admin' }}</dd>
          <dt v-if="session.type !== 'ssh'">数据库</dt>
          <dd v-if="session.type !== 'ssh'">{{ database ?? details.database ?? '默认' }}</dd>
          <dt v-if="['redis', 'mysql', 'postgresql', 'mongodb'].includes(session.type)">TLS</dt>
          <dd v-if="['redis', 'mysql', 'postgresql', 'mongodb'].includes(session.type)">
            {{ details.tls ? '已启用' : '未启用' }}
          </dd>
          <dt v-if="['redis', 'mysql', 'postgresql'].includes(session.type)">SSH 隧道</dt>
          <dd v-if="['redis', 'mysql', 'postgresql'].includes(session.type)" class="break-all">
            {{ details.sshProfileId ? '已启用 · ' + session.target : '未使用' }}
          </dd>
        </dl>
        <alert v-if="runtimeError" variant="destructive"
          ><alert-description
            >运行信息读取失败：{{ runtimeError }}。连接配置仍可查看。</alert-description
          ></alert
        >
        <template v-if="overview">
          <div class="grid gap-3 sm:grid-cols-3">
            <section
              v-for="card in cards"
              :key="card.title"
              class="space-y-3 rounded-lg border p-4"
            >
              <h3 class="text-sm font-semibold">{{ card.title }}</h3>
              <dl class="space-y-2">
                <div
                  v-for="row in card.rows"
                  :key="row.key"
                  class="bg-muted/40 rounded p-2 text-xs"
                >
                  <dt class="text-muted-foreground">{{ row.key }}</dt>
                  <dd class="mt-1 break-all">{{ row.value }}</dd>
                </div>
              </dl>
            </section>
          </div>
          <section class="rounded-lg border">
            <h3 class="border-b p-3 text-sm font-semibold">数据库键统计</h3>
            <Table
              ><table-header
                ><table-row
                  ><table-head>DB</table-head><table-head>Keys</table-head
                  ><table-head>Expires</table-head><table-head>Avg TTL (ms)</table-head></table-row
                ></table-header
              ><table-body
                ><table-row v-for="db in overview.databases" :key="db.database"
                  ><table-cell>db{{ db.database }}</table-cell
                  ><table-cell>{{ db.keys.toLocaleString() }}</table-cell
                  ><table-cell>{{ db.expires.toLocaleString() }}</table-cell
                  ><table-cell>{{ db.avgTtl.toLocaleString() }}</table-cell></table-row
                ></table-body
              ></Table
            >
          </section>
          <section class="rounded-lg border">
            <div class="flex items-center gap-3 border-b p-3">
              <h3 class="shrink-0 text-sm font-semibold">Redis 信息全集</h3>
              <Input v-model="search" aria-label="搜索 Redis INFO" placeholder="搜索 Key / Value" />
            </div>
            <Table
              ><table-header
                ><table-row
                  ><table-head>Key</table-head><table-head>Value</table-head></table-row
                ></table-header
              ><table-body
                ><table-row v-for="[key, value] in infoRows" :key="key" class="even:bg-muted/30"
                  ><table-cell class="font-mono text-xs">{{ key }}</table-cell
                  ><table-cell class="max-w-xl break-all whitespace-normal">{{
                    value
                  }}</table-cell></table-row
                ></table-body
              ></Table
            >
          </section>
        </template>
        <section v-if="runtime.length" class="rounded-lg border">
          <h3 class="border-b p-3 text-sm font-semibold">
            {{ session.type.toUpperCase() }} 运行信息
          </h3>
          <Table
            ><table-header
              ><table-row
                ><table-head>项目</table-head><table-head>值</table-head></table-row
              ></table-header
            ><table-body
              ><table-row v-for="row in runtime" :key="row.key"
                ><table-cell>{{ row.key }}</table-cell
                ><table-cell class="max-w-xl break-all whitespace-normal">{{
                  row.value
                }}</table-cell></table-row
              ></table-body
            ></Table
          >
        </section>
        <p
          v-if="session.type === 'ssh'"
          class="text-muted-foreground rounded-lg border p-4 text-sm"
        >
          SSH 会话 · 主机、端口和用户见配置摘要。服务器系统与资源信息请通过终端按需查询。
        </p>
      </div>
    </dialog-content></Dialog
  >
</template>
