# OpenCode v2 source compatibility

This package requires OpenCode v2. The reader uses `session_v2` and
`session_message` only. It validates their required columns before syncing or
pruning, normalizes nullable session titles, and reads user `data.text` plus
assistant `data.content[]` text and tool names. Malformed JSON degrades per
message; malformed structural rows fail loudly.

The [upstream migration](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/core/src/database/v1-migration.bun.ts)
copies old sessions into the v2 tables while preserving IDs and timestamps.
OpenCode may retain the old tables, but this package never reads them. Finish
OpenCode's migration before using this version. On the first sync, index rows
with older unqualified statuses are reprocessed as `indexed-v2`, `empty-v2`, or
`excluded-v2`, even when their source timestamp has not changed. Deleted
sessions are pruned only after v2 layout validation.

The privacy gate checks the exact marker substring across raw
`session_message.data` for the entire session before reading a transcript or
bounded window. This catches markers inside malformed JSON and unmodeled
nested fields. Both the marker check and transcript read use one SQLite
snapshot.

The package's root and `./server` exports resolve to the same v2
`Plugin.define` entrypoint. OpenCode v1 plugin APIs and source layouts are no
longer supported.
