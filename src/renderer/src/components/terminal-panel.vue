<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { isDark } from '@/composables/use-theme'
const props = defineProps<{ sessionId: string; active: boolean; channelId?: string }>()
const element = ref<HTMLDivElement>()
const terminal = new Terminal({
  cursorBlink: true,
  fontFamily: 'SFMono-Regular, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.35,
  scrollback: 5000,
  allowProposedApi: false,
})
const fit = new FitAddon()
let observer: ResizeObserver, unsubscribe: (() => void) | undefined
function colors() {
  terminal.options.theme = isDark.value
    ? {
        background: '#15171a',
        foreground: '#d5d9df',
        cursor: '#dca35b',
        selectionBackground: '#414450',
      }
    : {
        background: '#ffffff',
        foreground: '#24282b',
        cursor: '#bd7925',
        selectionBackground: '#dddde6',
      }
}
function resize() {
  if (!props.active || !element.value?.clientWidth) return
  fit.fit()
  window.vork.resize(props.sessionId, terminal.cols, terminal.rows, props.channelId)
}
watch(isDark, colors)
watch(
  () => props.active,
  async (active) => {
    if (active) {
      await nextTick()
      resize()
      terminal.focus()
    }
  },
)
onMounted(() => {
  colors()
  terminal.loadAddon(fit)
  terminal.open(element.value!)
  resize()
  terminal.onData((data) => window.vork.write(props.sessionId, data, props.channelId))
  unsubscribe = window.vork.onEvent((event) => {
    if (
      event.type === 'transfer' ||
      event.sessionId !== props.sessionId ||
      (event.channelId && event.channelId !== (props.channelId || 'default'))
    )
      return
    if (event.type === 'data')
      terminal.write(event.data, () =>
        window.vork.ack(
          props.sessionId,
          new TextEncoder().encode(event.data).length,
          props.channelId,
        ),
      )
    else terminal.writeln(`\r\n\x1b[90m[${event.data}]\x1b[0m`)
  })
  observer = new ResizeObserver(resize)
  observer.observe(element.value!)
  window.vork.ack(props.sessionId, 0, props.channelId)
  terminal.focus()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  unsubscribe?.()
  terminal.dispose()
})
</script>
<template>
  <div class="bg-editor h-full min-h-0 p-5"><div ref="element" class="h-full w-full" /></div>
</template>
