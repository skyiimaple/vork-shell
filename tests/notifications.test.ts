import { expect, it, vi } from 'vitest'
import { createNotifications } from '../src/renderer/src/composables/use-notifications'
it('keeps concurrent notices independently dismissible and expires them without dropping newer notices', () => {
  vi.useFakeTimers()
  const queue = createNotifications()
  const first = queue.notify('first')
  vi.advanceTimersByTime(1000)
  queue.notify('second', 'error')
  queue.dismiss(first)
  expect(queue.items.value.map((n) => n.message)).toEqual(['second'])
  vi.advanceTimersByTime(7000)
  expect(queue.items.value).toHaveLength(0)
  queue.dispose()
  vi.useRealTimers()
})

it('keeps connection failure notices visible until explicitly dismissed', () => {
  vi.useFakeTimers()
  const queue = createNotifications()
  const id = queue.notify('连接失败', 'error', true)
  vi.advanceTimersByTime(60000)
  expect(queue.items.value.map((n) => n.message)).toEqual(['连接失败'])
  queue.dismiss(id)
  expect(queue.items.value).toHaveLength(0)
  queue.dispose()
  vi.useRealTimers()
})
