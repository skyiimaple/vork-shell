# Enhancement review — 2026-10-06

Scope: approved MVP enhancement specification; SSH split/SFTP batches and shared app, profile, window, shortcut, result-table, formatter and query-history changes. SQLite import/dump and Redis bulk work excluded because they were being implemented during this review. No source changes or commits made by the reviewer.

## Remaining findings

### P1 — Preserve PostgreSQL newline-separated literal concatenation

Location: `src/renderer/src/lib/sql-format.ts:5`, `:49-50`.

The formatter discards original whitespace and emits a space between nonadjacent tokens. PostgreSQL permits adjacent string constants to concatenate only when the separating whitespace includes a newline. Valid input `select 'a'\n'b'` becomes `select 'a' 'b'`, which has different parsing behavior and cannot safely replace the original SQL. Preserving each literal's contents does not preserve this separator-dependent syntax. Retain a newline for consecutive PostgreSQL string-literal tokens whose original separator contains one, or conservatively retain separators unless their equivalence is established. Add a regression covering this form (including prefixed string constants where supported).

### P2 — Error-boundary retry orphans independent SSH channels

Location: `src/renderer/src/components/SshPanel.vue:19`, `:24`, `:38`; `src/renderer/src/components/PanelErrorBoundary.vue:11`.

On an SSH descendant error, the boundary removes the panel subtree. Retrying creates a new SshPanel with `terminalIds = ['default']`, but unmount only removes an event subscription. Existing split PTYs remain open in the main process, lose their UI and acknowledgement consumer, and still count against the four-channel limit. If the default pane had already been closed, retry renders an ID that no longer exists and displays an unusable terminal. An in-flight split resolving after unmount can similarly create an orphan. Keep session/channel ownership in state that survives the boundary, or explicitly close and recreate the channels during recovery; handle a pending open resolving after disposal. Validate retry after opening four PTYs and after closing the default pane.

## Findings addressed during review

- Initial historical restore was lost for a newly connected session because QueryPanel observed `prepared` without an immediate watch and initialized only its default SQL. Latest source includes `{ immediate: true }` at QueryPanel.vue:18.
- Token spacing broke valid SQLite `0x10`, `1_000`, named parameters and PostgreSQL `$1`. Direct SQLite execution demonstrated `select 0x10 as x` returned 16 while the prior formatted form raised a syntax error. Latest source stores token offsets and preserves originally adjacent tokens, addressing these examples. The remaining PostgreSQL newline case above still needs handling.

## Verification evidence

- Focused test command over sql-format, result-table, history, profiles, shortcuts, window-state, notifications, ssh-channels, ssh-session-lifecycle, ssh-batch and ssh-download: **11 files / 20 tests passed**.
- Direct Vue/TanStack runtime check: reactive data/column replacement works; header toggle cycles unsorted → ascending → descending → unsorted. No defect found in the table integration.
- `pnpm typecheck` at review time failed solely because `tests/sqlite-tools.test.ts` imported the not-yet-created `src/main/sqlite-tools`; that excluded feature was in progress. A final full typecheck is required after all parallel work settles.
- Real SSH protocol/native-dialog interaction was not rerun here; existing implementation report records sandbox loopback-listener restrictions. The review's focused SSH mock/filesystem tests passed.
