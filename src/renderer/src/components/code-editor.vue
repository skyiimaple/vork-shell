<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
} from '@codemirror/view'
import {
  autocompletion,
  completionKeymap,
  acceptCompletion,
  closeCompletion,
} from '@codemirror/autocomplete'
import type { SqlCompletionTable } from '@/lib/sql-completion'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, syntaxHighlighting } from '@codemirror/language'
import { classHighlighter } from '@lezer/highlight'
import { codeLanguage, type CodeLanguage } from '@/lib/code-language'
import { shortcuts } from '@/composables/use-shortcuts'
import { isDark } from '@/composables/use-theme'
const props = defineProps<{
  modelValue: string
  language: CodeLanguage
  disabled?: boolean
  label: string
  tables?: SqlCompletionTable[]
}>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  execute: [selection?: string]
  selection: [text: string]
}>()
const host = ref<HTMLElement>()
const languageCompartment = new Compartment(),
  editable = new Compartment(),
  appearance = new Compartment(),
  execution = new Compartment()
let view: EditorView | undefined
function editorTheme() {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'var(--editor)',
        color: 'var(--foreground)',
        fontSize: '13px',
      },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '24px' },
      '.cm-content': { padding: '16px 0', caretColor: 'var(--foreground)' },
      '.cm-line': { padding: '0 16px' },
      '.cm-gutters': {
        backgroundColor: 'var(--editor)',
        color: 'var(--muted-foreground)',
        borderRight: '1px solid var(--border)',
      },
      '.cm-gutterElement': { minWidth: '40px' },
      '.cm-activeLine, .cm-activeLineGutter': {
        backgroundColor: isDark.value ? 'rgba(148,163,184,0.08)' : 'rgba(100,116,139,0.06)',
      },
      '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
      '&.cm-focused': { outline: 'none' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: isDark.value
          ? 'rgba(59,130,246,0.42) !important'
          : 'rgba(59,130,246,0.28) !important',
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--popover)',
        color: 'var(--popover-foreground)',
        border: '1px solid var(--border)',
        borderRadius: '6px',
      },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'var(--accent)',
        color: 'var(--accent-foreground)',
      },
      '.cm-completionLabel': { fontFamily: 'var(--font-mono)' },
      '.cm-matchingBracket': { backgroundColor: 'var(--accent)', outline: '1px solid var(--ring)' },
    },
    { dark: isDark.value },
  )
}
function readOnly() {
  return [
    EditorState.readOnly.of(Boolean(props.disabled)),
    EditorView.editable.of(!props.disabled),
    EditorView.contentAttributes.of({
      'aria-label': props.label,
      'aria-readonly': String(Boolean(props.disabled)),
      spellcheck: 'false',
    }),
  ]
}
onMounted(() => {
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        autocompletion({ defaultKeymap: false }),
        syntaxHighlighting(classHighlighter),
        languageCompartment.of(codeLanguage(props.language, props.tables)),
        editable.of(readOnly()),
        appearance.of(editorTheme()),
        execution.of(
          keymap.of([
            {
              key: shortcuts.value.execute,
              run: () => {
                if (!props.disabled)
                  emit(
                    'execute',
                    view?.state.sliceDoc(
                      view.state.selection.main.from,
                      view.state.selection.main.to,
                    ),
                  )
                return true
              },
            },
          ]),
        ),
        keymap.of([
          { key: 'Tab', run: acceptCompletion },
          ...completionKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
          if (update.docChanged || update.selectionSet)
            emit(
              'selection',
              update.state.sliceDoc(
                update.state.selection.main.from,
                update.state.selection.main.to,
              ),
            )
        }),
      ],
    }),
  })
})
watch(
  () => props.modelValue,
  (value) => {
    if (view && value !== view.state.doc.toString())
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  },
)
watch(
  () => [props.language, props.tables],
  () => {
    if (view) {
      closeCompletion(view)
      view.dispatch({
        effects: languageCompartment.reconfigure(codeLanguage(props.language, props.tables)),
      })
    }
  },
)
watch(
  () => [props.disabled, props.label],
  () => view?.dispatch({ effects: editable.reconfigure(readOnly()) }),
)
watch(shortcuts, () =>
  view?.dispatch({
    effects: execution.reconfigure(
      keymap.of([
        {
          key: shortcuts.value.execute,
          run: () => {
            if (!props.disabled)
              emit(
                'execute',
                view?.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
              )
            return true
          },
        },
      ]),
    ),
  }),
)
watch(isDark, () => view?.dispatch({ effects: appearance.reconfigure(editorTheme()) }))
onBeforeUnmount(() => {
  view?.destroy()
  view = undefined
})
</script>
<template><div ref="host" class="code-editor min-h-0 min-w-0 overflow-hidden" /></template>
<style>
.code-editor .tok-keyword {
  color: #8950a7;
}
.code-editor .tok-string {
  color: #287749;
}
.code-editor .tok-number,
.code-editor .tok-bool,
.code-editor .tok-null {
  color: #a15c13;
}
.code-editor .tok-comment {
  color: #778078;
  font-style: italic;
}
.code-editor .tok-operator,
.code-editor .tok-punctuation {
  color: #596a7b;
}
.code-editor .tok-typeName,
.code-editor .tok-className {
  color: #246993;
}
.dark .code-editor .tok-keyword {
  color: #cb9fe6;
}
.dark .code-editor .tok-string {
  color: #9cc99c;
}
.dark .code-editor .tok-number,
.dark .code-editor .tok-bool,
.dark .code-editor .tok-null {
  color: #e6b878;
}
.dark .code-editor .tok-comment {
  color: #8b9591;
}
.dark .code-editor .tok-operator,
.dark .code-editor .tok-punctuation {
  color: #a5b8ce;
}
.dark .code-editor .tok-typeName,
.dark .code-editor .tok-className {
  color: #8fc6e1;
}
</style>
