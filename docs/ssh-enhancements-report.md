# SSH enhancements implementation report

Implemented the approved SSH enhancements without further confirmations.

## Independent terminal splits

- A single authenticated ssh2 Client now owns up to four independent PTY channels. The original terminal remains `default`, and existing write/resize/ack calls without a channel ID still target it.
- Added terminal-open and terminal-close ownership checked IPC, channel IDs on terminal events, and optional IDs on input/resize/ack.
- Each PTY owns its UTF-8 decoder, queued output, in-flight acknowledgement counter, pause/resume state and buffer limit. An overflowing or closed PTY releases that channel while leaving SFTP, tunnels and sibling terminals connected.
- Terminal toolbar offers horizontal/vertical layout and per-pane close controls. Each terminal fits its own pane using ResizeObserver. Layout is a flat row/column of at most four panes, not a nested resizable split tree.
- Global transport events omit channelId; PTY events include it. App.vue must only mark the whole session closed on transport events (root agent owns that change).

## SFTP batch upload/download

- `ssh-batch.ts` registers batch IPC with injected native picker callbacks. Upload uses `openFile` + `multiSelections`; download selects a destination directory via `openDirectory`. Renderer never supplies local transfer paths.
- Each batch is bounded to 100 files, processed sequentially, and returns one success/failure outcome per input while continuing after individual failures. Cancellation returns an empty canceled result.
- Upload remote filenames derive from local basenames and pass UTF-8/path separator/control-character/length safety checks. Duplicate basenames are reported individually without a second publication. Existing remote SFTP upload temporary-file/rename protection remains in use.
- Directory listings identify ordinary files. Checkboxes support up to 100 selected ordinary files and selection clears when loading another directory. Download verifies lstat is an ordinary file again.
- Batch local downloads publish using hard-link creation from the completed same-directory temporary file, atomically refusing existing destination files, including symlinks; the temporary file is removed after success or failure. Single-file save-dialog downloads preserve the existing replacement behavior.
- UI displays per-file outcomes and successful byte counts. No recursive directory transfer or resume was added.

## Files

Owned implementation: `src/main/ssh.ts`, `src/main/ssh-tools.ts`, new `src/main/ssh-batch.ts`, `src/renderer/src/components/SshPanel.vue`, `TerminalPanel.vue`.

Minimal shared SSH patches: `src/shared/contracts.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/main/sessions.ts`.

Tests: new `tests/ssh-channels.test.ts`, `ssh-batch.test.ts`, `ssh-download.test.ts`, `ssh-session-lifecycle.test.ts`; extended `ssh-tools.test.ts` protocol integration case. Updated SSH test fixture listen error handling so EPERM rejects immediately rather than causing unhandled errors/timeouts.

## Verification evidence

- PTY feature: failing lifecycle/backpressure/channel-limit tests reproduced missing openTerminal; implemented code then passed 3/3. `pnpm typecheck` passed. Required `pnpm test` ran: 43 passed / 3 failed / 2 skipped; failures were existing SSH localhost listeners denied with `listen EPERM`.
- SFTP feature: local existing-file atomic protection and symlink tests failed against previous behavior, then passed with the implementation. Batch selection/partial-error/duplicate/native picker tests passed.
- Focused nonnetwork SSH tests pass (four files, 13 tests after lifecycle review fixes).
- `pnpm check:ui` passed.
- Review follow-up reproduced delayed-close quota and stale default PTY backpressure with failing regression tests. closeTerminal now removes the channel before requesting stream close; renderer ack(0) resets stale credit on remount. SshPanel unmount releases child channels, including channels whose asynchronous opens complete after disposal. The default PTY survives retry or is recreated on the same authenticated client when previously closed: `sshTerminalOpen(sessionId, 'default')` idempotently ensures it exists, sharing a pending creation promise across concurrent callers. SshPanel ensures it exists before rendering. A regression covers recreation after closing the original default and reuse without duplicates.
- Final shared `pnpm typecheck` passed after root SQL work settled.
- Required `pnpm typecheck` and `pnpm test` ran after batch UI. At that point shared root SQL work was in progress: typecheck reported ResultTable typing / not-yet-created sql-format module, and full test reported that missing module plus four explicit SSH listener EPERM failures. These unrelated transient SQL errors require root final rerun.
- Real SSH protocol integration tests are retained and include split lifecycle plus mixed-result batches, but cannot execute under this sandbox's localhost listener restriction. No escalation was attempted.

## Remaining verification limitations

Real terminal split interaction, native multiselect dialog and remote SFTP batch end-to-end need a desktop run in an environment that permits loopback listeners. Batch no-overwrite hard-link publication relies on the chosen local filesystem supporting hard links; unsupported filesystems produce a per-file failure without replacing existing files.
