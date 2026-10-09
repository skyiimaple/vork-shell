import pkg from './package.json'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __UPDATE_ENABLED__: JSON.stringify(process.env.VORK_ENABLE_UPDATES === '1'),
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'sqlite-worker': resolve('src/main/sqlite-worker.ts'),
        },
        external: ['ssh2', 'mysql2/promise', 'pg', 'redis', 'mongodb', 'electron-updater'],
      },
    },
  },
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [vue(), tailwindcss()],
  },
})
