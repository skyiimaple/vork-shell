import { ref, computed } from 'vue'
export type ThemeMode = 'dark' | 'light' | 'system'
const media = matchMedia('(prefers-color-scheme: dark)')
const stored = localStorage.getItem('vork.theme')
export const theme = ref<ThemeMode>(
  stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system',
)
export const systemDark = ref(media.matches)
export const isDark = computed(
  () => theme.value === 'dark' || (theme.value === 'system' && systemDark.value),
)
function apply() {
  document.documentElement.classList.toggle('dark', isDark.value)
}
media.addEventListener('change', (e) => {
  systemDark.value = e.matches
  apply()
})
export function setTheme(mode: ThemeMode) {
  theme.value = mode
  localStorage.setItem('vork.theme', mode)
  apply()
}
apply()
