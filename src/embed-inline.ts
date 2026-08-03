// Explicit escape hatch for hosts where loading native ML addons in Bun is safe.
// Keep this module dynamically imported by embed.ts so the normal plugin import
// path cannot load Transformers.js.
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

import { DEFAULT_MODEL } from "./embed.ts";

let cached: Promise<FeatureExtractionPipeline> | null = null;

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!cached) {
    cached = import("@huggingface/transformers")
      .then(({ pipeline }) => pipeline("feature-extraction", process.env.EPISODIC_EMBED_MODEL ?? DEFAULT_MODEL, { dtype: "q8" }) as Promise<FeatureExtractionPipeline>);
    // A rejected promise (for example, a failed model download) must not poison
    // the cache for the lifetime of the process.
    cached.catch(() => { cached = null; });
  }
  return cached;
}

export async function embedInline(texts: string[]): Promise<Float32Array[]> {
  const embedder = await getEmbedder();
  const output = await embedder(texts, { pooling: "cls", normalize: true });
  const dimensions: number = output.dims[output.dims.length - 1];
  // A normalized feature-extraction tensor is Float32Array at runtime.
  const flat = new Float32Array(output.data as Float32Array);
  return texts.map((_, index) => flat.subarray(index * dimensions, (index + 1) * dimensions));
}
