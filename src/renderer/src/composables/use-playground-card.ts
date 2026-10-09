import { ref, watch } from 'vue'
type CardState = 'expanded' | 'collapsed' | 'hidden'
const stored = localStorage.getItem('vork.playground-card')
export const playgroundCard = ref<CardState>(
  stored === 'collapsed' || stored === 'hidden' ? stored : 'expanded',
)
watch(playgroundCard, (value) => localStorage.setItem('vork.playground-card', value))
