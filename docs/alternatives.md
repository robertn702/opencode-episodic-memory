# Alternatives — and why this plugin exists

A survey of the OpenCode memory-plugin landscape, what each option actually
does, and where `opencode-episodic-memory` fits. Surveyed 2026-07-22 — feature
claims reflect each project's README at that date.

## "Memory" means three different things

The plugins in this space look interchangeable from their READMEs but solve
different problems. It helps to split them into three layers:

1. **Curated memory** — extracted facts, preferences, and project knowledge
   ("user prefers terse diffs", "project uses microservices"). Small, lossy,
   high-signal. Examples: opencode-mem, opencode-supermemory,
   opencode-claude-memory, opencode-agent-memory.
2. **Activity log** — LLM-written summaries of what happened in each session
   ("fixed the token refresh bug in auth.ts"). Examples: codemem, memsearch,
   open-mem, opencode-mem's timeline.
3. **Episodic recall** — semantic search over the *actual past conversations*,
   verbatim, with the full transcript one hop away. This plugin; the design
   is ported from obra/episodic-memory, which is Claude Code/Codex-only (it
   syncs JSONL file trees and can't read OpenCode's SQLite session store; it
   also indexes with sqlite-vec, which can't load in OpenCode's Bun plugin
   runtime).

Most layer-1/2 plugins put an LLM in the indexing path: every session (or
every turn) is summarized by a model, which costs quota/latency and loses
whatever the summarizer judged unimportant. (Exceptions exist — true-mem and
opencode-lcm extract/summarize deterministically — but they pay for it with
regex-pattern extraction quality or keyword-only search.) Layer 3 indexes
what was actually said, so recall is only limited by embedding quality — and
costs zero LLM calls.

This plugin is deliberately layer 3 only. It complements layer-1/2 plugins
rather than competing with them (see "Running side by side" below).

## Comparison table

"LLM at index time" = needs a model call to build memory (quota cost per
session/turn).

