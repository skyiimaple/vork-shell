# MVP Enhancements Implementation Plan

> User approved design and requested continuous execution without further confirmations.

**Goal:** Complete all requested UX, protocol and stability improvements.
**Architecture:** Keep drivers and filesystem dialogs in main; renderer uses narrow typed preload contracts. Isolate terminal channels and panel failures.
**Tech Stack:** Electron, Vue 3, shadcn-vue, CodeMirror, TanStack Table, xterm, node:sqlite.
**Spec:** docs/superpowers/specs/2026-10-06-mvp-enhancements.md

## Global Constraints

- Business UI uses components/ui; no browser prompt/confirm/alert.
- Each feature runs pnpm typecheck and pnpm test; no automatic retry of mutations.
- Preserve existing bounded results, credential encryption and IPC ownership.

## Tasks

- [x] Panel error boundaries: components/PanelErrorBoundary.vue wrapping each session, reset rerenders only that panel.
- [x] Toast queue: composables/notifications.ts and components/ToastHost.vue, reuse Alert/Button; wire application messages.
- [x] Window state: main/window-state.ts with display validation and atomic store; main/index.ts hooks normal bounds/maximize and restore.
- [x] Shortcuts: lib/shortcuts.ts, settings dialog, reactive CodeMirror execute key and app key actions; invalid/duplicate rejection.
- [x] Connection drag reorder: ProfileStore.reorder validates full permutation, IPC/preload; sidebar drag/drop persisted.
- [x] Connection folders: group field preserved/validated in config storage, group control and sidebar folders; ungrouped legacy configs.
- [x] Session context menu: disconnect all/others, duplicate with main retained config and independent session, no renderer secret copies.
- [x] Result resizing/sorting: ResultTable.vue sizing and sorted row model with virtual rows; numeric/null/mixed stable sorting tested.
- [x] SQL format: token-aware formatter, button in QueryPanel.vue; protect literals/comments and preserve malformed input.
- [x] Query history search: bounded shared persistent history, connection identity, dialog restore into selected session without executing.
- [x] SSH split PTYs: ssh.ts channel map and per-channel backpressure; session/preload contracts and SshPanel split UI; lifecycle tests.
- [x] SFTP batches: main file dialogs and serial file transfers; selected remote files and item results in SshPanel; no-overwrite behavior.
- [x] Redis bulk TTL: bounded key request validation, per-key outcomes, selection/confirmation in RedisPanel.
- [x] SQLite import/dump: worker utility commands, bounded main file dialogs, transactional CSV import and typed SQL dump, roundtrip tests.

## Progress

Baseline: typecheck passes, 40 tests passed / 2 skipped outside sandbox. Current sandbox disallows localhost listeners; approval policy now never.
Workspace ruling: all MVP sources untracked, user explicitly requested in-place code; retain working directory and avoid commits of unrelated files.

Implementation and final source review complete. Final checks: typecheck/UI audit/build pass; full suite 71 passed, 4 SSH EPERM failures, 2 optional remote integration skipped. Focused suite excludes only SSH network suites and passes 71 tests. Native Electron smoke aborted in macOS application initialization before test script. Built-worker verification recorded below after execution. No commits of the untracked baseline.

Built worker: node scripts/worker-tools-smoke.cjs passed after final build (request routing, CSV import, full rollback, SQL dump restoration, subsequent query). Final formatter/result-model regressions verified.
