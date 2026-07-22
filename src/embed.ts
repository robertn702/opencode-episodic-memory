// Local, offline embeddings via Transformers.js. CLS-pooled + L2-normalized,
// so cosine similarity is a plain dot product.
//
// Model: Snowflake/snowflake-arctic-embed-m-v1.5 (q8) — 768 dims, Apache-2.0,
// official ONNX export in the model repo. Chosen over Xenova/bge-small-en-v1.5
// by empirical eval on our real corpus (2026-07-22, see
// docs/embedding-model-eval.md): equal top-1, better top-3, and far better
// score separation (negatives max ~0.33 vs bge's ~0.66), so minScore
// thresholding is meaningful. Asymmetric retriever: queries get a task
// prefix, documents go through unmodified.
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const DEFAULT_MODEL = "Snowflake/snowflake-arctic-embed-m-v1.5";

// BGE/Snowflake convention (identical prompt for both): prefix QUERIES only.
// Idempotent via embedQuery().
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

// Upstream measured retrieval quality peaks at 2000 chars; longer inputs
// degrade embeddings (and this model's window is 512 tokens anyway).
export const MAX_CHARS = 2000;

let cached: Promise<FeatureExtractionPipeline> | null = null;

export function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!cached) {
    // transformers.js declares pipeline<"feature-extraction"> as its task-metadata
    // record, not the FeatureExtractionPipeline instance it returns at runtime, so
    // this cast restores the documented return type (matches HuggingFace's examples).
    cached = pipeline("feature-extraction", process.env.EPISODIC_EMBED_MODEL ?? DEFAULT_MODEL, {
      dtype: "q8",
    }) as Promise<FeatureExtractionPipeline>;
    // A rejected promise (e.g. failed model download) would poison the cache
    // for the lifetime of the process; reset so the next call retries.
    cached.catch(() => { if (cached) cached = null; });
  }
  return cached;
}

async function embedRaw(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const e = await getEmbedder();
  const out = await e(texts.map((t) => t.slice(0, MAX_CHARS)), { pooling: "cls", normalize: true });
  const dims: number = out.dims[out.dims.length - 1];
  // out.data is DataArray (a union incl. bigint typed arrays); a feature-extraction
  // tensor with normalize:true is a Float32Array at runtime, so this cast is safe.
  const flat = new Float32Array(out.data as Float32Array);
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(flat.subarray(i * dims, (i + 1) * dims));
  }
  return vectors;
}

/** Embed documents (conversation chunks). No prefix. */
export const embed = embedRaw;

/** Embed a search query. Prepends the retrieval prefix. */
export function embedQuery(query: string): Promise<Float32Array[]> {
  const q = query.startsWith(QUERY_PREFIX) ? query : QUERY_PREFIX + query;
  return embedRaw([q]);
}
