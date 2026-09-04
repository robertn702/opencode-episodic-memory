# opencode-episodic-memory

[![skills.sh](https://skills.sh/b/robertn702/opencode-episodic-memory)](https://skills.sh/robertn702/opencode-episodic-memory)

Semantic search over your past [OpenCode](https://opencode.ai) conversations.
Remember past discussions, decisions, and patterns across sessions.

Inspired by [obra/episodic-memory](https://github.com/obra/episodic-memory),
rebuilt for OpenCode primitives — native plugin tools instead of an MCP server,
plugin events instead of hooks, and OpenCode's own session database as the
source.

Wondering how this compares to opencode-mem, codemem, memsearch, and the rest
of the OpenCode memory-plugin landscape? See
[docs/alternatives.md](docs/alternatives.md).

## How it works

1. **Read** — sessions/messages/parts from OpenCode's `~/.local/share/opencode/opencode.db` (read-only)
2. **Parse** — condensed exchanges (user text, assistant text, tool names; no reasoning blobs or tool output)
3. **Embed** — local, offline embeddings via Transformers.js in a persistent system-Node sidecar (`Snowflake/snowflake-arctic-embed-m-v1.5` q8, 768 dims; retrieval prefix on search queries). Chosen by empirical eval on a real corpus — see [docs/embedding-model-eval.md](docs/embedding-model-eval.md)
4. **Index** — plain SQLite at `~/.local/share/opencode-episodic-memory/index.db` by default; optional libSQL/Turso remote storage can combine source-scoped indexes across devices
5. **Recall** — native plugin tools `episodic_search` / `episodic_read_window` / `episodic_read_session`, plus a `remembering-conversations` skill that teaches the agent when to search
6. **Stay fresh** — the plugin re-indexes each session on the `session.idle` event

Design note: `bun:sqlite` cannot load dynamic extensions, so sqlite-vec is not
usable inside OpenCode plugins. Brute-force cosine is single-digit milliseconds
at this scale (thousands of chunks) and has zero native-dependency risk. The
store layer is the single swap point if a real ANN index is ever needed. FTS5 is
compiled into `bun:sqlite` (not a loadable extension), so lexical BM25 ranking
is available; search is vector-only by default, with lexical and hybrid
(reciprocal-rank-fusion) modes opt-in — hybrid is off by default because BM25
tends to match injected boilerplate on this corpus.

## Install

```bash
opencode plugin opencode-episodic-memory@0.3.0 -g
```

This adds the plugin to your OpenCode config (`-g` = global config; omit it
to install for the current project only). **Pin the version** — OpenCode
caches npm plugins and never re-resolves a bare name / `@latest`
([anomalyco/opencode#25293](https://github.com/anomalyco/opencode/issues/25293)).
To update later, re-run with the new version and `--force`.

Or edit `~/.config/opencode/opencode.json` manually:

```jsonc
{
  "plugin": ["opencode-episodic-memory@0.3.0"]
}
```

Default sidecar-mode semantic indexing and vector/hybrid search require a system
**Node 20+** binary (`node` by default). The first embedding run downloads the
model (~100 MB, cached afterward). The model and its native runtime live in
that Node sidecar, not inside OpenCode's Bun/TUI process. Explicit
`EPISODIC_EMBED_MODE=inline` works without Node but is unsafe in affected
OpenCode/Bun versions. `episodic_read_window`, `episodic_read_session`, and lexical text search also remain
available without Node.

Install the skill so the agent knows when to search, via the
[`skills` CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add robertn702/opencode-episodic-memory -g
```

(`-g` installs to `~/.config/opencode/skills/`; omit it to install into the
current project. `npx skills update` picks up future skill changes.)

Alternatively, copy it manually — it's included in the npm package; once
OpenCode has downloaded the plugin (i.e. after first launch), copy it out of
the package cache (the path contains your pinned version):

```bash
cp -r ~/.cache/opencode/packages/opencode-episodic-memory@0.3.0/node_modules/opencode-episodic-memory/skills/remembering-conversations ~/.config/opencode/skills/
```

Then backfill existing history and restart OpenCode:

```bash
bunx opencode-episodic-memory@0.3.0 sync
```

## CLI

The package ships an `opencode-episodic` binary (requires `bun` on PATH).
Invoke it through the package spec — pin it to match your plugin version:

```bash
bunx opencode-episodic-memory@0.3.0 sync [--force]          # index new/changed sessions
bunx opencode-episodic-memory@0.3.0 search "query"          # semantic (vector) search
bunx opencode-episodic-memory@0.3.0 search q --text "terms"  # lexical BM25 (all terms AND-matched, token-based)
bunx opencode-episodic-memory@0.3.0 search q --hybrid       # fuse vector + BM25 (RRF; opt-in)
bunx opencode-episodic-memory@0.3.0 search q --after 2026-07-01 --limit 5
bunx opencode-episodic-memory@0.3.0 read <session-id>       # full transcript (live store)
bunx opencode-episodic-memory@0.3.0 read <id> --indexed     # local indexed excerpts
bun run src/cli.ts read <id> --indexed --source laptop     # remote indexed excerpts (development/source checkout)
bunx opencode-episodic-memory@0.3.0 stats                   # index statistics
bunx opencode-episodic-memory@0.3.0 doctor                  # diagnose setup
```

`--after`/`--before` take `YYYY-MM-DD` (midnight UTC). `--after D` is inclusive
of day D; `--before D` is exclusive of day D (i.e. up to the start of that day).

## Agent tools

- **`episodic_search`** — `query` (+ optional `text`, `mode: vector|text|hybrid`, `after`, `before`, `limit`). `vector` (default) is semantic; `text` is lexical BM25; `hybrid` fuses both via RRF (opt-in — can surface lexical noise). Returns dated excerpts with session IDs, scores, and message anchors. Legacy results without an anchor require a normal sync before bounded window reads.
- **`episodic_read_window`** — `session_id`, `anchor_message_id` (+ optional `source_id`, required in remote mode; `before`, `after`, each 0-20, default 3). Reads a bounded chronological window from the privacy-gated live source transcript. Deleted, private, stale, or legacy-anchored sessions cannot provide a window.
- **`episodic_read_session`** — `session_id` (+ optional `source_id`, required in remote mode; `indexed`). Reads the full session transcript from the live store, falling back to indexed excerpts. Prefer `episodic_search` -> `episodic_read_window` -> `episodic_read_session`, stopping once enough context has been recovered.

## Excluding conversations

Any conversation containing this marker is archived nowhere and indexed nowhere:

```
DO NOT INDEX THIS CHAT
```

Note: the marker is matched as a bare substring anywhere in any message part, so
this also excludes conversations that merely *quote* the phrase (such as
discussions about this tool itself). This is broader than upstream's full
instruction-tag match — the intent is the same, but our matching is literal.

## Configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `EPISODIC_SOURCE_DB` | `~/.local/share/opencode/opencode.db` | OpenCode session store |
| `EPISODIC_INDEX_DB` | `~/.local/share/opencode-episodic-memory/index.db` | Index location |
| `EPISODIC_INDEX_URL` | unset | Opt-in libSQL/Turso index URL; activates remote vector-only mode |
| `EPISODIC_INDEX_AUTH_TOKEN` | unset | Required for remote network URLs; passed to `@libsql/client` |
| `EPISODIC_SOURCE_ID` | unset | Required in remote mode; stable device/source identity |
| `EPISODIC_EMBED_MODEL` | `Snowflake/snowflake-arctic-embed-m-v1.5` | Transformers.js embedding model |
| `EPISODIC_EMBED_MODE` | `sidecar` | `sidecar` runs embeddings in Node; `inline` is an explicit escape hatch |
| `EPISODIC_NODE_BINARY` | `node` | Node 20+ executable used by sidecar mode |
| `EPISODIC_EMBED_BATCH_SIZE` | `32` | Texts per sidecar request (1-64) |
| `EPISODIC_EMBED_READY_TIMEOUT_MS` | `600000` | Maximum wait for sidecar/model startup |
| `EPISODIC_EMBED_REQUEST_TIMEOUT_MS` | `120000` | Maximum wait for a post-startup embedding request |

`EPISODIC_EMBED_MODE=inline` loads Transformers.js native addons directly in
OpenCode's embedded Bun process. It exists only as an explicit compatibility
escape hatch and is unsafe with affected OpenCode/Bun releases that can crash
during native-addon teardown. It is never selected automatically if sidecar
startup fails. Run `bun run src/cli.ts doctor` to diagnose the selected mode,
Node version, and a real embedding.

### Optional shared remote index

Set all three variables on each device (use a distinct, stable source ID per
device):

```bash
export EPISODIC_INDEX_URL='libsql://your-index.turso.io'
export EPISODIC_INDEX_AUTH_TOKEN='...'
export EPISODIC_SOURCE_ID='laptop'
```

This is an explicit privacy boundary: sync still reads OpenCode locally and
generates embeddings locally, but it **uploads condensed chunk text, session
metadata, anchors, and embedding vectors** to the configured database. Do not
configure it unless that database is appropriate for this conversation data.
Sessions containing `DO NOT INDEX THIS CHAT` upload neither content nor a
metadata tombstone; an existing row for that source/session is removed.
Absolute local `file:` libSQL URLs are supported without a token for hermetic
testing; network
URLs must use `https:`, `wss:`, or TLS-enabled `libsql:` and require a token
supplied only through `EPISODIC_INDEX_AUTH_TOKEN` (not embedded in the URL).
For `libsql:`, omit `tls` or use exactly one lowercase `tls=1` parameter.
The remote schema is freshly created or validates/adopts a compatible existing
schema and does not use FTS, so remote mode supports vector search only. `--text`,
`--hybrid`, and plugin `text`/`hybrid` modes fail clearly in remote mode.
Remote cosine search reads embedding candidates in bounded pages and hydrates
only the final result set.

Remote search includes the source ID in each hit. Bounded live reads are only
valid for the current source; another device's hits remain available as indexed
excerpts through `episodic_read_session` with that hit's `source_id`.

Network failures are surfaced by the CLI and doctor; plugin background reindex
logs failures and never silently falls back to a local index (which would split
history). To return to local-only mode, unset `EPISODIC_INDEX_URL`,
`EPISODIC_INDEX_AUTH_TOKEN`, and `EPISODIC_SOURCE_ID`; the existing local index
is selected unchanged. Re-run `sync` if the local index needs rebuilding.

## Not yet implemented (deliberate)

- LLM-generated per-session summaries embedded instead of raw exchange text
  (upstream does this; deferred until search quality data says it's needed —
  would use OpenCode provider auth via `client.session.prompt`)
- Multi-concept AND search, MCP server wrapper for non-OpenCode clients
- ANN index (see design note above)

## Development

To hack on the plugin itself, clone the repo and point OpenCode at the local
entrypoint instead of the npm package:

```bash
git clone https://github.com/robertn702/opencode-episodic-memory.git
cd opencode-episodic-memory
bun install
```

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["/path/to/opencode-episodic-memory/plugin/episodic-memory.ts"]
}
```

Inside the repo, run the CLI as `bun run src/cli.ts <command>` (same
subcommands as above), tests with `bun test`, and typechecking with
`bun run typecheck`.

## License

MIT
