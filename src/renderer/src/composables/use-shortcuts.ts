import { ref } from 'vue'
import { defaultShortcuts, validateShortcuts, type Shortcuts } from '../lib/shortcuts'
function load() {
  try {
    return validateShortcuts({
      ...defaultShortcuts,
      ...JSON.parse(localStorage.getItem('vork-shortcuts') || '{}'),
    })
  } catch {
    return { ...defaultShortcuts }
  }
}
export const shortcuts = ref<Shortcuts>(load())
export function saveShortcuts(value: Shortcuts) {
  const next = validateShortcuts(value)
  localStorage.setItem('vork-shortcuts', JSON.stringify(next))
  shortcuts.value = next
}
