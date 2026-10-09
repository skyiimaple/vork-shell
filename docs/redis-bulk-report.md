# Redis bulk TTL report

Implemented the approved Redis bulk TTL operations through the existing RedisBrowser request adapter and SessionManager serialized queue.

## Behavior

- `ttl-batch`: reads TTL independently for 1–100 selected UTF-8 keys. Persistent keys report -1, absent keys -2, expiring keys their seconds. One key error does not hide other outcomes.
- `expire-batch` with explicit `operation: expire` and positive safe-integer seconds, or `operation: persist`: modifies each key independently and reports affected 1, affected 0, or an error. No automatic retries or rollback of earlier successful writes.
- Validation occurs before SELECT or any per-key command: count, duplicate names, UTF-8 losslessness, 16 KiB per-key limit, a 3 MiB JSON name budget, explicit operation, and safe positive TTL. Empty Redis names are preserved. Error messages are bounded to protect the 4 MiB result limit.
- Database switching remains the existing SELECT at the beginning of each serialized request. No new sockets, IPC channel or session queue was introduced.
- Redis browser key rows have shadcn checkboxes; a loaded-key selection control chooses the first 100 keys. Toolbar supports read TTL, set TTL, persist and clear selection.
- Both bulk modifications use a shadcn AlertDialog containing captured database, all selected keys and expiry seconds where applicable. The confirm operation retains its immutable key/database snapshot. Selection/results/dialog clear on database, pattern or type-filter changes; stale asynchronous results are discarded using a selection revision.
- Per-key results distinguish changed/no-change/failure and missing/persistent TTL values. Completed modifications refresh existing key/detail/server queries.

## Files

- New `src/main/redis-bulk.ts`
- Modified `src/main/redis-browser.ts`
- Redis-only additions in shared `src/shared/contracts.ts`
- Modified `src/renderer/src/components/RedisPanel.vue`
- New `tests/redis-bulk.test.ts`
- Added optional real-server bulk assertions in `tests/redis.integration.test.ts`

## Verification

- Test-first Redis bulk read/mutation tests failed with unsupported operation before implementation; after implementation the browser and bulk suites pass 11 tests. They run the actual RedisBrowser handler against a stateful injected command transport and verify isolated database mutation, partial errors, missing/permanent/empty keys, validation and no state changes for invalid requests.
- `pnpm typecheck` passed after the feature and subsequent SSH review fixes.
- `pnpm check:ui` passed.
- Combined focused SSH/Redis nonnetwork suites pass 24 tests across six files.
- Required full `pnpm test` after the feature: 62 passed, four SSH integration tests failed with explicit `listen EPERM: operation not permitted 127.0.0.1`, and two optional real-server tests were skipped. Final rerun after review fixes: 67 passed, four SSH EPERM failures, two optional integration skips. Root final verification may change this count as parallel work settles.
- Redis real-server test is opt-in through VORK_REDIS_SERVER; no executable path was provided. The added integration assertions remain available for an unrestricted real-server run. No permission escalation was attempted.

## SSH review follow-up

The lifecycle review reproduced two issues with failing nonnetwork regression tests: closed channels retained the four-PTY quota until the remote close event, and remounting the default terminal retained stale in-flight backpressure. closeTerminal now removes the PTY synchronously before closing it. ack(0) acts as renderer attach/reset and discards old render credit. SshPanel unmount closes each child PTY while keeping the default; pending terminal opens check disposal and close their returned channel instead of leaking it. The default-already-closed retry case now recreates default idempotently via optional preferred default on sshTerminalOpen; the focused SSH suites now pass 13 tests.
