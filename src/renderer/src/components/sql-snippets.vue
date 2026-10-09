<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  decodeSnippets,
  encodeSnippets,
  upsertSnippet,
  snippetsKey,
  type SqlSnippet,
  type SqlDialect,
} from '@/lib/sql-snippets'
const props = defineProps<{ sql: string; dialect: SqlDialect; busy: boolean }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ load: [sql: string] }>()
const entries = ref<SqlSnippet[]>([]),
  search = ref(''),
  name = ref(''),
  error = ref(''),
  notice = ref('')
const editing = ref<SqlSnippet>(),
  removing = ref<SqlSnippet>(),
  damaged = ref(false),
  draft = ref('')
watch(open, (value) => {
  if (!value) return
  name.value = ''
  search.value = ''
  error.value = ''
  notice.value = ''
  editing.value = undefined
  removing.value = undefined
  draft.value = props.sql
  damaged.value = false
  try {
    entries.value = decodeSnippets(localStorage.getItem(snippetsKey))
  } catch (e) {
    entries.value = []
    damaged.value = true
    error.value = (e as Error).message
  }
})
const matches = computed(() =>
  entries.value.filter((item) =>
    `${item.name} ${item.sql} ${item.dialect}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
)
function persist(next: SqlSnippet[]) {
  localStorage.setItem(snippetsKey, encodeSnippets(next))
  entries.value = next
}
function save() {
  if (damaged.value) return
  error.value = ''
  notice.value = ''
  try {
    persist(
      upsertSnippet(
        entries.value,
        {
          name: name.value,
          sql: editing.value?.sql ?? draft.value,
          dialect: editing.value?.dialect ?? props.dialect,
        },
        editing.value?.id ?? crypto.randomUUID(),
      ),
    )
    notice.value = editing.value ? '片段已重命名' : 'SQL 片段已收藏'
    editing.value = undefined
    name.value = ''
  } catch (e) {
    error.value = (e as Error).message
  }
}
function rename(item: SqlSnippet) {
  editing.value = item
  name.value = item.name
  error.value = ''
  notice.value = ''
}
function remove() {
  if (!removing.value || damaged.value) return
  try {
    persist(entries.value.filter((item) => item.id !== removing.value!.id))
    if (editing.value?.id === removing.value.id) {
      editing.value = undefined
      name.value = ''
    }
    removing.value = undefined
    notice.value = '片段已删除'
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
    removing.value = undefined
  }
}
function load(item: SqlSnippet) {
  if (props.busy) return
  emit('load', item.sql)
  open.value = false
}
function resetSnippetEditor() {
  editing.value = undefined
  name.value = ''
}
</script>
<template>
  <Dialog v-model:open="open"
    ><dialog-content class="max-h-[90vh] overflow-auto sm:max-w-[760px]">
      <dialog-header
        ><dialog-title>SQL 收藏片段</dialog-title
        ><dialog-description
          >保存在本机，可跨连接复用。载入会替换当前编辑器内容，需要手动执行；请核对数据库方言。</dialog-description
        ></dialog-header
      >
      <form class="flex items-end gap-2" @submit.prevent="save">
        <Label class="grid min-w-0 flex-1 gap-2"
          ><span>{{ editing ? '重命名片段' : '收藏当前选中 SQL 或编辑器内容' }}</span
          ><Input
            v-model="name"
            aria-label="SQL 片段名称"
            maxlength="100"
            :disabled="damaged"
            placeholder="例如：最近7天订单"
        /></Label>
        <Button type="submit" :disabled="damaged || !name.trim() || (!editing && !draft.trim())">{{
          editing ? '保存名称' : '保存片段'
        }}</Button>
        <Button v-if="editing" type="button" variant="outline" @click="resetSnippetEditor()"
          >取消重命名</Button
        >
      </form>
      <alert v-if="error" variant="destructive"
        ><alert-description>{{ error }}</alert-description></alert
      >
      <alert v-if="notice"
        ><alert-description>{{ notice }}</alert-description></alert
      >
      <Input v-model="search" aria-label="搜索 SQL 片段" placeholder="搜索名称、SQL或方言…" />
      <div class="scroll-area max-h-[45vh] space-y-3 overflow-auto">
        <div v-for="item in matches" :key="item.id" class="space-y-2 rounded-lg border p-3">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">{{ item.name }}</p>
              <p class="text-muted-foreground text-xs">
                {{ item.dialect }}{{ item.dialect !== dialect ? ' · 与当前连接方言不同' : '' }}
              </p>
            </div>
            <div class="flex shrink-0 gap-1">
              <Button
                variant="outline"
                size="sm"
                :aria-label="`载入片段 ${item.name}`"
                :disabled="busy"
                @click="load(item)"
                >载入编辑器</Button
              ><Button
                variant="ghost"
                size="sm"
                :aria-label="`重命名片段 ${item.name}`"
                @click="rename(item)"
                >重命名</Button
              ><Button
                variant="ghost"
                size="sm"
                :aria-label="`删除片段 ${item.name}`"
                @click="removing = item"
                >删除</Button
              >
            </div>
          </div>
          <pre
            class="text-muted-foreground line-clamp-4 font-mono text-xs break-all whitespace-pre-wrap"
            >{{ item.sql }}</pre>
        </div>
        <p v-if="!matches.length" class="text-muted-foreground py-6 text-center text-sm">
          {{ entries.length ? '没有匹配的片段' : '尚未收藏 SQL 片段' }}
        </p>
      </div>
      <p class="text-muted-foreground text-xs">最多100条，每条 SQL 最多64 KiB，总大小最多1 MiB。</p>
    </dialog-content></Dialog
  >
  <alert-dialog
    :open="Boolean(removing)"
    @update:open="
      (value) => {
        if (!value) removing = undefined
      }
    "
    ><alert-dialog-content
      ><alert-dialog-header
        ><alert-dialog-title>删除 SQL 片段</alert-dialog-title
        ><alert-dialog-description
          >确认删除「{{ removing?.name }}」？</alert-dialog-description
        ></alert-dialog-header
      ><alert-dialog-footer
        ><alert-dialog-cancel>取消</alert-dialog-cancel
        ><Button variant="destructive" @click="remove">确认删除片段</Button></alert-dialog-footer
      ></alert-dialog-content
    ></alert-dialog
  >
</template>
