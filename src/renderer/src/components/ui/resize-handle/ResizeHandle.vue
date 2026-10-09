<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
const props = defineProps<{ axis: 'horizontal' | 'vertical'; label: string }>()
const emit = defineEmits<{ resize: [delta: number] }>()
const start = ref<number>()
function down(e: PointerEvent) {
  if (e.button !== 0) return
  start.value = props.axis === 'horizontal' ? e.clientX : e.clientY
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}
function move(e: PointerEvent) {
  if (start.value === undefined) return
  const next = props.axis === 'horizontal' ? e.clientX : e.clientY
  emit('resize', next - start.value)
  start.value = next
}
</script>
<template>
  <Button
    variant="ghost"
    role="separator"
    :aria-label="label"
    :title="label"
    :aria-orientation="axis === 'horizontal' ? 'vertical' : 'horizontal'"
    :class="
      axis === 'horizontal' ? 'h-full w-1.5 cursor-col-resize' : 'h-1.5 w-full cursor-row-resize'
    "
    class="hover:bg-primary/30 bg-border/50 shrink-0 touch-none rounded-none p-0"
    @pointerdown="down"
    @pointermove="move"
    @pointerup="start = undefined"
    @pointercancel="start = undefined"
    @lostpointercapture="start = undefined"
    @keydown.left.prevent="emit('resize', -10)"
    @keydown.right.prevent="emit('resize', 10)"
    @keydown.up.prevent="emit('resize', -10)"
    @keydown.down.prevent="emit('resize', 10)"
  />
</template>
