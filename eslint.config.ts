import { globalIgnores } from 'eslint/config'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'
import unicorn from 'eslint-plugin-unicorn'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'
import js from '@eslint/js'
import globals from 'globals'

export default defineConfigWithVueTs(
  { name: 'app/files-to-lint', files: ['**/*.{ts,mts,tsx,vue}'] },
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    '**/out/**',
    '**/release/**',
    '**/docs/**',
    '**/.artifacts/**',
    'pnpm-lock.yaml',
    'public/changelog.html',
  ]),
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,
  {
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'vue/component-name-in-template-casing': [
        'error',
        'kebab-case',
        {
          registeredComponentsOnly: false,
          // Button、Dialog 等转成 kebab-case 后会和原生标签重名，Vue 会当成 HTML 元素。
          ignores: [
            'Button',
            'Copy',
            'Database',
            'Dialog',
            'Download',
            'Input',
            'Label',
            'Progress',
            'Search',
            'Select',
            'Table',
            'Textarea',
            'Upload',
          ],
        },
      ],
      'vue/multi-word-component-names': 'off',
      'vue/block-order': ['error', { order: ['script', 'template', 'style'] }],
    },
  },
  {
    files: ['src/**/*.{ts,vue}'],
    ignores: ['src/renderer/src/components/ui/**', 'src/**/*.d.ts'],
    plugins: { unicorn },
    rules: { 'unicorn/filename-case': ['error', { case: 'kebabCase' }] },
  },
  {
    files: ['**/*.vue'],
    rules: {
      // Vue compiler macros are not ESLint globals.
      'no-undef': 'off',
    },
  },
  {
    files: ['src/renderer/**/*.{ts,vue}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/env.d.ts', 'electron.vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['scripts/**/*.cjs', 'electron-builder.cjs'],
    ...js.configs.recommended,
    languageOptions: { globals: globals.node, sourceType: 'commonjs' },
    rules: {
      ...js.configs.recommended.rules,
      'no-console': 'off',
      'no-unused-expressions': ['error', { allowTernary: true }],
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }],
    },
  },
  { files: ['tests/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'off' } },
  {
    files: ['src/main/export.ts', 'src/main/ssh-batch.ts', 'src/main/ssh-tools.ts'],
    rules: { 'no-control-regex': 'off' },
  },
  {
    files: ['src/renderer/src/components/ui/**/*.vue'],
    rules: { 'vue/require-default-prop': 'off' },
  },
  skipFormatting,
)
