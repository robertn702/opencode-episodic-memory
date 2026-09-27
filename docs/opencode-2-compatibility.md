# OpenCode v1 and v2 compatibility

The package supports the v1 `session` / `message` / `part` layout and the
[v2.0.18 schema](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/core/src/session/sql.ts)
(`session_v2` / `session_message`). The v2 reader normalizes nullable titles,
user `data.text`, assistant `data.content[]` text and tool names to the same
parser contract as v1. Unknown or partial layouts fail before sync/pruning.
When both table families exist during migration, v2 is authoritative for
each copied session; unconverted sessions continue reading v1 and stay in the
pruning set. The exclusion marker is scanned in raw v2 message data **and**
retained v1 message/part data, including malformed JSON. Full transcript reads
and seq-ordered bounded windows pin privacy checks and reads to one snapshot.

The [upstream migration](https://github.com/anomalyco/opencode/blob/v2.0.18/packages/core/src/database/v1-migration.bun.ts)
can retain v1 tables and preserve session IDs/timestamps. Indexed session
status therefore records the layout (`indexed-v2`, `empty-v2`, `excluded-v2`);
the first sync after a layout switch reprocesses even unchanged timestamps.
Deleted sessions are pruned only after source layout validation. Run
`bun run src/cli.ts sync` to backfill, or rely on per-session idle reindexing;
`doctor` reports the detected layout. V1 reads and existing v1 statuses remain
compatible.

OpenCode v1.18.32 and v2.0.18 both prioritize `exports["./server"]`. The
shared server entry exposes v1 `server()` and v2 `setup()`; older v1 hosts can
use the v1 function `main`. The root export remains v1; explicit `./v1` and
`./v2` subpaths are available. These
entrypoints share three tool implementations and the same index. The v1 path
keeps `@opencode-ai/plugin` compatibility with earlier 1.x installations;
entrypoint checks exercise the tagged 1.18.4/1.18.28/1.18.32 and 2.0.18
resolver contracts, not every historical host. Minimum verified v1 loader:
1.18.4.

The index contains condensed text and tool names, not tool arguments or output.
Search results preserve dates and anchors; later decisions do not automatically
invalidate older ones. Live transcript tools expose more context when available,
subject to the raw exclusion-marker gate; foreign-source indexed excerpts may
be stale.
