# Embedding model eval & decision: snowflake-arctic-embed-m-v1.5

**Decision (2026-07-22):** the default embedding model is
`Snowflake/snowflake-arctic-embed-m-v1.5` (q8, CLS pooling, BGE-style query prefix),
replacing `Xenova/bge-small-en-v1.5`. This document records the survey, method, and
measurements behind that choice. The eval harness lives in [`eval/`](../eval/README.md)
(runnable against your own corpus).

Corpus: 260 sessions / 1141 chunks of real OpenCode conversation history (frozen
snapshot). All models ran under Transformers.js (`@huggingface/transformers` ^3.5.2)
in Bun, CPU-only (Apple Silicon), q8. Every shortlisted model was actually loaded and
embedded the full corpus — no paper-only claims.

## Survey summary (July 2026)

Constraints: ONNX weights loadable in Transformers.js under Bun, ≤ ~500M params,
English-strong asymmetric retrieval, permissive license (MIT/Apache).

- **The `Xenova/*` mirror repos are disappearing.** `Xenova/nomic-embed-text-v1.5` and
  `Xenova/snowflake-arctic-embed-m-v1.5` now 401 (gone). However, the **official** repos
  (`Snowflake/*`, `nomic-ai/*`, `Alibaba-NLP/*`) now ship their own ONNX exports
  including q8 (`onnx/model_quantized.onnx`), so Xenova mirrors are no longer needed
  for these families.
- **Jina v5** (`jina-embeddings-v5-text-nano`, Feb 2026, 239M) is CC-BY-NC-4.0 —
  excluded (license).
- **Qwen3-Embedding-0.6B** has a transformers.js ONNX port
  (`onnx-community/Qwen3-Embedding-0.6B-ONNX`) but is 600M params — over budget.
- **EmbeddingGemma** (Sep 2025, 300M) is the strongest ≤500M open retriever on MTEB by
  a wide margin and has ONNX (`onnx-community/embeddinggemma-300m-ONNX`), but is under
  the **Gemma license**, not MIT/Apache. Evaluated anyway as a stretch candidate.
- ModernBERT-based embedders (gte-modernbert, granite-r2) all have q8 ONNX and work in
  transformers.js 3.5.

## Shortlist

