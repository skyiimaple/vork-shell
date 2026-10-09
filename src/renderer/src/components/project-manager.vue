<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ChevronDown, Folder, Plus, Trash2 } from '@lucide/vue'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { groupConnectionsByType } from '@/lib/connection-groups'
import type { ConnectionConfig, ConnectionProject } from '../../../shared/contracts'
const props = defineProps<{
  ready: boolean
  open: boolean
  projects: ConnectionProject[]
  profiles: ConnectionConfig[]
  connection?: ConnectionConfig
  initialId?: string
}>()
const emit = defineEmits<{ 'update:open': [value: boolean]; changed: []; activate: [id: string] }>()
const editing = ref<string>(),
  name = ref(''),
  members = ref<string[]>([]),
  projectIds = ref<string[]>([]),
  error = ref(''),
  busy = ref(false),
  search = ref(''),
  deleting = ref<ConnectionProject>()
const groups = computed(() =>
  groupConnectionsByType(
    props.profiles.filter((p) =>
      `${p.name} ${p.host || p.path || ''}`.toLowerCase().includes(search.value.toLowerCase()),
    ),
  ),
)
function edit(project?: ConnectionProject) {
  editing.value = project?.id
  name.value = project?.name || ''
  members.value = [...(project?.connectionIds || [])]
  error.value = ''
  search.value = ''
}
watch(
  () => [props.open, props.connection?.id],
  () => {
    if (props.open) {
      error.value = ''
      projectIds.value = props.projects
        .filter((p) => p.connectionIds.includes(props.connection?.id || ''))
        .map((p) => p.id)
      edit(props.projects.find((p) => p.id === props.initialId))
    }
  },
)
function toggle(id: string, value: boolean | 'indeterminate', kind: 'member' | 'project') {
  const target = kind === 'member' ? members : projectIds
  target.value =
    value === true
      ? [...new Set([...target.value, id])]
      : target.value.filter((item) => item !== id)
}
function setOpen(value: boolean) {
  if (!busy.value) emit('update:open', value)
}
async function save(mode: 'save' | 'close' | 'switch' = 'save') {
  if (!props.ready) {
    error.value = '项目尚未成功加载，无法保存'
    return
  }
  busy.value = true
  error.value = ''
  try {
    if (props.connection) {
      await window.vork.assignConnectionProjects(props.connection.id!, [...projectIds.value])
      emit('changed')
      emit('update:open', false)
    } else if (editing.value) {
      await window.vork.updateProject(editing.value, name.value, [...members.value])
      emit('changed')
    } else {
      const project = await window.vork.createProject(name.value, [...members.value])
      editing.value = project.id
      emit('changed')
    }
    if (!props.connection && mode !== 'save') {
      if (mode === 'switch' && editing.value) emit('activate', editing.value)
      emit('update:open', false)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    busy.value = false
  }
}
async function remove() {
  if (!deleting.value) return
  busy.value = true
  error.value = ''
  try {
    await window.vork.deleteProject(deleting.value.id)
    if (editing.value === deleting.value.id) edit()
    deleting.value = undefined
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '删除失败'
    deleting.value = undefined
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <Dialog :open="open" @update:open="setOpen"
    ><dialog-content class="flex max-h-[85vh] flex-col sm:max-w-3xl"
      ><dialog-header
        ><dialog-title>{{ connection ? '管理所属项目' : '项目管理' }}</dialog-title
        ><dialog-description>{{
          connection
            ? `选择「${connection.name}」所属的项目，可同时加入多个项目。`
            : '项目可以组合不同类型的连接，不改变固定的连接类型分组。'
        }}</dialog-description></dialog-header
      >
      <alert v-if="error" variant="destructive"
        ><alert-description>{{ error }}</alert-description></alert
      >
      <template v-if="connection"
        ><div class="min-h-0 space-y-3 overflow-auto">
          <p v-if="!projects.length" class="text-muted-foreground text-sm">
            还没有项目，请先从侧栏的项目管理入口创建。
          </p>
          <div v-for="project in projects" :key="project.id" class="flex items-center gap-2">
            <checkbox
              :id="`project-${project.id}`"
              :aria-label="`加入项目 ${project.name}`"
              :disabled="busy || !ready"
              :model-value="projectIds.includes(project.id)"
              @update:model-value="(value) => toggle(project.id, value, 'project')"
            /><span class="text-sm break-all">{{ project.name }}</span>
          </div>
        </div>
        <Button class="self-end" :disabled="busy || !ready" @click="save()"
          >保存所属项目</Button
        ></template
      >
      <template v-else
        ><div class="grid min-h-0 flex-1 gap-4 sm:grid-cols-[180px_1fr]">
          <div class="bg-muted/30 flex min-h-0 flex-col gap-3 rounded-lg border p-2">
            <Button
              variant="outline"
              class="w-full gap-2"
              :disabled="busy || !ready"
              @click="edit()"
              ><plus class="size-4" />新建项目</Button
            >
            <div class="min-h-0 flex-1 space-y-1 overflow-auto">
              <div
                v-for="project in projects"
                :key="project.id"
                class="group flex items-center rounded-md"
                :class="editing === project.id ? 'bg-primary/10 text-primary' : 'hover:bg-muted'"
              >
                <Button
                  variant="ghost"
                  class="h-10 min-w-0 flex-1 justify-start gap-2 px-2 hover:bg-transparent"
                  :aria-pressed="editing === project.id"
                  :disabled="busy || !ready"
                  @click="edit(project)"
                  ><folder class="size-4 shrink-0" /><span
                    class="min-w-0 flex-1 truncate text-left"
                    >{{ project.name }}</span
                  ><span class="bg-background/70 text-muted-foreground rounded px-1.5 text-xs">{{
                    project.connectionIds.length
                  }}</span></Button
                >
                <Button
                  variant="ghost"
                  size="icon"
                  class="text-muted-foreground hover:text-destructive mr-1 size-7"
                  :aria-label="`删除项目 ${project.name}`"
                  :disabled="busy || !ready"
                  @click="deleting = project"
                  ><trash2 class="size-3.5"
                /></Button>
              </div>
              <p
                v-if="!projects.length"
                class="text-muted-foreground px-2 py-6 text-center text-xs"
              >
                暂无项目
              </p>
            </div>
          </div>
          <div class="flex min-h-0 flex-col gap-3">
            <Input
              v-model="name"
              aria-label="项目名称"
              placeholder="项目名称，例如：商城"
              :disabled="busy || !ready"
            /><Input v-model="search" aria-label="搜索项目成员连接" placeholder="搜索连接…" />
            <div class="min-h-0 flex-1 overflow-auto rounded-md border p-3">
              <div v-for="group in groups" :key="group.type" class="mb-3">
                <p class="text-muted-foreground mb-2 text-xs font-medium">{{ group.name }}</p>
                <p v-if="!group.items.length" class="text-muted-foreground text-xs">暂无连接</p>
                <div
                  v-for="profile in group.items"
                  :key="profile.id"
                  class="mb-2 flex items-start gap-2"
                >
                  <checkbox
                    :aria-label="`项目成员 ${profile.name}`"
                    :disabled="busy || !ready"
                    :model-value="members.includes(profile.id!)"
                    @update:model-value="(value) => toggle(profile.id!, value, 'member')"
                  /><span class="min-w-0 text-sm break-all">{{ profile.name }}</span>
                </div>
              </div>
            </div>
            <div class="flex">
              <Button
                class="min-w-0 flex-1 rounded-r-none"
                :disabled="busy || !ready || !name.trim()"
                @click="save()"
                >{{ editing ? '保存项目' : '创建项目' }} · {{ members.length }} 个连接</Button
              >
              <dropdown-menu
                ><dropdown-menu-trigger as-child
                  ><Button
                    class="border-primary-foreground/25 rounded-l-none border-l"
                    size="icon"
                    aria-label="选择保存方式"
                    :disabled="busy || !ready || !name.trim()"
                    ><chevron-down class="size-4" /></Button
                ></dropdown-menu-trigger>
                <dropdown-menu-content align="end"
                  ><dropdown-menu-item @select="save()">仅保存</dropdown-menu-item
                  ><dropdown-menu-item @select="save('close')">保存并关闭</dropdown-menu-item
                  ><dropdown-menu-item @select="save('switch')"
                    >保存并关闭后切换到当前项目</dropdown-menu-item
                  ></dropdown-menu-content
                >
              </dropdown-menu>
            </div>
          </div>
        </div></template
      >
    </dialog-content></Dialog
  >
  <alert-dialog
    :open="Boolean(deleting)"
    @update:open="
      (value) => {
        if (!value && !busy) deleting = undefined
      }
    "
    ><alert-dialog-content
      ><alert-dialog-header
        ><alert-dialog-title>删除项目？</alert-dialog-title
        ><alert-dialog-description
          >删除「{{
            deleting?.name
          }}」只移除项目和成员关系，连接配置与类型分组保留。</alert-dialog-description
        ></alert-dialog-header
      ><alert-dialog-footer
        ><alert-dialog-cancel :disabled="busy">取消</alert-dialog-cancel
        ><Button variant="destructive" :disabled="busy || !ready" @click="remove"
          >确认删除项目</Button
        ></alert-dialog-footer
      ></alert-dialog-content
    ></alert-dialog
  >
</template>
