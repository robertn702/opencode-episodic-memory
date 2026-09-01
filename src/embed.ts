// Local, offline embeddings. The default backend lives in a system-Node
// sidecar so importing the OpenCode plugin never loads ML native addons into
// its embedded Bun process.
import { fileURLToPath } from "node:url";

export const DEFAULT_MODEL = "Snowflake/snowflake-arctic-embed-m-v1.5";

// BGE/Snowflake convention (identical prompt for both): prefix QUERIES only.
// Idempotent via embedQuery().
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

// Upstream measured retrieval quality peaks at 2000 chars; longer inputs
// degrade embeddings (and this model's window is 512 tokens anyway).
export const MAX_CHARS = 2000;

const DEFAULT_BATCH_SIZE = 32;
const MAX_BATCH_SIZE = 64;
const DEFAULT_READY_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export type EmbedMode = "sidecar" | "inline";

type PendingRequest = {
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
  count: number;
};

type Sidecar = {
  process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  pending: Map<number, PendingRequest>;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  stderr: string;
  stdout: string;
  dimensions: number | null;
};

class SidecarUnavailableError extends Error {}

let sidecar: Sidecar | null = null;
let nextRequestId = 1;

export function getEmbedMode(): EmbedMode {
  const mode = process.env.EPISODIC_EMBED_MODE ?? "sidecar";
  if (mode === "sidecar" || mode === "inline") return mode;
  throw new Error(`Invalid EPISODIC_EMBED_MODE ${JSON.stringify(mode)}; expected "sidecar" or "inline".`);
}

function tail(value: string, addition: string): string {
  return (value + addition).slice(-8_192);
}

