// Model loading shared by the private sidecar and the shared service, so both
// modes produce identical vectors for existing indexes.

// Keep this fallback synchronized with DEFAULT_MODEL in embed.ts; embed.test.ts
// guards against accidental drift between the Bun host and Node backends.
export const MODEL = process.env.EPISODIC_EMBED_MODEL ?? "Snowflake/snowflake-arctic-embed-m-v1.5";
export const MAX_REQUEST_TEXTS = 64;

export function positiveIntegerEnv(name, defaultValue, maximum) {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid ${name} ${JSON.stringify(value)}; expected an integer from 1 to ${maximum}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`Invalid ${name} ${JSON.stringify(value)}; expected an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

export function validRequest(value) {
  return value && typeof value === "object" && Number.isSafeInteger(value.id)
    && Array.isArray(value.texts) && value.texts.length <= MAX_REQUEST_TEXTS
    && value.texts.every((text) => typeof text === "string");
}

/** Returns `embed(texts)` resolving to plain number arrays. */
export async function loadEmbedder(model, batchSize) {
  const { pipeline } = await import("@huggingface/transformers");
  const embedder = await pipeline("feature-extraction", model, { dtype: "q8" });
  return async function embed(texts) {
    const vectors = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const batch = texts.slice(offset, offset + batchSize);
      const output = await embedder(batch, { pooling: "cls", normalize: true });
      const dimensions = output.dims.at(-1);
      if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new Error("model returned invalid embedding dimensions");
      const data = output.data;
      if (data.length !== batch.length * dimensions) throw new Error("model returned an invalid embedding batch");
      for (let index = 0; index < batch.length; index++) {
        vectors.push(Array.from(data.slice(index * dimensions, (index + 1) * dimensions)));
      }
    }
    return vectors;
  };
}
