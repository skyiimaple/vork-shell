<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  RefreshCw,
  Database as DatabaseIcon,
  Folder,
  FileJson,
  Plus,
  Pencil,
  Trash2,
  Search,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import type { Session, MongoDocuments, MongoRequest } from '../../../shared/contracts'
const props = defineProps<{ session: Session; closed?: boolean }>()
const databases = ref<string[]>([]),
  collections = ref<string[]>([])
const database = ref(''),
  collection = ref(''),
  manualDatabase = ref(''),
  collectionSearch = ref('')
const filter = ref('{}'),
  sort = ref('{}'),
  busy = ref(false),
  error = ref(''),
  notice = ref('')
const page = ref<MongoDocuments>(),
  selected = ref(0),
  indexes = ref<string[]>([]),
  tab = ref('documents')
const modal = ref<'insert' | 'replace' | 'delete' | ''>(''),
  draft = ref(''),
  modalError = ref('')
const modalOpen = computed({
  get: () => Boolean(modal.value),
  set: (value: boolean) => {
    if (!value && !busy.value) modal.value = ''
  },
})
const blocked = computed(() => busy.value || props.closed)
const visibleCollections = computed(() =>
  collections.value.filter((name) =>
    name.toLowerCase().includes(collectionSearch.value.toLowerCase()),
  ),
)
const document = computed(() => page.value?.documents[selected.value])
const editable = computed(() =>
  Boolean(
    document.value &&
    document.value.length <= 1024 * 1024 &&
    Object.hasOwn(JSON.parse(document.value), '_id'),
  ),
)
const pretty = (text: string) => JSON.stringify(JSON.parse(text), null, 2)
const request = (r: MongoRequest) => window.vork.mongoRequest(props.session.id, r)
async function run(action: () => Promise<void>) {
  if (blocked.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await action()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
function clearResults() {
  page.value = undefined
  selected.value = 0
  indexes.value = []
}
async function readCollections(name: string) {
  database.value = name
  collection.value = ''
  collections.value = []
  clearResults()
  const result = await request({ kind: 'collections', database: name })
  if (result.kind !== 'collections') throw new Error('集合列表响应无效')
  collections.value = result.names
  if (result.truncated) notice.value = '集合列表仅显示前 2000 项'
}
async function refresh() {
  await run(async () => {
    const result = await request({ kind: 'databases' })
    if (result.kind !== 'databases') throw new Error('数据库列表响应无效')
    databases.value = result.names
    const target = database.value || result.defaultDatabase || result.names[0]
    if (target) await readCollections(target)
    if (result.truncated) notice.value = '数据库列表仅显示前 2000 项'
  })
}
async function query(pageNumber = 0) {
  clearResults()
  tab.value = 'documents'
  const result = await request({
    kind: 'find',
    database: database.value,
    collection: collection.value,
    filter: filter.value,
    sort: sort.value,
    page: pageNumber,
    pageSize: 50,
  })
  if (result.kind !== 'documents') throw new Error('文档响应无效')
  page.value = result
  if (result.truncated) notice.value = '结果超过 4 MiB，请缩小查询条件；当前结果未完整显示'
}
async function selectCollection(name: string) {
  await run(async () => {
    collection.value = name
    filter.value = '{}'
    sort.value = '{}'
    await query()
  })
}
async function readIndexes() {
  await run(async () => {
    const result = await request({
      kind: 'indexes',
      database: database.value,
      collection: collection.value,
    })
    if (result.kind !== 'indexes') throw new Error('索引响应无效')
    indexes.value = result.documents
    tab.value = 'indexes'
    if (result.truncated) notice.value = '索引结果过大，仅显示部分内容'
  })
}
function begin(operation: 'insert' | 'replace' | 'delete') {
  modal.value = operation
  modalError.value = ''
  draft.value = operation === 'insert' ? '{\n  "name": ""\n}' : pretty(document.value!)
}
async function mutate() {
  if (blocked.value) return
  busy.value = true
  modalError.value = ''
  try {
    const r: MongoRequest =
      modal.value === 'insert'
        ? {
            kind: 'insert',
            database: database.value,
            collection: collection.value,
            document: draft.value,
          }
        : modal.value === 'replace'
          ? {
              kind: 'replace',
              snapshotId: page.value!.snapshotId,
              rowIndex: selected.value,
              document: draft.value,
            }
          : { kind: 'delete', snapshotId: page.value!.snapshotId, rowIndex: selected.value }
    await request(r)
    modal.value = ''
    notice.value = '文档操作完成'
    await query(page.value?.page || 0)
  } catch (e) {
    if (modal.value) modalError.value = (e as Error).message
    else error.value = '操作已完成，但刷新失败：' + (e as Error).message
  } finally {
    busy.value = false
  }
}
watch(
  () => props.closed,
  (closed) => {
    if (!closed) void refresh()
    else {
      modal.value = ''
      clearResults()
    }
  },
  { immediate: true },
)
</script>
<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex min-h-0 flex-1">
      <aside class="flex w-60 shrink-0 flex-col gap-3 overflow-auto border-r p-3">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium">数据库 / 集合</span
          ><Button
            variant="ghost"
            size="xs"
            :disabled="blocked"
            aria-label="刷新 MongoDB 数据库"
            @click="refresh"
            ><refresh-cw :size="14"
          /></Button>
        </div>
        <form
          class="flex gap-2"
          @submit.prevent="run(() => readCollections(manualDatabase.trim()))"
        >
          <Input
            v-model="manualDatabase"
            aria-label="MongoDB 数据库名称"
            placeholder="直接打开数据库"
            :disabled="blocked"
          /><Button
            type="submit"
            variant="outline"
            size="sm"
            :disabled="blocked || !manualDatabase.trim()"
            >打开</Button
          >
        </form>
        <p class="text-muted-foreground text-xs">列出有权访问的数据库，也可直接输入名称。</p>
        <div class="space-y-1">
          <Button
            v-for="name in databases"
            :key="name"
            variant="ghost"
            class="w-full justify-start overflow-hidden"
            :class="database === name ? 'bg-accent' : ''"
            :disabled="blocked"
            :aria-label="`MongoDB 数据库 ${name}`"
            @click="run(() => readCollections(name))"
            ><database-icon :size="14" /><span class="truncate">{{ name }}</span></Button
          >
        </div>
        <template v-if="database"
          ><div class="border-t pt-3 text-sm font-medium break-all">{{ database }}</div>
          <Input v-model="collectionSearch" aria-label="筛选 MongoDB 集合" placeholder="筛选集合" />
          <div class="space-y-1">
            <Button
              v-for="name in visibleCollections"
              :key="name"
              variant="ghost"
              class="w-full justify-start overflow-hidden"
              :class="collection === name ? 'bg-accent' : ''"
              :disabled="blocked"
              :aria-label="`MongoDB 集合 ${name}`"
              @click="selectCollection(name)"
              ><folder :size="14" /><span class="truncate">{{ name }}</span></Button
            >
          </div>
          <p v-if="!collections.length && !busy" class="text-muted-foreground text-xs">
            此数据库暂无集合。
          </p></template
        >
      </aside>
      <section class="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
        <alert v-if="error" variant="destructive"
          ><alert-description class="break-all">{{ error }}</alert-description></alert
        >
        <alert v-if="notice"
          ><alert-description>{{ notice }}</alert-description></alert
        >
        <template v-if="collection">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="text-sm font-medium break-all">{{ database }} / {{ collection }}</h2>
            <Button
              variant="outline"
              size="sm"
              :disabled="blocked"
              aria-label="新增 MongoDB 文档"
              @click="begin('insert')"
              ><plus :size="14" />新增文档</Button
            >
          </div>
          <form
            class="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3"
            @submit.prevent="run(() => query())"
          >
            <Label class="grid gap-2"
              ><span>查询条件</span
              ><Textarea
                v-model="filter"
                aria-label="MongoDB 查询条件"
                class="h-20 min-h-20 font-mono text-xs"
                :disabled="blocked"
                placeholder='{"status": "active"}'
            /></Label>
            <Label class="grid gap-2"
              ><span>排序（1 升序，-1 降序）</span
              ><Textarea
                v-model="sort"
                aria-label="MongoDB 排序条件"
                class="h-20 min-h-20 font-mono text-xs"
                :disabled="blocked"
                placeholder='{"_id": -1}'
            /></Label>
            <Button type="submit" :disabled="blocked" aria-label="查询 MongoDB 文档"
              ><search :size="14" />
              {{ busy ? '读取中…' : '查询' }}</Button
            >
          </form>
          <p class="text-muted-foreground text-xs">
            支持 JSON / Extended JSON，例如 {"_id":{"$oid":"…"}}。每页 50 条；输入查询对象，无需编写
            mongosh 脚本。
          </p>
          <tabs v-model="tab" class="flex min-h-0 flex-1 flex-col"
            ><tabs-list class="shrink-0"
              ><tabs-trigger value="documents">文档</tabs-trigger
              ><tabs-trigger
                value="indexes"
                aria-label="查看 MongoDB 索引"
                :disabled="blocked"
                @click="readIndexes"
                >索引</tabs-trigger
              ></tabs-list
            >
            <tabs-content value="documents" class="flex min-h-0 flex-1 flex-col gap-3">
              <div
                v-if="page"
                class="text-muted-foreground flex shrink-0 items-center justify-between text-xs"
              >
                <span
                  >{{ page.documents.length }} 条 · 第 {{ page.page + 1 }} 页 ·
                  {{ page.elapsedMs }} ms</span
                >
                <div class="flex gap-2">
                  <Button
                    variant="outline"
                    size="xs"
                    :disabled="blocked || page.page === 0"
                    aria-label="MongoDB 上一页"
                    @click="run(() => query(page!.page - 1))"
                    >上一页</Button
                  ><Button
                    variant="outline"
                    size="xs"
                    :disabled="blocked || !page.hasNext || page.truncated"
                    aria-label="MongoDB 下一页"
                    @click="run(() => query(page!.page + 1))"
                    >下一页</Button
                  >
                </div>
              </div>
              <div
                v-if="page?.documents.length"
                class="flex min-h-0 flex-1 overflow-hidden rounded-lg border"
              >
                <div class="w-56 shrink-0 space-y-1 overflow-auto border-r p-2">
                  <Button
                    v-for="(text, index) in page.documents"
                    :key="index"
                    variant="ghost"
                    class="w-full justify-start overflow-hidden"
                    :class="selected === index ? 'bg-accent' : ''"
                    :aria-label="`MongoDB 文档 ${index + 1}`"
                    @click="selected = index"
                    ><file-json :size="14" /><span class="truncate font-mono text-xs">{{
                      JSON.stringify(JSON.parse(text)._id ?? index + 1)
                    }}</span></Button
                  >
                </div>
                <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                  <div class="flex shrink-0 justify-end gap-2 border-b p-2">
                    <Button
                      variant="outline"
                      size="xs"
                      :disabled="blocked || !editable"
                      aria-label="编辑 MongoDB 文档"
                      @click="begin('replace')"
                      ><pencil :size="13" />编辑</Button
                    ><Button
                      variant="outline"
                      size="xs"
                      :disabled="blocked || !editable"
                      aria-label="删除 MongoDB 文档"
                      @click="begin('delete')"
                      ><trash2 :size="13" />删除</Button
                    >
                  </div>
                  <pre
                    class="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs break-all whitespace-pre-wrap"
                    >{{ pretty(document!) }}</pre>
                </div>
              </div>
              <p v-else-if="!busy" class="text-muted-foreground p-8 text-center text-sm">
                没有匹配的文档。
              </p>
            </tabs-content>
            <tabs-content value="indexes" class="min-h-0 flex-1 space-y-3 overflow-auto">
              <pre
                v-for="(index, i) in indexes"
                :key="i"
                class="rounded-lg border p-4 font-mono text-xs break-all whitespace-pre-wrap"
                >{{ pretty(index) }}</pre>
              <p
                v-if="!indexes.length && !busy"
                class="text-muted-foreground p-8 text-center text-sm"
              >
                暂无索引信息。
              </p></tabs-content
            >
          </tabs>
        </template>
        <p v-else class="text-muted-foreground m-auto text-sm">
          {{ busy ? '正在读取 MongoDB…' : '选择数据库和集合，开始浏览文档。' }}
        </p>
      </section>
    </div>
    <Dialog v-model:open="modalOpen"
      ><dialog-content
        :show-close-button="!busy"
        class="flex max-h-[90vh] flex-col sm:max-w-[720px]"
        ><dialog-header
          ><dialog-title>{{
            modal === 'insert'
              ? '新增 MongoDB 文档'
              : modal === 'replace'
                ? '编辑 MongoDB 文档'
                : '删除 MongoDB 文档'
          }}</dialog-title
          ><dialog-description
            >{{ database }} / {{ collection }} ·
            {{
              modal === 'delete'
                ? '删除后无法撤销，请核对文档。'
                : '保留 Extended JSON 类型；编辑时不可修改 _id。'
            }}</dialog-description
          ></dialog-header
        >
        <form class="flex min-h-0 flex-col gap-4" @submit.prevent="mutate">
          <Label v-if="modal !== 'delete'" class="grid min-h-0 gap-2"
            ><span>文档内容</span
            ><Textarea
              v-model="draft"
              aria-label="MongoDB 文档内容"
              class="h-80 min-h-40 font-mono text-xs"
              :disabled="blocked"
          /></Label>
          <pre
            v-else
            class="max-h-80 overflow-auto rounded border p-3 font-mono text-xs break-all whitespace-pre-wrap"
            >{{ draft }}</pre>
          <alert v-if="modalError" variant="destructive"
            ><alert-description class="break-all">{{ modalError }}</alert-description></alert
          >
          <div class="flex justify-end gap-2">
            <Button variant="outline" type="button" :disabled="busy" @click="modal = ''"
              >取消</Button
            ><Button
              type="submit"
              :variant="modal === 'delete' ? 'destructive' : 'default'"
              :disabled="blocked"
              >{{ busy ? '处理中…' : modal === 'delete' ? '确认删除' : '确认保存' }}</Button
            >
          </div>
        </form></dialog-content
      ></Dialog
    >
  </div>
</template>
