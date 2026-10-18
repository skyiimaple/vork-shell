<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ChevronDown } from '@lucide/vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  Settings,
  History,
  Terminal,
  Database,
  Plus,
  Ellipsis,
  Search,
  ArrowUpRight,
  X,
  Sun,
  Moon,
  Monitor,
  ChevronRight,
  RotateCw,
  Copy,
  Trash2,
  Layers,
  Command,
  CircleHelp,
  PlugZap,
  Unplug,
  Pencil,
  Palette,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu'
import { type QueryDrafts, decodeWorkspace, encodeWorkspace, workspaceKey } from '@/lib/workspace'
import { duplicateProfile } from '@/lib/connection-actions'
import ReleasePage from '@/components/release-page.vue'
import ConnectionDialog from '@/components/connection-dialog.vue'
import ConnectionTypeIcon from '@/components/connection-type-icon.vue'
import { connectionStatuses } from '@/lib/connection-status'
import ProjectManager from '@/components/project-manager.vue'
import { groupConnectionsByType } from '@/lib/connection-groups'
import ConnectionDetails from '@/components/connection-details.vue'
import ConnectionColor from '@/components/connection-color.vue'
import { playgroundCard } from '@/composables/use-playground-card'
import AppSettings from '@/components/app-settings.vue'
import ActivityLogPage from '@/components/activity-log-page.vue'
import ConnectionImport from '@/components/connection-import.vue'
import SshPanel from '@/components/ssh-panel.vue'
import MongodbPanel from '@/components/mongodb-panel.vue'
import RedisPanel from '@/components/redis-panel.vue'
import HistorySearch from '@/components/history-search.vue'
import ShortcutSettings from '@/components/shortcut-settings.vue'
import { shortcuts } from '@/composables/use-shortcuts'
import { matchesShortcut } from '@/lib/shortcuts'
import ToastHost from '@/components/toast-host.vue'
import { notifications } from '@/composables/use-notifications'
import PanelErrorBoundary from '@/components/panel-error-boundary.vue'
import QueryPanel from '@/components/sql-workspace.vue'
import { theme, setTheme } from '@/composables/use-theme'
import type { Session, ConnectionConfig, QueryHistoryEntry } from '../../shared/contracts'
const appVersion = __APP_VERSION__
const projectFilter = ref('all'),
  projectManagerOpen = ref(false),
  projectConnection = ref<ConnectionConfig>()
function manageProjects(connection?: ConnectionConfig) {
  if (!window.vork) {
    notifications.notify('项目管理需在 Electron 桌面应用中使用')
    return
  }
  if (!projects.value || projectsPending.value || projectsError.value) {
    notifications.notify(
      projectsError.value ? '项目读取失败，请先解决配置错误' : '项目加载中，请稍后再试',
      'error',
    )
    return
  }
  projectConnection.value = connection
  projectManagerOpen.value = true
}
async function refreshProjects() {
  await queryClient.invalidateQueries({ queryKey: ['projects'] })
}
const colorProfile = ref<ConnectionConfig>()
const importOpen = ref(false)
function openImport() {
  if (!window.vork) {
    notifications.notify('导入功能需在 Electron 桌面应用中使用')
    return
  }
  importOpen.value = true
}
async function onConnectionsImported(result: { imported: number; skipped: number }) {
  await queryClient.invalidateQueries({ queryKey: ['profiles'] })
  notifications.notify(
    `已导入 ${result.imported} 条连接${result.skipped ? `，跳过 ${result.skipped} 条重复连接` : ''}`,
  )
}
const appSettingsOpen = ref(false),
  logsOpen = ref(false)
const releaseOpen = ref(false)
const settingsOpen = ref(false),
  historyOpen = ref(false)
const queryDrafts = ref<Record<string, QueryDrafts>>({})
const drafts = ref<Record<string, string>>({})
const restoredIds = new Set<string>()
const connectingProfile = ref(''),
  reconnecting = ref(''),
  disconnecting = ref<Record<string, boolean>>({})
const preparedQueries = ref<Record<string, { sql: string; version: number }>>({})
async function restoreQuery(entry: QueryHistoryEntry) {
  try {
    let session = sessions.value.find(
      (s) =>
        !closed.value[s.id] &&
        (entry.profileId
          ? s.profileId === entry.profileId
          : s.type === entry.type && s.target === entry.target && s.name === entry.name),
    )
    if (!session) {
      const profile = profiles.value?.find((p) => p.id === entry.profileId)
      if (!profile) {
        notify('对应连接未打开且没有保存配置，请先打开连接后再恢复历史。')
        return
      }
      session = await window.vork.connect({ ...profile })
      add(session)
    }
    active.value = session.id
    preparedQueries.value[session.id] = { sql: entry.sql, version: Date.now() }
  } catch (error) {
    notify((error as Error).message, 'error')
  }
}
const dragging = ref(''),
  reordering = ref(false)
function startConnectionDrag(event: DragEvent, id: string) {
  dragging.value = id
  event.dataTransfer?.setData('text/plain', id)
}
async function dropConnection(target: string) {
  const source = dragging.value
  dragging.value = ''
  if (!source || source === target || reordering.value) return
  if (
    profiles.value?.find((p) => p.id === source)?.type !==
    profiles.value?.find((p) => p.id === target)?.type
  )
    return
  const ids = (profiles.value || []).map((p) => p.id!)
  const from = ids.indexOf(source),
    to = ids.indexOf(target)
  if (from < 0 || to < 0) return
  ids.splice(from, 1)
  ids.splice(to, 0, source)
  reordering.value = true
  try {
    await window.vork.reorderProfiles(ids)
    await refresh()
  } catch (error) {
    notify((error as Error).message, 'error')
  } finally {
    reordering.value = false
  }
}
const desktop = Boolean(window.vork)
const queryClient = useQueryClient()
const { data: profiles, error: profilesError } = useQuery({
  queryKey: ['profiles'],
  queryFn: () => window.vork.profiles(),
  enabled: desktop,
  staleTime: Infinity,
})
const {
  data: projects,
  error: projectsError,
  isPending: projectsPending,
} = useQuery({
  queryKey: ['projects'],
  queryFn: () => window.vork.projects(),
  enabled: desktop,
  staleTime: Infinity,
})
watch(projects, (items) => {
  if (projectFilter.value !== 'all' && !items?.some((p) => p.id === projectFilter.value))
    projectFilter.value = 'all'
})
const activeProject = computed(() => projects.value?.find((p) => p.id === projectFilter.value))
const sessions = ref<Session[]>([]),
  active = ref(''),
  search = ref(''),
  dialogOpen = ref(false),
  selectedProfile = ref<ConnectionConfig>()
