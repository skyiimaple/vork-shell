import { ref } from 'vue'
export function createNotifications() {
  const items = ref<{ id: number; message: string; kind: 'info' | 'error' }[]>([])
  let sequence = 0
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  function dismiss(id: number) {
    clearTimeout(timers.get(id))
    timers.delete(id)
    items.value = items.value.filter((item) => item.id !== id)
  }
  function notify(message: string, kind: 'info' | 'error' = 'info', persistent = false) {
    const id = ++sequence
    if (items.value.length >= 5) dismiss(items.value[0]!.id)
    items.value.push({ id, message, kind })
    if (!persistent)
      timers.set(
        id,
        setTimeout(() => dismiss(id), 7000),
      )
    return id
  }
  function dispose() {
    for (const id of timers.keys()) dismiss(id)
  }
  return { items, notify, dismiss, dispose }
}
export const notifications = createNotifications()
