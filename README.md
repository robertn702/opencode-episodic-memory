# opencode-episodic-memory

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
3. **Embed** — local, offline embeddings via Transformers.js (`Snowflake/snowflake-arctic-embed-m-v1.5` q8, 768 dims; retrieval prefix on search queries). Chosen by empirical eval on a real corpus — see [docs/embedding-model-eval.md](docs/embedding-model-eval.md)
4. **Index** — plain SQLite at `~/.local/share/opencode-episodic-memory/index.db`; brute-force cosine over Float32 blobs
5. **Recall** — native plugin tools `episodic_search` / `episodic_read`, plus a `remembering-conversations` skill that teaches the agent when to search
6. **Stay fresh** — the plugin re-indexes each session on the `session.idle` event

Design note: `bun:sqlite` cannot load dynamic extensions, so sqlite-vec is not
usable inside OpenCode plugins. Brute-force cosine is single-digit milliseconds
at this scale (thousands of chunks) and has zero native-dependency risk. The
store layer is the single swap point if a real ANN index is ever needed.

## Install

```bash
bun install   # first embed downloads the model (~100 MB, cached afterwards)
```

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["/path/to/opencode-episodic-memory/plugin/episodic-memory.ts"]
}
```

Or from npm — pin the version. OpenCode caches npm plugins and never
re-resolves a bare name / `@latest`
([anomalyco/opencode#25293](https://github.com/anomalyco/opencode/issues/25293)),
so to update later you bump the pin:

```jsonc
{
  "plugin": ["opencode-episodic-memory@0.1.1"]
}
```

Copy the skill so the agent knows when to search:

```bash
cp -r skills/remembering-conversations ~/.config/opencode/skills/
```

Then backfill existing history and restart OpenCode:

```bash
bun run src/cli.ts sync
```

## CLI

```bash
bun run src/cli.ts sync [--force]          # index new/changed sessions
bun run src/cli.ts search "query"          # semantic search
bun run src/cli.ts search q --text "exact" # require substring
bun run src/cli.ts search q --after 2026-07-01 --limit 5
bun run src/cli.ts read <session-id>       # full transcript (live store)
bun run src/cli.ts read <id> --indexed     # indexed excerpts (survives deletion)
bun run src/cli.ts stats                   # index statistics
bun run src/cli.ts doctor                  # diagnose setup
```

`--after`/`--before` take `YYYY-MM-DD` (midnight UTC). `--after D` is inclusive
of day D; `--before D` is exclusive of day D (i.e. up to the start of that day).

## Agent tools

- **`episodic_search`** — `query` (+ optional `text`, `mode: vector|text`, `after`, `before`, `limit`). Returns dated excerpts with session IDs and similarity scores.
- **`episodic_read`** — `session_id` (+ optional `indexed`). Full transcript from the live store, falling back to indexed excerpts.

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
| `EPISODIC_EMBED_MODEL` | `Snowflake/snowflake-arctic-embed-m-v1.5` | Transformers.js embedding model |

## Not yet implemented (deliberate)

- LLM-generated per-session summaries embedded instead of raw exchange text
  (upstream does this; deferred until search quality data says it's needed —
  would use OpenCode provider auth via `client.session.prompt`)
- Multi-concept AND search, MCP server wrapper for non-OpenCode clients
- ANN index (see design note above)

## License

MIT