const deletingProfile = ref<ConnectionConfig>(),
  deleting = ref(false),
  deleteError = ref('')
const windowPlatform = ref('darwin')
const stopWindowState = window.vork?.onWindowState?.((state) => {
  windowPlatform.value = state.platform
})
onBeforeUnmount(() => stopWindowState?.())
const tabStrip = ref<HTMLElement>(),
  overflowingTabs = ref(false),
  hiddenTabIds = ref<string[]>([]),
  recentTabsOpen = ref(false),
  recentTabSearch = ref(''),
  recentTabIndex = ref(0),
  tabActivity = ref<Record<string, number>>({})
let tabSequence = 0
function measureTabs() {
  const strip = tabStrip.value
  if (!strip) return
  overflowingTabs.value = strip.scrollWidth > strip.clientWidth + 1
  const bounds = strip.getBoundingClientRect()
  hiddenTabIds.value = [...strip.querySelectorAll<HTMLElement>('[data-session-tab]')]
    .filter((el) => {
      const rect = el.getBoundingClientRect()
      return rect.left < bounds.left - 1 || rect.right > bounds.right + 1
    })
    .map((el) => el.dataset.sessionTab!)
}
useResizeObserver(tabStrip, measureTabs)
watch(
  sessions,
  async () => {
    await nextTick()
    measureTabs()
  },
  { deep: true },
)
watch(active, async (id) => {
  if (id) tabActivity.value[id] = ++tabSequence
  await nextTick()
  const strip = tabStrip.value
  const el = [...(strip?.querySelectorAll<HTMLElement>('[data-session-tab]') || [])].find(
    (el) => el.dataset.sessionTab === id,
  )
  if (strip && el) {
    const bounds = strip.getBoundingClientRect(),
      rect = el.getBoundingClientRect()
    if (rect.left < bounds.left) strip.scrollLeft += rect.left - bounds.left
    else if (rect.right > bounds.right) strip.scrollLeft += rect.right - bounds.right
  }
  measureTabs()
})
const hiddenTabs = computed(() =>
  sessions.value.filter((session) => hiddenTabIds.value.includes(session.id)),
)
const recentTabs = computed(() =>
  sessions.value
    .filter((session) =>
      `${session.name} ${session.type}`.toLowerCase().includes(recentTabSearch.value.toLowerCase()),
    )
    .sort((a, b) => (tabActivity.value[b.id] || 0) - (tabActivity.value[a.id] || 0)),
)
watch(recentTabSearch, () => {
  recentTabIndex.value = 0
})
function tabBackground(session: Session) {
  const color = profiles.value?.find((profile) => profile.id === session.profileId)?.connectedColor
  if (!color || closed.value[session.id]) return undefined
  return { backgroundColor: color + (active.value === session.id ? '40' : '20') }
}
function jumpToTab(id: string) {
  active.value = id
  recentTabsOpen.value = false
}
function recordDraft(id: string, sql: string) {
  if (drafts.value[id] !== sql) tabActivity.value[id] = ++tabSequence
  drafts.value[id] = sql
}
function recentTabKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const count = recentTabs.value.length
    if (count)
      recentTabIndex.value =
        (recentTabIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const session = recentTabs.value[recentTabIndex.value]
    if (session) jumpToTab(session.id)
  }
}
const closed = ref<Record<string, string>>({}),
  sidebar = ref(true),
  help = ref(false)