function positiveIntegerEnv(name: string, defaultValue: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid ${name} ${JSON.stringify(value)}; expected an integer from 1 to ${maximum}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`Invalid ${name} ${JSON.stringify(value)}; expected an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

function sidecarError(message: string, child: Sidecar): Error {
  const details = child.stderr.trim();
  return new SidecarUnavailableError(details ? `${message}: ${details}` : message);
}

function rejectAll(child: Sidecar, error: Error): void {
  for (const { reject } of child.pending.values()) reject(error);
  child.pending.clear();
  child.rejectReady(error);
}

function sidecarGone(child: Sidecar, error: Error): void {
  if (sidecar === child) sidecar = null;
  rejectAll(child, error);
  child.process.kill();
}

function protocolFailure(child: Sidecar, message: string): void {
  const error = new Error(`Embedding sidecar protocol error: ${message}`);
  sidecarGone(child, error);
}

function vectorsFromResponse(value: unknown, expectedCount: number, child: Sidecar): Float32Array[] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new Error(`expected ${expectedCount} vectors, got ${Array.isArray(value) ? value.length : "a non-array"}`);
  }

  const vectors = value.map((vector) => {
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new Error("vectors must be non-empty arrays of finite numbers");
    }
    if (child.dimensions !== null && vector.length !== child.dimensions) {
      throw new Error(`expected ${child.dimensions} dimensions, got ${vector.length}`);
    }
    return new Float32Array(vector);
  });

  const dimensions = vectors[0]?.length;
  if (vectors.some((vector) => vector.length !== dimensions)) throw new Error("vectors have inconsistent dimensions");
  child.dimensions ??= dimensions ?? null;
  return vectors;
}

function handleLine(child: Sidecar, line: string): void {
  let response: unknown;
  try {
    response = JSON.parse(line);
  } catch {
    protocolFailure(child, "stdout contained invalid JSON");
    return;
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    protocolFailure(child, "response must be an object");
    return;
  }

  const record = response as Record<string, unknown>;
  if ("ready" in record) {
    if (record.ready === true) child.resolveReady();
    else {
      sidecarGone(child, new SidecarUnavailableError(`Embedding sidecar failed to start: ${typeof record.error === "string" ? record.error : "unknown error"}`));
    }
    return;
  }
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id)) {
    protocolFailure(child, "response has no valid request id");
    return;
  }
  const pending = child.pending.get(record.id);
  if (!pending) {
    protocolFailure(child, `response has unknown request id ${record.id}`);
    return;
  }
  child.pending.delete(record.id);
  if (typeof record.error === "string") {
    pending.reject(new Error(`Embedding sidecar request failed: ${record.error}`));
    return;
  }
  try {
    pending.resolve(vectorsFromResponse(record.vectors, pending.count, child));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pending.reject(new Error(`Embedding sidecar protocol error: ${message}`));
    protocolFailure(child, message);
  }
}

async function drainStdout(child: Sidecar): Promise<void> {
  const reader = child.process.stdout.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      child.stdout += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = child.stdout.indexOf("\n")) >= 0) {
        const line = child.stdout.slice(0, newline);
        child.stdout = child.stdout.slice(newline + 1);
        if (line) handleLine(child, line);
      }
    }
    if (child.stdout.trim()) protocolFailure(child, "stdout ended with an incomplete response");
  } catch (error) {
    if (sidecar === child) sidecarGone(child, sidecarError(`Could not read embedding sidecar output (${String(error)})`, child));
  } finally {
    reader.releaseLock();
  }
}

async function drainStderr(child: Sidecar): Promise<void> {
  const reader = child.process.stderr.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      child.stderr = tail(child.stderr, decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

function startSidecar(): Sidecar {
  if (sidecar) return sidecar;
  const nodeBinary = process.env.EPISODIC_NODE_BINARY ?? "node";
  const sidecarPath = fileURLToPath(new URL("./embed-sidecar.mjs", import.meta.url));
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The rejected ready promise is also observed by each request; suppress a
  // transient unhandled-rejection warning while the first request is starting.
  ready.catch(() => {});

  let childProcess: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    childProcess = Bun.spawn([nodeBinary, sidecarPath], {
      env: process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    throw new Error(`Could not start embedding sidecar using ${JSON.stringify(nodeBinary)}. Install Node 20+ or set EPISODIC_NODE_BINARY: ${String(error)}`);
  }
  childProcess.unref();
  const child: Sidecar = { process: childProcess, pending: new Map(), ready, resolveReady, rejectReady, stderr: "", stdout: "", dimensions: null };
  sidecar = child;
  void drainStdout(child);
  void drainStderr(child);
  void childProcess.exited.then(() => {
    if (sidecar === child) {
      sidecar = null;
      rejectAll(child, sidecarError("Embedding sidecar exited unexpectedly", child));
    }
  });
  return child;
}

function awaitReady(child: Sidecar, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const error = new SidecarUnavailableError(`Embedding sidecar did not become ready within ${timeoutMs}ms`);
      sidecarGone(child, error);
      reject(error);
    }, timeoutMs);
    child.ready.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function requestSidecar(texts: string[], readyTimeoutMs: number, requestTimeoutMs: number, retried = false): Promise<Float32Array[]> {
  let child: Sidecar;
  try {
    child = startSidecar();
    await awaitReady(child, readyTimeoutMs);
    const id = nextRequestId++;
    return await new Promise<Float32Array[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sidecarGone(child, new SidecarUnavailableError(`Embedding sidecar request timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      const resolveRequest = (vectors: Float32Array[]) => {
        clearTimeout(timeout);
        resolve(vectors);
      };
      const rejectRequest = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      child.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, count: texts.length });
      if (sidecar !== child) {
        child.pending.delete(id);
        rejectRequest(new SidecarUnavailableError("Embedding sidecar became unavailable before the request was sent"));
        return;
      }
      try {
        child.process.stdin.write(`${JSON.stringify({ id, texts })}\n`);
      } catch (error) {
        child.pending.delete(id);
        const unavailable = new SidecarUnavailableError(`Could not write to embedding sidecar: ${String(error)}`);
        sidecarGone(child, unavailable);
        rejectRequest(unavailable);
      }
    });
  } catch (error) {
    if (!retried && error instanceof SidecarUnavailableError) return requestSidecar(texts, readyTimeoutMs, requestTimeoutMs, true);
    throw error;
  }
}

async function embedRaw(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const prepared = texts.map((text) => text.slice(0, MAX_CHARS));
  if (getEmbedMode() === "inline") {
    // Unsafe under affected OpenCode/Bun versions: this intentionally loads
    // Transformers.js only when the caller explicitly opts in.
    const { embedInline } = await import("./embed-inline.ts");
    return embedInline(prepared);
  }
  const batchSize = positiveIntegerEnv("EPISODIC_EMBED_BATCH_SIZE", DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
  const readyTimeoutMs = positiveIntegerEnv("EPISODIC_EMBED_READY_TIMEOUT_MS", DEFAULT_READY_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const requestTimeoutMs = positiveIntegerEnv("EPISODIC_EMBED_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const vectors: Float32Array[] = [];
  for (let index = 0; index < prepared.length; index += batchSize) {
    vectors.push(...await requestSidecar(prepared.slice(index, index + batchSize), readyTimeoutMs, requestTimeoutMs));
  }
  return vectors;
}

/** Embed documents (conversation chunks). No prefix. */
export const embed = embedRaw;

/** Embed a search query. Prepends the retrieval prefix. */
export function embedQuery(query: string): Promise<Float32Array[]> {
  return embedRaw([query.startsWith(QUERY_PREFIX) ? query : QUERY_PREFIX + query]);
}
