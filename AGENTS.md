# opencode-episodic-memory — agent context

Inspired by obra/episodic-memory.
Semantic search over past OpenCode conversations via native plugin tools.

## Layout

- `src/reader.ts` — read-only access to `~/.local/share/opencode/opencode.db`
  (session/message/part tables, JSON blobs in `data`; schema verified 2026-07-22)
- `src/parser.ts` — transcript → condensed exchanges; exclusion marker handling
- `src/embed.ts` — Transformers.js singleton, CLS-pooled normalized embeddings
- `src/store.ts` — index SQLite DB; brute-force cosine vector search (**the**
  swap point if an ANN index is ever needed) + FTS5 BM25 lexical search, fused
  on demand via reciprocal rank fusion. Two-phase: score candidates on
  embeddings/BM25 only, hydrate text/title/directory for the top-K winners.
- `src/indexer.ts` — incremental sync, watermark = `session.time_updated`
- `src/cli.ts` — `bun run src/cli.ts sync|search|read|stats|doctor`
- `plugin/episodic-memory.ts` — OpenCode plugin (tools + `session.idle` reindex)
- `skills/remembering-conversations/SKILL.md` — recall-behavior skill
- `docs/embedding-model-eval.md` — model survey + empirical eval behind the
  snowflake choice
- `docs/alternatives.md` — comparison with other OpenCode memory plugins
  (opencode-mem, codemem, memsearch, ...) and why this one exists
- `eval/` — reusable model-comparison harness; private inputs/outputs
  (`queries.ts`, `corpus.json`, `results-*`) live in `eval/private/`, which is
  gitignored wholesale — drop any new private artifact there, no gitignore
  edit needed; see its README
- Tests: `bun test` (parser + store smoke tests); `bun run typecheck`
- `spikes/` — Phase 0 verification + plugin harness (run with `bun run`)

## Hard-won facts (don't rediscover)

- Embedding model is **`Snowflake/snowflake-arctic-embed-m-v1.5` (q8, CLS pooling)**
  with the BGE-style query prefix on queries only (Snowflake uses the identical
  prompt). Chosen by empirical eval on our real corpus over bge-small-en-v1.5, nomic
  v1.5, gte-modernbert, granite-r2, embeddinggemma — see
  `docs/embedding-model-eval.md`. Key win: negatives score ≤ ~0.33 vs bge's ~0.66,
  so minScore thresholding is viable. Score scale: true hits ~0.4–0.73, median ~0.56.
  Pooling MUST be `cls` for this model, not `mean`. Xenova mirrors of nomic/snowflake
  401 now — use official repos' own ONNX exports.
- Truncate embedded text at 2000 chars (upstream measured quality peaks there);
  the stored chunk text may be longer for display, embed.ts truncates.
