// Embed the eval corpus + run the known-answer test set for one model.
// Usage: bun run eval/run-model.ts <modelKey>   (keys: see eval/models.ts)
// Writes eval/private/results-<modelKey>.json (gitignored).
import { pipeline, AutoModel, AutoTokenizer } from "@huggingface/transformers";
import { MODELS, MAX_CHARS, type ModelConfig } from "./models";
import { QUERIES } from "./private/queries";

const key = process.argv[2];
const cfg = MODELS.find((m) => m.key === key);
if (!cfg) { console.error("unknown model", key); process.exit(1); }

interface CorpusChunk {
  session_id: string; seq: number; time_created: number; title: string; directory: string; text: string;
}
// Validate every element, not just the outer array — a malformed chunk would
// otherwise flow in untyped and blow up later in embedding/scoring.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function isCorpusChunk(v: unknown): v is CorpusChunk {
  return (
    isRecord(v) &&
    typeof v.session_id === "string" &&
    typeof v.seq === "number" &&
    typeof v.time_created === "number" &&
    typeof v.title === "string" &&
    typeof v.directory === "string" &&
    typeof v.text === "string"
  );
}
const here = new URL(".", import.meta.url).pathname;
const parsedCorpus: unknown = JSON.parse(await Bun.file(here + "private/corpus.json").text());
if (!Array.isArray(parsedCorpus)) throw new Error("corpus.json is not a JSON array");
const badIndex = parsedCorpus.findIndex((c) => !isCorpusChunk(c));
if (badIndex !== -1) throw new Error(`corpus.json[${badIndex}] is not a valid CorpusChunk`);
const corpus: CorpusChunk[] = parsedCorpus;

// ---- embedder setup ----
type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;
let embedRaw: EmbedFn;

if (cfg.autoModelSentenceEmbedding) {
  const tokenizer = await AutoTokenizer.from_pretrained(cfg.repo);
  const model = await AutoModel.from_pretrained(cfg.repo, { dtype: cfg.dtype });
  embedRaw = async (texts) => {
    const inputs = await tokenizer(texts.map((t) => t.slice(0, MAX_CHARS)), { padding: true, truncation: true });
    const { sentence_embedding } = await model(inputs);
    const dims: number = sentence_embedding.dims.at(-1);
    // .data is a DataArray union; the sentence_embedding output is Float32 at runtime.
    const flat = new Float32Array(sentence_embedding.data as Float32Array);
    return texts.map((_, i) => flat.subarray(i * dims, (i + 1) * dims));
  };
} else {
  const extractor = await pipeline("feature-extraction", cfg.repo, { dtype: cfg.dtype });
  embedRaw = async (texts) => {
    const out = await extractor(texts.map((t) => t.slice(0, MAX_CHARS)), { pooling: cfg.pooling, normalize: true });
    const dims: number = out.dims.at(-1);
    // out.data is a DataArray union; a normalized feature-extraction tensor is Float32.
    const flat = new Float32Array(out.data as Float32Array);
    return texts.map((_, i) => flat.subarray(i * dims, (i + 1) * dims));
  };
}

const embedDocs: EmbedFn = (texts) => embedRaw(texts.map((t) => cfg.docPrefix + t));
const embedQuery = async (q: string) => (await embedRaw([cfg.queryPrefix + q]))[0];

// ---- sanity check: load + embed before doing anything else ----
const sanity = await embedQuery("sanity check: local embedding model loads");
console.error(`[${key}] loaded, dims=${sanity.length}`);

// ---- embed corpus ----
const t0 = performance.now();
const BATCH = 32;
const vecs: Float32Array[] = new Array(corpus.length);
for (let i = 0; i < corpus.length; i += BATCH) {
  const batch = corpus.slice(i, i + BATCH).map((c) => c.text);
  const out = await embedDocs(batch);
  for (let j = 0; j < out.length; j++) vecs[i + j] = out[j];
  process.stderr.write(`\r[${key}] ${Math.min(i + BATCH, corpus.length)}/${corpus.length}`);
}
const embedMs = performance.now() - t0;
console.error(`\n[${key}] corpus embedded in ${(embedMs / 1000).toFixed(1)}s (${(embedMs / corpus.length).toFixed(1)} ms/chunk)`);

// ---- run test set ----
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const results = [];
const t1 = performance.now();
for (const tq of QUERIES) {
  const qv = await embedQuery(tq.q);
  const scored = corpus
    .map((c, i) => ({ session_id: c.session_id, title: c.title, score: cosine(qv, vecs[i]) }))
    .sort((a, b) => b.score - a.score);
  // dedupe to best-per-session for hit-rate semantics
  const seen = new Set<string>();
  const topSessions: { session_id: string; title: string; score: number }[] = [];
  for (const s of scored) {
    if (seen.has(s.session_id)) continue;
    seen.add(s.session_id);
    topSessions.push(s);
    if (topSessions.length >= 5) break;
  }
  results.push({ q: tq.q, expect: tq.expect ?? null, negative: !!tq.negative, topScore: scored[0].score, topSessions });
}
const queryMs = (performance.now() - t1) / QUERIES.length;

await Bun.write(here + `private/results-${key}.json`, JSON.stringify({ key, repo: cfg.repo, dims: sanity.length, embedMs, queryMs, results }, null, 2));
console.error(`[${key}] done, ${queryMs.toFixed(1)} ms/query (incl. query embed)`);
