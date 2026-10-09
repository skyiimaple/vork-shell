import { createApp } from 'vue'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import App from './app.vue'
import './style.css'
import './composables/use-theme'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false, gcTime: 0 },
  },
})
createApp(App).use(VueQueryPlugin, { queryClient }).mount('#app')