| Plugin | Layer | Storage / search | LLM at index time | Auto-injects context | External deps |
|---|---|---|---|---|---|
| **opencode-episodic-memory** (this) | Episodic | SQLite, brute-force cosine over Transformers.js embeddings | **No** | No (agent calls tools on demand) | None beyond npm (~100 MB model download once) |
| [tickernelz/opencode-mem](https://github.com/tickernelz/opencode-mem) | Curated + activity | SQLite + USearch (ExactScan fallback) | Yes (auto-capture summarizes sessions via your provider) | Yes (chat.message hook) | Web UI on :4747 |
| [kunickiaj/codemem](https://github.com/kunickiaj/codemem)¹ | Activity + curated | SQLite FTS5 BM25 + sqlite-vec, merged/reranked | Yes (observer pipeline writes typed memories) | Yes (every prompt, via chat transform) | Node 24+, web viewer, optional P2P sync; also Claude Code/Codex |
| [zilliztech/memsearch](https://github.com/zilliztech/memsearch) | Activity | Milvus Lite, hybrid BM25 + dense (bge-m3 ONNX) | Yes (summarizes every turn to daily .md) | Yes (cold-start injection) | Python (`uv`/`pip`), shells out to bash/python3; multi-agent |
| [supermemoryai/opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory) | Curated | **Cloud SaaS** (Supermemory API) | Yes (their service) | Yes | Memories leave your machine; API key |
| [kuitos/opencode-claude-memory](https://github.com/kuitos/opencode-claude-memory) | Curated | Markdown files in Claude Code's format/paths | Yes (post-session extraction + "auto-dream" consolidation) | Yes (system prompt) | Shell-hook wrapper around `opencode`, python3 |
| [joshuadavidthomas/opencode-agent-memory](https://github.com/joshuadavidthomas/opencode-agent-memory) | Curated | Markdown memory blocks (Letta-inspired), agent self-edits; opt-in journal with local MiniLM semantic search (agent-written entries, not transcripts) | Via agent tools | Yes | None notable |
| [rizal72/true-mem](https://github.com/rizal72/true-mem) | Curated | Cognitive-psychology model (decay, consolidation) | No (deterministic regex/pattern extraction) | Yes | — |
| [psinetron/echoes-vault-opencode](https://github.com/psinetron/echoes-vault-opencode) | Curated | Obsidian-style markdown knowledge base | Yes | No (slash-command workflow: `/echoes-start`) | — |
| [Plutarch01/opencode-lcm](https://github.com/Plutarch01/opencode-lcm) | Activity (verbatim archive) | SQLite FTS5 + TF-IDF (keyword, not semantic) | No (deterministic summary nodes) | Yes | — |

(Smaller/newer entries not surveyed in depth: clopca/open-mem,
chriswritescode-dev/opencode-memory, lucasliet/opencode-mem,
cnicolov/opencode-plugin-simple-memory — spot-checked: all embed
LLM-compressed observations or agent-written memories, none embed verbatim
transcripts. Nearest non-plugin relative: `opencode-semantic-memory` on PyPI
embeds session content as-is by default, but it's a Python MCP server with
three background daemons, not an OpenCode plugin.)

¹ **Naming collision:** kunickiaj's project was *itself* originally published
as `opencode-mem` (Python, `uv`-installed) and later renamed to codemem — it
is unrelated to tickernelz/opencode-mem despite the shared former name. Its
README's "migrating from opencode-mem" notes refer to its own old identity.

## Why this exists alongside opencode-mem

opencode-mem is the most mature OpenCode memory plugin. Reasons it didn't
fit, which generalize to most of the layer-1/2 field:

- **Summarization burns quota.** Auto-capture makes a background LLM call per
  session (opencode-mem), per turn (memsearch), or via an observer pipeline
  (codemem), which consumes paid-plan quota quickly. This plugin's index is
  built entirely locally: Transformers.js embeddings on CPU, no API key,
  works offline.
- **Summaries are lossy in the wrong direction for recall.** When you ask
  "how did we handle X?", the answer is often in phrasing the summarizer
  dropped. Indexing condensed-but-verbatim exchanges keeps the evidence;
  `episodic_read` then pulls the full transcript from OpenCode's own DB.
- **No always-on surface.** opencode-mem runs a web UI server; codemem runs a
  viewer and sync daemon; memsearch shells out to Python; supermemory sends
  memories to a cloud API. This plugin is a single plugin file + one SQLite
  file, with no servers, daemons, shell hooks, or network calls after the
  one-time model download.
- **No per-prompt token tax.** Most alternatives auto-inject memory context
  into prompts (that's their main UX). That costs tokens on every prompt
  whether or not history is relevant, and can inject stale or wrong "facts".
  Here the agent decides when to search, guided by the
  `remembering-conversations` skill — recall is pull, not push.
- **No native-module risk in the plugin runtime.** OpenCode plugins run in
  Bun, and `bun:sqlite` cannot load dynamic extensions, so sqlite-vec is off
  the table inside a plugin. Rather than fight that (USearch native bindings,
  external Milvus, Node-only CLI shims), brute-force cosine over Float32
  blobs is single-digit milliseconds at realistic scale (thousands of
  chunks). `src/store.ts` is the documented swap point if an ANN index is
  ever needed.
- **Search quality is measured, not assumed.** The embedding model
  (Snowflake arctic-embed-m-v1.5, CLS pooling, query prefix) was chosen by an
  empirical eval on a real corpus — see
  [embedding-model-eval.md](embedding-model-eval.md). Crucially, negatives
  score ≤ ~0.33 vs ~0.4+ true hits, so score thresholding actually works.

## Honest trade-offs

What you give up choosing this over the alternatives:

- **No automatic context injection.** If the agent doesn't think to search,
  nothing is recalled. The skill mitigates this; auto-injection is a
  deliberate non-goal (see above).
- **No curated facts/user profile.** This won't answer "what's my preferred
  commit style?" from a distilled fact — it finds the conversation where you
  said it. For profile-style memory, a layer-1 plugin is the right tool.
- **OpenCode only.** codemem and memsearch span Claude Code/Codex too;
  supermemory is agent-agnostic.
- **Brute-force search scale.** Fine to tens of thousands of chunks; would
  need the ANN swap point beyond that.

## Running side by side

The layers compose. A reasonable setup is opencode-mem (or another layer-1
plugin) for curated facts and user profile, plus this plugin for verbatim
episodic recall — they use separate storage and don't conflict.

## Privacy note on third-party plugins

Every plugin above runs with full tool/filesystem access inside your
sessions. Two of them (supermemory, and opencode-mem if you point it at a
cloud embedding/LLM endpoint) send conversation-derived data off-machine by
design (supermemory's `baseUrl` can target a self-hosted instance, but the
hosted API is the default). This plugin never sends conversation content anywhere: read-only
access to OpenCode's DB, local embeddings, local index. The
`DO NOT INDEX THIS CHAT` marker excludes sensitive sessions from the index
entirely.