const visibleProfiles = computed(() =>
  (profiles.value || []).filter(
    (p) =>
      `${p.name} ${p.host || p.path || ''} ${p.type}`
        .toLowerCase()
        .includes(search.value.toLowerCase()) &&
      (projectFilter.value === 'all' ||
        Boolean(activeProject.value?.connectionIds.includes(p.id!))),
  ),
)
const collapsedGroups = ref<Record<string, boolean>>({})
const profileGroups = computed(() =>
  groupConnectionsByType(visibleProfiles.value).filter((group) => group.items.length > 0),
)
const current = computed(() => sessions.value.find((s) => s.id === active.value))
const profileStates = computed(() => connectionStatuses(sessions.value, closed.value, active.value))
const activeCount = computed(() => sessions.value.filter((s) => !closed.value[s.id]).length)
let unsubscribe: (() => void) | undefined
const notify = notifications.notify
function open(profile?: ConnectionConfig) {
  if (!desktop) {
    notify('连接功能需在 Electron 桌面应用中使用。请运行 pnpm dev。')
    return
  }
  selectedProfile.value = profile
  dialogOpen.value = true
}
function add(session: Session) {
  sessions.value.push(session)
  active.value = session.id
}
async function disconnectSession(id: string) {
  if (closed.value[id] || disconnecting.value[id]) return
  disconnecting.value[id] = true
  try {
    await window.vork.disconnect(id)
    closed.value[id] = '连接已断开'
  } catch (error) {
    notify((error as Error).message, 'error')
  } finally {
    delete disconnecting.value[id]
  }
}
async function close(id: string) {
  if (!closed.value[id]) {
    try {
      await window.vork.disconnect(id)
    } catch (e) {
      notify((e as Error).message)
    }
  }
  const index = sessions.value.findIndex((s) => s.id === id)
  sessions.value = sessions.value.filter((s) => s.id !== id)
  delete closed.value[id]
  delete preparedQueries.value[id]
  delete queryDrafts.value[id]
  delete drafts.value[id]
  restoredIds.delete(id)
  if (active.value === id)
    active.value = sessions.value[Math.min(index, sessions.value.length - 1)]?.id || ''
}
async function closeMany(except?: string) {
  for (const session of [...sessions.value]) if (session.id !== except) await close(session.id)
}
const duplicating = ref(false)
async function duplicateTab(id: string) {
  if (duplicating.value || closed.value[id]) return
  duplicating.value = true
  try {
    add(await window.vork.duplicateSession(id))
  } catch (error) {
    notify((error as Error).message, 'error')
  } finally {
    duplicating.value = false
  }
}
async function quickConnect(profile: ConnectionConfig) {
  if (connectingProfile.value) return
  connectingProfile.value = profile.id!
  try {
    add(await window.vork.connect({ ...profile }))
  } catch (e) {
    notify(`连接「${profile.name}」失败：${(e as Error).message || '未知错误'}`, 'error', true)
  } finally {
    connectingProfile.value = ''
  }
}
async function reconnect(session: Session) {
  if (reconnecting.value) return
  reconnecting.value = session.id
  try {
    let next: Session
    if (restoredIds.has(session.id)) {
      const profile = profiles.value?.find((p) => p.id === session.profileId)
      if (profile) next = await window.vork.connect({ ...profile })
      else if (session.type === 'sqlite')
        next = await window.vork.connect({
          type: 'sqlite',
          name: session.name,
          path: session.target,
        })
      else {
        notify('请重新填写未保存或已删除连接的配置。')
        open({
          type: session.type,
          name: session.name,
          host: 'localhost',
          port: { ssh: 22, redis: 6379, mysql: 3306, postgresql: 5432, mongodb: 27017 }[
            session.type as 'ssh' | 'redis' | 'mysql' | 'postgresql' | 'mongodb'
          ],
        })
        return
      }
    } else next = await window.vork.reconnectSession(session.id)
    const index = sessions.value.findIndex((s) => s.id === session.id)
    if (index < 0) {
      await window.vork.disconnect(next.id)
      return
    }
    if (drafts.value[session.id] !== undefined) {
      drafts.value[next.id] = drafts.value[session.id]!
      preparedQueries.value[next.id] = { sql: drafts.value[next.id]!, version: Date.now() }
    }
    if (queryDrafts.value[session.id]) queryDrafts.value[next.id] = queryDrafts.value[session.id]!
    delete queryDrafts.value[session.id]
    sessions.value.splice(index, 1, next)
    if (active.value === session.id) active.value = next.id
    delete closed.value[session.id]
    delete drafts.value[session.id]
    delete preparedQueries.value[session.id]
    restoredIds.delete(session.id)
  } catch (e) {
    notify((e as Error).message, 'error')
  } finally {
    reconnecting.value = ''
  }
}
let warnedWorkspaceLimit = false
function saveWorkspace() {
  const oversized =
    sessions.value.length > 20 ||
    Object.values(drafts.value).some((sql) => sql.length > 65536) ||
    Object.values(queryDrafts.value).some((state) =>
      state.tabs.some((tab) => tab.sql.length > 65536),
    )
  if (oversized && !warnedWorkspaceLimit)
    notify('工作区最多恢复20个标签，每份SQL草稿保留前64 KiB；退出前请备份超限内容。')
  warnedWorkspaceLimit = oversized
  try {
    localStorage.setItem(
      workspaceKey,
      encodeWorkspace(
        sessions.value.map((session) => ({
          session,
          sql: drafts.value[session.id] || '',
          queries: queryDrafts.value[session.id],
        })),
        active.value,
      ),
    )
  } catch {
    notify('工作区保存失败，请检查本地存储空间。', 'error')
  }
}
if (desktop) {
  const workspace = decodeWorkspace(localStorage.getItem(workspaceKey))
  if (workspace) {
    for (const tab of workspace.tabs) {
      const session = { ...tab.session, id: 'restored-' + tab.session.id.replace(/^restored-/, '') }
      sessions.value.push(session)
      closed.value[session.id] = '待重连'
      restoredIds.add(session.id)
      if (tab.queries) queryDrafts.value[session.id] = tab.queries
      drafts.value[session.id] = tab.sql
      if (['sqlite', 'mysql', 'postgresql'].includes(session.type))
        preparedQueries.value[session.id] = { sql: tab.sql, version: Date.now() }
      if (tab.session.id === workspace.active) active.value = session.id
    }
  }
}
let workspaceTimer: ReturnType<typeof setTimeout> | undefined
watch(
  [sessions, active, drafts, queryDrafts],
  () => {
    if (desktop) {
      clearTimeout(workspaceTimer)
      workspaceTimer = setTimeout(saveWorkspace, 300)
    }
  },
  { deep: true },
)
function remove(profile: ConnectionConfig) {
  deletingProfile.value = profile
  deleteError.value = ''
}
async function confirmRemove() {
  if (!deletingProfile.value || deleting.value) return
  deleting.value = true
  try {
    await window.vork.deleteProfile(deletingProfile.value.id!)
    await refresh()
    deletingProfile.value = undefined
  } catch (e) {
    deleteError.value = (e as Error).message
  } finally {
    deleting.value = false
  }
}
function refresh() {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['profiles'] }),
    queryClient.invalidateQueries({ queryKey: ['projects'] }),
  ])
}
async function playground() {
  if (!desktop) {
    open()
    return
  }
  try {
    add(await window.vork.connect({ type: 'sqlite', name: 'SQLite 试验台', path: ':memory:' }))
  } catch (e) {
    notify((e as Error).message)
  }
}
function keyboard(event: KeyboardEvent) {
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'p'
  ) {
    event.preventDefault()
    if (
      !document.querySelector('[role="alertdialog"]') &&
      (!document.querySelector('[role="dialog"]') || recentTabsOpen.value)
    ) {
      recentTabSearch.value = ''
      recentTabIndex.value = 0
      recentTabsOpen.value = !recentTabsOpen.value
    }
    return
  }

  if (
    dialogOpen.value ||
    deletingProfile.value ||
    appSettingsOpen.value ||
    logsOpen.value ||
    settingsOpen.value ||
    historyOpen.value ||
    document.querySelector('[role="dialog"], [role="alertdialog"]')
  )
    return
  if (matchesShortcut(event, shortcuts.value.searchHistory)) {
    event.preventDefault()
    if (desktop) historyOpen.value = true
  }
  if (matchesShortcut(event, shortcuts.value.newConnection)) {
    event.preventDefault()
    open()
  }
  if (matchesShortcut(event, shortcuts.value.close) && active.value) {
    event.preventDefault()
    void close(active.value)
  }
}
onMounted(() => {
  window.addEventListener('keydown', keyboard)
  if (desktop) window.addEventListener('beforeunload', saveWorkspace)
  if (desktop)
    unsubscribe = window.vork.onEvent((event) => {
      if (
        !event.channelId &&
        (event.type === 'closed' || event.type === 'error') &&
        sessions.value.some((session) => session.id === event.sessionId)
      )
        closed.value[event.sessionId] = event.data
      if (event.type === 'error') notify(event.data)
    })
})
onBeforeUnmount(() => {
  clearTimeout(workspaceTimer)
  if (desktop) {
    saveWorkspace()
    window.removeEventListener('beforeunload', saveWorkspace)
  }
  unsubscribe?.()
  window.removeEventListener('keydown', keyboard)
  notifications.dispose()
})
</script>
<template>
  <div class="flex h-full flex-col">
    <header
      class="drag-region bg-sidebar flex h-10 shrink-0 items-center justify-between border-b pr-5"
      :class="windowPlatform === 'darwin' ? 'pl-[98px]' : 'pl-5'"
    >
      <div class="flex flex-1 items-center">
        <Button
          variant="ghost"
          size="icon"
          class="no-drag size-8"
          :aria-label="sidebar ? '收起侧栏' : '展开侧栏'"
          :title="sidebar ? '收起侧栏' : '展开侧栏'"
          @click="sidebar = !sidebar"
          ><panel-left-close v-if="sidebar" :size="16" /><panel-left-open v-else :size="16"
        /></Button>
      </div>
      <div class="no-drag flex items-center gap-1">
        <dropdown-menu>
          <dropdown-menu-trigger as-child
            ><Button variant="ghost" size="icon" class="size-8" aria-label="主题" title="主题"
              ><moon v-if="theme === 'dark'" :size="16" /><sun
                v-else-if="theme === 'light'"
                :size="16" /><monitor v-else :size="16" /></Button
          ></dropdown-menu-trigger>
          <dropdown-menu-content align="end">
            <dropdown-menu-item @select="setTheme('system')"
              ><monitor :size="14" />跟随系统</dropdown-menu-item
            >
            <dropdown-menu-item @select="setTheme('dark')"
              ><moon :size="14" />深色主题</dropdown-menu-item
            >
            <dropdown-menu-item @select="setTheme('light')"
              ><sun :size="14" />亮色主题</dropdown-menu-item
            >
          </dropdown-menu-content>
        </dropdown-menu>
        <Button
          variant="ghost"
          size="icon"
          class="size-8"
          aria-label="查询历史"
          title="查询历史"
          :disabled="!desktop"
          @click="historyOpen = true"
          ><Search :size="16"
        /></Button>
        <Button
          variant="ghost"
          size="icon"
          class="size-8"
          aria-label="设置"
          title="设置"
          @click="appSettingsOpen = true"
          ><settings :size="16"
        /></Button>
        <Button
          variant="ghost"
          size="icon"
          class="size-8"
          aria-label="版本日志"
          title="版本日志"
          @click="releaseOpen = true"
          ><history :size="16"
        /></Button>
        <popover v-model:open="help"
          ><popover-trigger as-child
            ><Button variant="ghost" size="icon" class="size-8" aria-label="帮助" title="帮助"
              ><circle-help :size="16" /></Button></popover-trigger
          ><popover-content align="end" class="w-72"
            ><div class="mb-3 flex items-center justify-between font-medium">
              工作区快捷键<Button
                variant="ghost"
                size="icon"
                class="size-6"
                aria-label="关闭帮助"
                @click="help = false"
                ><x :size="14"
              /></Button>
            </div>
            <p class="text-muted-foreground text-xs leading-7">
              {{ shortcuts.newConnection }}：新建连接<br />{{ shortcuts.execute }}：执行查询<br />{{
                shortcuts.close
              }}：关闭当前会话<br />主题切换：顶部选择深色、亮色或系统<br />停止查询会断开当前连接。
            </p></popover-content
          ></popover
        >
      </div>
    </header>
    <div class="flex min-h-0 flex-1">
      <aside v-if="sidebar" class="bg-sidebar flex w-[250px] shrink-0 flex-col border-r">
        <div class="mb-3 flex h-14 shrink-0 items-center justify-between border-b px-5">
          <div class="flex min-w-0 items-center gap-2">
            <div
              class="bg-primary text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-md"
            >
              <terminal :size="15" :stroke-width="2.3" />
            </div>
            <span class="truncate text-sm font-semibold tracking-tight"
              >vork<span class="text-muted-foreground font-normal"> / shell</span></span
            >
          </div>
          <Button
            variant="ghost"
            size="icon"
            class="size-7 shrink-0"
            aria-label="新建连接"
            title="新建连接"
            @click="open()"
            ><plus :size="16"
          /></Button>
        </div>
        <p v-if="projectsError" class="text-destructive px-4 pb-2 text-xs">
          无法读取项目：{{ projectsError.message }}
        </p>
        <div class="relative mx-4 mb-5">
          <Search class="text-muted-foreground absolute top-2.5 left-2.5" :size="13" /><Input
            v-model="search"
            aria-label="搜索连接"
            class="bg-background/60 placeholder:text-muted-foreground focus:outline-primary h-8 w-full rounded-md border pr-3 pl-8 text-xs"
            placeholder="搜索连接…"
          />
        </div>
        <div class="scroll-area flex-1 overflow-auto px-2">
          <div v-for="group in profileGroups" :key="group.name">
            <Button
              variant="ghost"
              size="sm"
              class="text-muted-foreground mb-1 w-full justify-start text-xs"
              :aria-expanded="!collapsedGroups[group.name]"
              @click="collapsedGroups[group.name] = !collapsedGroups[group.name]"
              >{{ collapsedGroups[group.name] ? '▸' : '▾' }}
              <connection-type-icon :type="group.type" /> {{ group.name || '未分组' }}
              <span class="ml-auto">{{ group.items.length }}</span></Button
            >
            <div
              v-for="profile in collapsedGroups[group.name] ? [] : group.items"
              :key="profile.id"
              :draggable="!reordering"
              class="group mb-1 grid min-w-0 grid-cols-[minmax(0,1fr)_36px] items-center gap-1 rounded-lg border border-transparent pr-1 transition-colors"
              :data-connected="Boolean(profileStates.get(profile.id!)?.connected)"
              :style="
                profile.connectedColor && profileStates.get(profile.id!)?.connected
                  ? {
                      backgroundColor:
                        profile.connectedColor +
                        (profileStates.get(profile.id!)?.active ? '40' : '26'),
                    }
                  : undefined
              "
              :class="
                profileStates.get(profile.id!)?.active
                  ? 'border-primary/40 bg-primary/15 ring-primary/20 ring-1'
                  : profileStates.get(profile.id!)?.connected
                    ? 'bg-primary/5 hover:bg-primary/10'
                    : 'hover:bg-muted'
              "
              @dragstart="startConnectionDrag($event, profile.id!)"
              @dragend="dragging = ''"
              @dragover.prevent
              @drop.prevent="dropConnection(profile.id!)"
            >
              <Button
                variant="ghost"
                :aria-label="`连接 ${profile.name}`"
                :aria-current="profileStates.get(profile.id!)?.active ? 'true' : undefined"
                :disabled="Boolean(connectingProfile)"
                class="flex h-auto min-w-0 items-center justify-start gap-2.5 rounded-lg px-3 py-2.5 text-left shadow-none hover:bg-transparent dark:hover:bg-transparent"
                @click="quickConnect(profile)"
                ><loader-circle
                  v-if="connectingProfile === profile.id"
                  :size="16"
                  class="shrink-0 animate-spin"
                /><plug-zap
                  v-else-if="profileStates.get(profile.id!)?.connected"
                  :size="16"
                  class="text-success shrink-0"
                  role="img"
                  aria-label="已连接"
                /><unplug
                  v-else
                  :size="16"
                  class="text-muted-foreground shrink-0"
                  role="img"
                  aria-label="未连接"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-1">
                    <p class="min-w-0 truncate text-xs leading-5" :title="profile.name">
                      {{ profile.name }}
                    </p>
                  </div>
                </div></Button
              >
              <dropdown-menu>
                <dropdown-menu-trigger as-child>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="text-muted-foreground hover:text-foreground hover:border-border hover:bg-background/70 data-[state=open]:border-border data-[state=open]:bg-background/70 size-8 shrink-0 rounded-md border border-transparent shadow-none"
                    :aria-label="`连接操作 ${profile.name}`"
                    title="更多操作"
                    :disabled="Boolean(connectingProfile)"
                    ><ellipsis :size="15"
                  /></Button>
                </dropdown-menu-trigger>
                <dropdown-menu-content align="end" :side-offset="6">
                  <dropdown-menu-item
                    :aria-label="`编辑连接 ${profile.name}`"
                    @select="open(profile)"
                    ><pencil :size="14" />编辑配置</dropdown-menu-item
                  >
                  <dropdown-menu-item
                    :aria-label="`复制连接 ${profile.name}`"
                    @select="open(duplicateProfile(profile))"
                    ><copy :size="14" />复制配置</dropdown-menu-item
                  >
                  <dropdown-menu-item
                    :aria-label="`管理连接项目 ${profile.name}`"
                    @select="manageProjects(profile)"
                    ><layers :size="14" />管理所属项目</dropdown-menu-item
                  >
                  <dropdown-menu-item @select="colorProfile = profile"
                    ><palette :size="14" />连接背景色</dropdown-menu-item
                  >
                  <dropdown-menu-item
                    aria-label="删除连接"
                    class="text-destructive"
                    @select="remove(profile)"
                    ><trash2 :size="14" />删除连接</dropdown-menu-item
                  >
                </dropdown-menu-content>
              </dropdown-menu>
            </div>
          </div>
          <p v-if="profilesError" class="text-destructive px-3 text-xs">
            无法读取连接配置：{{ profilesError.message }}
          </p>
          <div
            v-if="!visibleProfiles.length && !profilesError"
            class="text-muted-foreground px-3 py-8 text-center text-xs leading-6"
          >
            {{ search ? '没有匹配的连接' : '还没有保存的连接' }}<br v-if="!search" /><span
              v-if="!search"
              >添加服务器或数据库开始探索。</span
            >
          </div>
        </div>
        <div
          v-if="playgroundCard !== 'hidden'"
          class="bg-background/30 m-3 shrink-0 rounded-lg border p-3"
        >
          <div
            class="flex items-center gap-2 text-xs"
            :class="playgroundCard === 'expanded' ? 'mb-2' : ''"
          >
            <database :size="14" class="text-primary" /><span class="flex-1">本地试验台</span>
            <Button
              variant="ghost"
              size="icon-xs"
              :aria-label="playgroundCard === 'expanded' ? '收起本地试验台' : '展开本地试验台'"
              :aria-expanded="playgroundCard === 'expanded'"
              @click="playgroundCard = playgroundCard === 'expanded' ? 'collapsed' : 'expanded'"
              ><chevron-right :size="14" :class="playgroundCard === 'expanded' ? 'rotate-90' : ''"
            /></Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="关闭本地试验台"
              @click="playgroundCard = 'hidden'"
              ><x :size="14"
            /></Button>
          </div>
          <template v-if="playgroundCard === 'expanded'">
            <p class="text-muted-foreground mb-3 text-[11px] leading-5">
              无需服务器，用临时 SQLite 数据库试试查询。
            </p>
            <Button variant="outline" size="sm" class="h-7 w-full text-xs" @click="playground"
              >打开 SQLite<arrow-up-right :size="12"
            /></Button>
          </template>
        </div>
        <div class="flex shrink-0 items-center gap-1 border-t px-3 py-2">
          <Select v-model="projectFilter"
            ><select-trigger aria-label="筛选连接项目" class="h-8 min-w-0 flex-1 text-xs"
              ><select-value>{{
                activeProject
                  ? `${activeProject.name} · ${activeProject.connectionIds.length}`
                  : '全部连接 · 按类型'
              }}</select-value></select-trigger
            ><select-content
              ><select-item value="all">全部连接 · 按类型</select-item
              ><select-item v-for="project in projects || []" :key="project.id" :value="project.id"
                >{{ project.name }} · {{ project.connectionIds.length }}</select-item
              ></select-content
            ></Select
          >

          <Button
            variant="ghost"
            size="icon"
            class="size-8 shrink-0"
            aria-label="管理项目"
            title="管理项目"
            @click="manageProjects()"
            ><layers :size="16"
          /></Button>
        </div>
      </aside>
      <main class="relative flex min-w-0 flex-1 flex-col">
        <nav class="bg-sidebar/30 flex h-11 shrink-0 items-stretch border-b">
          <div
            ref="tabStrip"
            class="scroll-area flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
            @scroll="measureTabs"
          >
            <Button
              variant="ghost"
              class="h-auto min-h-0 justify-start py-0 whitespace-nowrap shadow-none"
              :class="[
                'flex shrink-0 items-center gap-2 self-stretch rounded-none border-r px-5 text-xs',
                !active
                  ? 'border-b-primary bg-background text-foreground border-b-2'
                  : 'text-muted-foreground',
              ]"
              @click="active = ''"
              ><layers :size="13" />工作台</Button
            ><context-menu v-for="session in sessions" :key="session.id"
              ><context-menu-trigger as-child
                ><div
                  :data-session-tab="session.id"
                  :style="tabBackground(session)"
                  :class="[
                    'flex shrink-0 items-center gap-2 border-r pr-2 pl-4 text-xs',
                    active === session.id
                      ? 'border-b-primary bg-accent border-b-2'
                      : 'text-muted-foreground',
                  ]"
                >
                  <Button
                    variant="ghost"
                    class="flex h-full min-h-0 items-center justify-start gap-2 rounded-none bg-transparent py-0 whitespace-nowrap shadow-none hover:bg-transparent focus-visible:ring-inset dark:hover:bg-transparent"
                    @click="active = session.id"
                    ><span
                      :class="[
                        'size-1.5 rounded-full',
                        closed[session.id] ? 'bg-muted-foreground' : 'bg-success',
                      ]"
                    />{{ session.name }}</Button
                  ><Button
                    variant="ghost"
                    size="icon-xs"
                    class="hover:bg-muted size-6 rounded p-1"
                    :aria-label="`关闭 ${session.name}`"
                    @click="close(session.id)"
                    ><x :size="12"
                  /></Button></div></context-menu-trigger
              ><context-menu-content
                ><context-menu-item @select="close(session.id)">关闭标签</context-menu-item
                ><context-menu-item :disabled="sessions.length < 2" @select="closeMany(session.id)"
                  >关闭其他标签</context-menu-item
                ><context-menu-item @select="closeMany()">关闭所有标签</context-menu-item
                ><context-menu-item
                  :disabled="duplicating || Boolean(closed[session.id])"
                  @select="duplicateTab(session.id)"
                  >复制标签（独立连接）</context-menu-item
                ></context-menu-content
              ></context-menu
            >
          </div>
          <dropdown-menu v-if="overflowingTabs">
            <dropdown-menu-trigger as-child
              ><Button
                variant="ghost"
                size="icon"
                class="h-full w-10 shrink-0 rounded-none border-l"
                aria-label="查看隐藏标签"
                title="隐藏标签"
                ><chevron-down :size="14" /></Button
            ></dropdown-menu-trigger>
            <dropdown-menu-content align="end" class="max-h-80 w-64 overflow-y-auto">
              <dropdown-menu-item
                v-for="session in hiddenTabs"
                :key="session.id"
                @select="jumpToTab(session.id)"
                ><span class="min-w-0 truncate">{{ session.name }}</span></dropdown-menu-item
              >
            </dropdown-menu-content>
          </dropdown-menu>
        </nav>
        <div
          v-if="!active"
          class="scroll-area flex-1 overflow-y-auto px-10 py-12 xl:px-16 xl:py-16"
        >
          <div class="enter mx-auto max-w-[940px]">
            <div
              class="text-primary mb-5 flex items-center gap-2 font-mono text-[10px] tracking-[.2em]"
            >
              <span class="bg-primary h-px w-6" />VORK SHELL / 01
            </div>
            <h1 class="text-[34px] leading-tight font-semibold tracking-[-.045em]">
              每个连接，都在一处。
            </h1>
            <p class="text-muted-foreground mt-4 max-w-[560px] text-sm leading-7">
              从远程服务器到本地数据库，把终端、查询和数据放进同一个工作区。少一点切换，多一点专注。
            </p>
            <div class="mt-7 flex items-center gap-4">
              <Button @click="open()"
                ><plus :size="15" />新建连接<span class="ml-5 font-mono text-[10px] opacity-60"
                  >⌘ N</span
                ></Button
              ><Button variant="ghost" @click="playground"
                >体验 SQLite<arrow-up-right :size="14"
              /></Button>
            </div>
            <div class="mt-12 mb-4 flex items-center justify-between">
              <span class="text-muted-foreground text-[10px] font-medium tracking-[.16em]"
                >CONNECT TO YOUR WORLD</span
              ><span class="text-muted-foreground font-mono text-[10px]">6 CONNECTION TYPES</span>
            </div>
            <div class="grid grid-cols-2 gap-3 xl:grid-cols-3">
              <Button
                v-for="item in [
                  { type: 'ssh', name: 'SSH', description: '打开远程终端', badge: 'TERMINAL' },
                  {
                    type: 'sqlite',
                    name: 'SQLite',
                    description: '访问本地数据库文件',
                    badge: 'LOCAL',
                  },
                  {
                    type: 'mysql',
                    name: 'MySQL',
                    description: '查询和管理关系型数据',
                    badge: 'DATABASE',
                  },
                  {
                    type: 'postgresql',
                    name: 'PostgreSQL',
                    description: '探索你的 PostgreSQL 数据',
                    badge: 'DATABASE',
                  },
                  {
                    type: 'redis',
                    name: 'Redis',
                    description: '执行命令，查看键值结果',
                    badge: 'KEY-VALUE',
                  },
                  {
                    type: 'mongodb',
                    name: 'MongoDB',
                    description: '浏览集合，查询和编辑文档',
                    badge: 'DOCUMENT',
                  },
                ]"
                :key="item.type"
                variant="ghost"
                class="group bg-card hover:border-primary/60 relative flex h-auto min-h-[142px] flex-col items-start justify-start rounded-xl border p-5 text-left whitespace-normal shadow-none transition-all hover:-translate-y-0.5"
                @click="
                  open({
                    type: item.type as ConnectionConfig['type'],
                    name: '',
                    host: 'localhost',
                    port: {
                      ssh: 22,
                      sqlite: 0,
                      mysql: 3306,
                      postgresql: 5432,
                      redis: 6379,
                      mongodb: 27017,
                    }[item.type as 'ssh'],
                    path: item.type === 'sqlite' ? ':memory:' : '',
                    username: '',
                  })
                "
                ><div class="mb-5 flex w-full items-center justify-between">
                  <connection-type-icon
                    :type="item.type as ConnectionConfig['type']"
                    :size="22"
                  /><span class="text-muted-foreground font-mono text-[9px] tracking-wider">{{
                    item.badge
                  }}</span>
                </div>
                <span class="text-sm font-medium">{{ item.name }}</span
                ><span class="text-muted-foreground mt-2 text-xs">{{ item.description }}</span
                ><chevron-right
                  :size="14"
                  class="text-muted-foreground group-hover:text-primary absolute right-5 bottom-5"
              /></Button>
              <div
                class="text-muted-foreground flex min-h-[142px] flex-col justify-center rounded-xl border border-dashed p-5"
              >
                <plug-zap :size="20" :stroke-width="1.4" class="mb-4" />
                <p class="text-xs leading-6">一个工作区<br />容纳你的所有连接。</p>
              </div>
            </div>
            <div
              class="text-muted-foreground mt-10 flex items-center justify-between border-t pt-5 text-[11px]"
            >
              <span class="flex items-center gap-2"><command :size="13" />用快捷键，保持心流</span
              ><span
                >新建连接 <kbd class="ml-1 rounded border px-1.5 py-1 font-mono">⌘ N</kbd
                ><span class="mx-5">·</span>执行查询
                <kbd class="ml-1 rounded border px-1.5 py-1 font-mono">⌘ ↵</kbd></span
              >
            </div>
          </div>
        </div>
        <template v-for="session in sessions" :key="session.id">
          <section v-show="active === session.id" class="flex min-h-0 flex-1 flex-col">
            <div
              class="text-muted-foreground flex h-10 shrink-0 items-center justify-between border-b px-5 text-[11px]"
            >
              <span class="flex items-center gap-2"
                ><span class="font-medium uppercase">{{ session.type }}</span
                ><chevron-right :size="12" /><span class="font-mono">{{
                  session.target
                }}</span></span
              >
              <div class="flex items-center gap-3">
                <connection-details
                  v-if="session.type !== 'redis'"
                  :session="session"
                  :closed="Boolean(closed[session.id])"
                />
                <span :class="closed[session.id] ? 'text-destructive' : 'text-success'">{{
                  closed[session.id] || '已连接'
                }}</span
                ><Button
                  v-if="!closed[session.id]"
                  variant="outline"
                  size="xs"
                  :aria-label="`关闭连接 ${session.name}`"
                  :disabled="Boolean(disconnecting[session.id])"
                  @click="disconnectSession(session.id)"
                  >{{ disconnecting[session.id] ? '关闭中…' : '关闭连接' }}</Button
                ><Button
                  v-if="closed[session.id]"
                  variant="outline"
                  size="xs"
                  :aria-label="`重连 ${session.name}`"
                  :disabled="Boolean(reconnecting)"
                  @click="reconnect(session)"
                  ><rotate-cw :size="12" />{{
                    reconnecting === session.id ? '连接中…' : '重新连接'
                  }}</Button
                >
              </div>
            </div>
            <div class="min-h-0 flex-1">
              <panel-error-boundary
                ><p
                  v-if="restoredIds.has(session.id) && session.type === 'ssh'"
                  class="text-muted-foreground p-10 text-center text-sm"
                >
                  SSH 标签已恢复，点击重新连接打开终端。
                </p>
                <ssh-panel
                  v-else-if="session.type === 'ssh'"
                  :session="session"
                  :active="active === session.id"
                  :closed="Boolean(closed[session.id])" /><redis-panel
                  v-else-if="session.type === 'redis'"
                  :session="session"
                  :closed="Boolean(closed[session.id])" /><mongodb-panel
                  v-else-if="session.type === 'mongodb'"
                  :session="session"
                  :closed="Boolean(closed[session.id])" /><query-panel
                  v-else
                  :prepared="preparedQueries[session.id]"
                  :restored="queryDrafts[session.id]"
                  :session="session"
                  :closed="Boolean(closed[session.id])"
                  @snapshot="queryDrafts[session.id] = $event"
                  @draft="recordDraft(session.id, $event)"
              /></panel-error-boundary>
            </div>
          </section>
        </template>
      </main>
    </div>
    <footer
      class="bg-sidebar text-muted-foreground flex h-7 shrink-0 items-center justify-between border-t px-4 font-mono text-[10px]"
    >
      <span class="flex items-center gap-2"
        ><span :class="['size-1.5 rounded-full', desktop ? 'bg-success' : 'bg-primary']" />{{
          desktop ? 'DESKTOP READY' : 'BROWSER PREVIEW · 连接功能需桌面环境'
        }}<span class="mx-2">/</span>{{ activeCount }} 个活动连接</span
      ><span
        >{{ current?.type.toUpperCase() || 'VORK SHELL' }}<span class="mx-3">·</span
        ><Button
          variant="link"
          class="text-muted-foreground h-auto p-0 font-mono text-[10px]"
          aria-label="查看版本日志"
          @click="releaseOpen = true"
          >v{{ appVersion }}</Button
        ></span
      >
    </footer>
    <history-search v-model:open="historyOpen" @restore="restoreQuery" />
    <connection-color
      :profile="colorProfile"
      @close="colorProfile = undefined"
      @saved="queryClient.invalidateQueries({ queryKey: ['profiles'] })"
    />
    <app-settings
      v-model:open="appSettingsOpen"
      @import="openImport"
      @release="releaseOpen = true"
      @shortcuts="settingsOpen = true"
      @logs="logsOpen = true"
    />
    <activity-log-page v-model:open="logsOpen" />
    <shortcut-settings v-model:open="settingsOpen" />
    <toast-host />
    <alert-dialog
      :open="Boolean(deletingProfile)"
      @update:open="
        (open) => {
          if (!open && !deleting) deletingProfile = undefined
        }
      "
      ><alert-dialog-content
        ><alert-dialog-header
          ><alert-dialog-title>删除连接配置</alert-dialog-title
          ><alert-dialog-description
            >确认删除「{{
              deletingProfile?.name
            }}」？此操作仅删除保存的连接配置。</alert-dialog-description
          ></alert-dialog-header
        >
        <p v-if="deleteError" role="alert" class="text-destructive text-sm">{{ deleteError }}</p>
        <alert-dialog-footer
          ><alert-dialog-cancel :disabled="deleting">取消</alert-dialog-cancel
          ><Button variant="destructive" :disabled="deleting" @click="confirmRemove">{{
            deleting ? '删除中…' : '确认删除'
          }}</Button></alert-dialog-footer
        ></alert-dialog-content
      ></alert-dialog
    >
    <release-page v-model:open="releaseOpen" />
    <project-manager
      v-model:open="projectManagerOpen"
      :ready="Boolean(projects) && !projectsPending && !projectsError"
      :projects="projects || []"
      :profiles="profiles || []"
      :connection="projectConnection"
      :initial-id="projectFilter"
      @changed="refreshProjects"
      @activate="
        async (id) => {
          await refreshProjects()
          projectFilter = id
        }
      "
    />
    <connection-import v-model:open="importOpen" @imported="onConnectionsImported" />
    <Dialog v-model:open="recentTabsOpen">
      <dialog-content class="sm:max-w-lg" @keydown="recentTabKey">
        <dialog-header
          ><dialog-title>最近编辑的标签</dialog-title
          ><dialog-description
            >Cmd+P / Ctrl+P 打开，↑↓ 选择，Enter 跳转。</dialog-description
          ></dialog-header
        >
        <Input
          v-model="recentTabSearch"
          aria-label="搜索最近编辑的标签"
          placeholder="搜索标签名称或连接类型…"
        />
        <div class="max-h-80 space-y-1 overflow-y-auto">
          <Button
            v-for="(session, index) in recentTabs"
            :key="session.id"
            variant="ghost"
            class="w-full justify-start gap-3"
            :class="index === recentTabIndex ? 'bg-accent' : ''"
            @click="jumpToTab(session.id)"
            ><span class="min-w-0 flex-1 truncate text-left">{{ session.name }}</span
            ><span class="text-muted-foreground text-xs">{{ session.type }}</span></Button
          >
          <p v-if="!recentTabs.length" class="text-muted-foreground p-4 text-center text-sm">
            没有匹配的标签。
          </p>
        </div>
      </dialog-content>
    </Dialog>
    <connection-dialog
      v-model:open="dialogOpen"
      :profile="selectedProfile"
      @connected="add"
      @saved="refresh"
    />
  </div>
</template>