- Sync (CLI `sync` and the plugin's per-session `session.idle` reindex alike)
  prunes index sessions that no longer exist in the source DB (deleted
  conversations would otherwise linger with stale-model embeddings), and search
  skips embedding rows whose byteLength ≠ dims×4 — a mixed-model index can never
  crash or corrupt search. Both bugs were found during the bge→snowflake
  migration (12 orphaned 384-dim chunks crashed a 768-dim query).
- **`bun:sqlite` does not support dynamic extension loading** — sqlite-vec cannot
  work inside OpenCode plugins. Hence brute-force cosine over Float32 blobs.
  FTS5, by contrast, is **compiled into** bun:sqlite (a static module, not a
  loadable extension — verified in `spikes/fts5-check.ts`), so lexical BM25
  search IS available. The FTS index (`chunks_fts`) is an external-content
  FTS5 table over `chunks.text`, kept in sync by triggers on `chunks` (robust
  to any write path, not just replaceSessionChunks) and backfilled once for
  pre-FTS index DBs via a `PRAGMA user_version`-gated `'rebuild'` (COUNT(\*) on
  an external-content FTS returns the content count, so it can't detect an
  un-backfilled index — user_version is the reliable signal).
- **Hybrid (vector+BM25 RRF) search is opt-in, NOT the default.** search()
  defaults to pure vector; pass `hybrid: true` + `queryText` (CLI `--hybrid`,
  plugin `mode: "hybrid"`) to fuse. Empirically on this corpus BM25 matches
  injected boilerplate (the `[MEMORY]` preamble, tool descriptions) and RRF then
  drags those noise hits above genuine semantic matches — e.g. "episodic memory
  architecture decisions" surfaced "TealHQ Cloudflare deployment" / "3-month
  financial projection" at the top. minScore is applied to the vector arm BEFORE
  fusion (its calibration is cosine, not BM25). `textSearch`/`mode:"text"` is
  pure BM25 (quoted-term MATCH to neutralize FTS operators; LIKE fallback only
  on an FTS syntax error).
- OpenCode sessions live in one SQLite DB (WAL mode; concurrent read-only access
  is safe), NOT JSONL transcripts like Claude Code.
- Runtime validation of `opencode.db` reads uses **Zod** (`src/reader.ts`), split
  by failure mode: **structural rows** (`listSessions`/`getSession`/`getTranscript`
  row envelopes — the id/time_created/data columns) **throw** via `.parse()`, so
  OpenCode schema drift surfaces loudly instead of being silently mis-read; the
  **JSON `data` blobs** (message role, part contents) **degrade per-row** to
  `"unknown"`/`undefined` via `.catch()`, so one corrupt or unfamiliar blob can't
  abort a whole transcript read (the parser already filters unknown types/roles).
  Because the internal `getTranscript` throws on structural drift and `syncAll`
  reads every session through `getTranscriptChecked` (which calls it), a
  structural drift aborts the whole bulk sync (all-or-nothing) —
  intentional fail-loud; the plugin's `session.idle` reindex catches and logs it.
  The index DB (`store.ts`) deliberately stays on `db.prepare<T>()` typed casts —
  we own that schema end to end, so runtime validation adds no value there. Keep
  the no-`as` rule: narrow via schemas, never assertions (the two documented
  `as Float32Array` casts in `embed.ts`/`eval` are the sanctioned transformers.js
  typing-gap exceptions).
- Plugin runs inside OpenCode's Bun runtime — no native deps, no postinstall
  assumptions. `onnxruntime-node` ships all platform binaries in its npm
  tarball, so the blocked postinstall under `bun install` is harmless for npm
  consumers. `trustedDependencies` in package.json only affects repo
  contributors.
- The `DO NOT INDEX THIS CHAT` exclusion marker is matched as a bare substring
  anywhere in any message part (broader than upstream's full instruction-tag
  match), so it also fires on conversations that merely quote the phrase —
  including conversations about building this tool. The AUTHORITATIVE check is
  `transcriptHasMarker()` in reader.ts, which substring-matches the RAW `data`
  column (`instr`, exact case) with no JSON parsing — the marker must not
  depend on blob parseability, since the blob pipeline degrades unparseable
  parts to `text: undefined`. All production reads go through
  **`getTranscriptChecked()`** (reader.ts), which runs that raw check BEFORE
  materializing anything and returns a discriminated
  `{ excluded: true } | { excluded: false; messages }` union — so indexing
  (indexer.ts), `episodic_read`, and CLI `read` cannot bypass the gate by
  forgetting a manual check. The raw `getTranscript` is module-internal (not
  exported); `transcriptHasMarker` stays exported as the authoritative
  primitive (directly tested in reader.test.ts). `hasExcludeMarker()` in
  parser.ts is a cheaper parsed-text fast path kept for parseTranscript's
  in-memory flow; EXCLUDE_MARKER lives in reader.ts and is re-exported by
  parser.ts.
- Plugin API: use `tool()` helper from `@opencode-ai/plugin` (official docs).
  different-ai/openwork's skills (`opencode-primitives`, `create-plugin`) show
  an older default-export/zod-shape style and one was removed upstream while
  skills.sh served a stale snapshot — don't vendor them; the official style is
  what's implemented here.

## Conventions

- Verify empirically before building (see `spikes/`); run
  `bun run spikes/plugin-harness.ts` after changing the plugin.
- When bumping `@huggingface/transformers`, capture baseline embeddings
  pre-bump and compare cosine post-bump before assuming existing indexes stay
  valid (v3↔v4 happened to be identical; don't assume that holds).
- Reindex manually with `bun run src/cli.ts sync` (idempotent; watermark-based).
- Releases follow `docs/RELEASE.md`; the artifact gate is
  `bash spikes/pack-smoke.sh` (pack → clean install → import → embed).
  OpenCode does NOT auto-update npm plugins: its cache
  (`~/.cache/opencode/packages/<spec>/`) short-circuits on any existing
  install, so a bare package name resolves `@latest` once and stays pinned
  forever (upstream bug anomalyco/opencode#25293). Dogfood configs must pin
  `"opencode-episodic-memory@X.Y.Z"` and bump the pin every release —
  restart alone never picks up a new publish.
- Config is env-var only (`EPISODIC_*`), no config file yet (YAGNI).