| Model | Released | Params | Dims | Ctx | MTEB retrieval | ONNX repo (verified) | q8 | License |
|---|---|---|---|---|---|---|---|---|
| bge-small-en-v1.5 (then-baseline) | 2023-09 | 33M | 384 | 512 | 51.7 (MTEB v1 retr.) | `Xenova/bge-small-en-v1.5` | ✓ | MIT |
| snowflake-arctic-embed-m-v1.5 | 2024-07 | 109M | 768 | 512 | 55.2 (MTEB v1 retr.) | `Snowflake/snowflake-arctic-embed-m-v1.5` (official `onnx/`) | ✓ | Apache-2.0 |
| nomic-embed-text-v1.5 | 2024-02 | 137M | 768 | 8192 | 53.3 (BEIR) | `nomic-ai/nomic-embed-text-v1.5` (official `onnx/`) | ✓ | Apache-2.0 |
| gte-modernbert-base | 2025 | 149M | 768 | 8192 | 57.0 (MTEB v2 retr.); CoIR 71.5 | `Alibaba-NLP/gte-modernbert-base` (official `onnx/`) | ✓ | Apache-2.0 |
| granite-embedding-english-r2 | 2025-08 | 149M | 768 | 8192 | 53.1 (BEIR); 56.4 (MTEB v2 retr.) | `onnx-community/granite-embedding-english-r2-ONNX` | ✓ | Apache-2.0 |
| embeddinggemma-300m ⚠️ | 2025-09 | 300M | 768 (MRL) | 2048 | 68.4 (MTEB eng v2 overall; #1 ≤500M at launch) | `onnx-community/embeddinggemma-300m-ONNX` | ✓ | **Gemma** (not MIT/Apache) |

Query/doc prefixes used (per official cards): bge & snowflake — query
`"Represent this sentence for searching relevant passages: "`, docs bare; nomic —
`"search_query: "` / `"search_document: "`; gte-modernbert & granite-r2 — none;
embeddinggemma — `"task: search result | query: "` / `"title: none | text: "`.
Pooling: bge-small mean (= then-production), snowflake/gte/granite CLS, nomic mean,
embeddinggemma pre-pooled `sentence_embedding` output.

## Eval method

- Identical 1141 chunks for all models (same parser/chunker as `src/indexer.ts`,
  2000-char embed truncation as in production).
- 15 known-answer queries (expected session verified by hand; conversation forks count
  as hits) + 3 negative controls ("kubernetes ingress migration", "fine-tuning a
  diffusion model on TPUs", "sourdough starter feeding schedule").
- Metrics: top-1 / top-3 / top-5 hit rate (best-chunk-per-session dedup), worst-case
  separation = min top-1 score across true hits − max score across negative controls.

## Results

| Model | top-1 | top-3 | top-5 | min true-hit | max negative | separation | ms/chunk (q8, CPU) | ms/query |
|---|---|---|---|---|---|---|---|---|---|
| **snowflake-arctic-embed-m-v1.5** | **13/15** | **14/15** | 14/15 | 0.405 | 0.328 | **+0.076** | 114 | 9.6 |
| bge-small-en-v1.5 (baseline) | **13/15** | 13/15 | 14/15 | 0.689 | 0.659 | +0.030 | **50** | **4.3** |
| nomic-embed-text-v1.5 | 12/15 | **14/15** | 14/15 | 0.677 | 0.606 | +0.071 | 220 | 9.6 |
| embeddinggemma-300m ⚠️ | 11/15 | **14/15** | **15/15** | 0.426 | 0.334 | **+0.093** | 551 | 55.5 |
| granite-embedding-english-r2 | 11/15 | 13/15 | 14/15 | 0.815 | 0.757 | +0.058 | 297 | 7.9 |
| gte-modernbert-base | 8/15 | **14/15** | **15/15** | 0.680 | 0.601 | +0.079 | 317 | 8.0 |
| bge-small + CLS pooling (control) | 12/15 | 13/15 | — | 0.707 | 0.687 | +0.020 | 45 | 4.2 |

Negative-control top scores (k8s / diffusion / sourdough): bge 0.659/0.603/0.534 ·
snowflake **0.328/0.312/0.310** · nomic 0.564/0.606/0.561 · gemma **0.334/0.326/0.218**
· granite 0.757/0.746/0.712 · gte 0.601/0.593/0.489.

Score calibration on this corpus (snowflake, top-1 of true hits): 0.405–0.729, median
≈ 0.56; negatives ≤ 0.33.

Notes:

- All 7 runs missed "reverse-engineering a vendor's private API" at top-1 (intrinsically
  hard query — the target sessions say "endpoint discovery", and several near-equivalent
  sessions compete).
- "Deploying the MCP server to Cloudflare Workers" is contested by 4+ genuinely-related
  sessions; expected session is top-3 for snowflake/nomic/gte.
- CLS pooling does **not** rescue bge-small (12/15 top-1, sep +0.020) — mean pooling was
  already its better config; the ceiling is the model, not the pooling.
- Benchmark pedigree did not predict our ranking: gte-modernbert (best MTEB v2 retr. +
  best code retrieval on paper) had the worst top-1 here.

## Ranked outcome

1. **snowflake-arctic-embed-m-v1.5 (q8) — chosen.** Ties the baseline on top-1 (13/15),
   wins top-3 (14/15), and its score distribution is dramatically better-behaved:
   negatives top out at 0.33 vs bge's 0.66, so the "scores cluster high / a non-match
   can read 0.6" problem largely disappears and a `minScore` threshold (~0.35) becomes
   viable. 109M params, 114 ms/chunk (full reindex ≈ 2.2 min vs 1 min — immaterial),
   ~10 ms/query, Apache-2.0, official q8 ONNX, same query prefix bge used.
2. **bge-small-en-v1.5 (previous default) — still perfectly defensible.** Best top-1
   (tied), fastest by 2.3×, smallest. Its weakness is structural: the compressed
   0.53–0.85 score band makes thresholding impossible.
3. **nomic-embed-text-v1.5** — good all-rounder (12/15, 14/15) with 8k context, but
   4.4× slower than baseline and missed the Cloudflare query at top-1.
4. **embeddinggemma-300m** — best top-5 and best separation, most modern model, but 11×
   slower per chunk, 55 ms/query, worse top-1 here, and the Gemma license violates the
   MIT/Apache constraint.
5. **granite-r2 / gte-modernbert** — strong on paper, not on this corpus; granite's
   negatives run at 0.71–0.76 (worst separation of the field).

## Migration applied

`src/embed.ts`: `DEFAULT_MODEL = "Snowflake/snowflake-arctic-embed-m-v1.5"`, pooling
`"mean"` → `"cls"` (snowflake is CLS-pooled — this matters), prefix constant renamed
`BGE_QUERY_PREFIX` → `QUERY_PREFIX` (value unchanged — Snowflake uses the identical
prompt). Dims 384 → 768 (index storage doubles to ~3.5 MB at 1.1k chunks, trivial).
`store.ts` needed no change (dims-agnostic). Reindex with `bun run src/cli.ts sync
--force` (~2–3 min). Optional follow-up: wire `SearchOptions.minScore ≈ 0.35` in the
plugin to suppress off-topic hits, since snowflake's negatives sit below 0.33.

Caveats: 15 queries / 1141 chunks / one user's English coding-assistant corpus — the
snowflake win is on top-3 + separation (top-1 is a tie). Re-run the eval before any
future model swap; it is cheap and corpus-faithful.
