// Client for EPISODIC_EMBED_MODE=shared. Connects to the user's shared
// embedding service (src/embed-service.mjs), starting it when absent. Failures
// surface as errors; this mode never falls back to a private sidecar.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Keep synchronized with PROTOCOL in embed-service.mjs.
export const SHARED_PROTOCOL = 1;
const CONNECT_RETRY_MS = 50;
const MAX_STARTS = 3;

type PendingRequest = {
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
  count: number;
};

type Connection = {
  socket: Socket;
  pending: Map<number, PendingRequest>;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
  buffer: string;
  dimensions: number | null;
  closed: boolean;
  logPath: string;
};

export type SharedServiceInfo = {
  identity: { protocol: number; version: string; model: string };
  directory: string;
  socketPath: string;
  logPath: string;
};

class SharedUnavailableError extends Error {}

const packageSchema = z.object({ version: z.string() });

let current: Connection | null = null;
let opening: Promise<Connection> | null = null;
let nextRequestId = 1;

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("EPISODIC_EMBED_MODE=shared requires a platform with Unix domain sockets");
  return uid;
}

/** Socket and log locations. Services are keyed by everything that affects vectors. */
export function sharedServiceInfo(model: string): SharedServiceInfo {
  const { version } = packageSchema.parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
  const identity = { protocol: SHARED_PROTOCOL, version, model };
  const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
  const directory = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `episodic-memory-${currentUid()}`);
  return { identity, directory, socketPath: join(directory, `${key}.sock`), logPath: join(directory, `${key}.log`) };
}

function ensurePrivateDirectory(directory: string): void {
  const uid = currentUid();
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error(`Refusing to use shared embedding directory ${directory}: it must be a real directory owned by uid ${uid} with mode 0700`);
  }
}

function logTail(logPath: string): string {
  try {
    const size = statSync(logPath).size;
    const length = Math.min(size, 2_048);
    const buffer = Buffer.alloc(length);
    const descriptor = openSync(logPath, "r");
    try {
      readSync(descriptor, buffer, 0, length, size - length);
    } finally {
      closeSync(descriptor);
    }
    const text = buffer.toString("utf8").trim();
    return text ? `; service log (${logPath}):\n${text}` : "";
  } catch {
    return "";
  }
}

function tryConnect(path: string): Promise<Socket | null> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    const onError = (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(null);
      else reject(new SharedUnavailableError(`Could not connect to shared embedding service at ${path}: ${error.message}`));
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

function spawnService(info: SharedServiceInfo): Bun.Subprocess {
  const nodeBinary = process.env.EPISODIC_NODE_BINARY ?? "node";
  const servicePath = fileURLToPath(new URL("./embed-service.mjs", import.meta.url));
  const log = openSync(info.logPath, "a", 0o600);
  try {
    const child = Bun.spawn([nodeBinary, servicePath, info.socketPath], {
      env: process.env,
      stdin: "ignore",
      stdout: log,
      stderr: log,
      detached: true,
    });
    child.unref();
    return child;
  } catch (error) {
    throw new Error(`Could not start shared embedding service using ${JSON.stringify(nodeBinary)}. Install Node 20+ or set EPISODIC_NODE_BINARY: ${String(error)}`);
  } finally {
    closeSync(log);
  }
}

async function connectOrStart(info: SharedServiceInfo, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  const existing = await tryConnect(info.socketPath);
  if (existing) return existing;
  // Concurrent starters are safe: the service publishes its socket atomically
  // and losers exit 0. If our starter lost and the winner has since gone too,
  // start again rather than waiting out the deadline.
  for (let start = 0; start < MAX_STARTS; start++) {
    const child = spawnService(info);
    while (Date.now() < deadline) {
      await Bun.sleep(CONNECT_RETRY_MS);
      const socket = await tryConnect(info.socketPath);
      if (socket) return socket;
      if (child.signalCode !== null || (child.exitCode !== null && child.exitCode !== 0)) {
        throw new SharedUnavailableError(`Shared embedding service exited (${child.signalCode ?? `code ${child.exitCode}`})${logTail(info.logPath)}`);
      }
      if (child.exitCode === 0) break;
    }
    if (Date.now() >= deadline) {
      throw new SharedUnavailableError(`Shared embedding service did not accept connections within ${timeoutMs}ms${logTail(info.logPath)}`);
    }
    const winner = await tryConnect(info.socketPath);
    if (winner) return winner;
  }
  throw new SharedUnavailableError(`Shared embedding service did not start after ${MAX_STARTS} attempts${logTail(info.logPath)}`);
}

function fail(connection: Connection, error: Error): void {
  if (connection.closed) return;
  connection.closed = true;
  if (current === connection) current = null;
  for (const { reject } of connection.pending.values()) reject(error);
  connection.pending.clear();
  connection.rejectReady(error);
  connection.socket.destroy();
}

function vectorsFromResponse(value: unknown, expectedCount: number, connection: Connection): Float32Array[] {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new Error(`expected ${expectedCount} vectors, got ${Array.isArray(value) ? value.length : "a non-array"}`);
  }
  const vectors = value.map((vector) => {
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new Error("vectors must be non-empty arrays of finite numbers");
    }
    if (connection.dimensions !== null && vector.length !== connection.dimensions) {
      throw new Error(`expected ${connection.dimensions} dimensions, got ${vector.length}`);
    }
    return new Float32Array(vector);
  });
  const dimensions = vectors[0]?.length;
  if (vectors.some((vector) => vector.length !== dimensions)) throw new Error("vectors have inconsistent dimensions");
  connection.dimensions ??= dimensions ?? null;
  return vectors;
}

const responseSchema = z.object({
  ready: z.boolean().optional(),
  id: z.number().int().optional(),
  error: z.string().optional(),
  vectors: z.unknown().optional(),
});

function handleLine(connection: Connection, line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail(connection, new SharedUnavailableError("Shared embedding service protocol error: invalid JSON"));
    return;
  }
  const response = responseSchema.safeParse(parsed);
  if (!response.success) {
    fail(connection, new SharedUnavailableError("Shared embedding service protocol error: unexpected response"));
    return;
  }
  const { ready, id, error, vectors } = response.data;
  if (ready === true) {
    connection.resolveReady();
    return;
  }
  if (ready === false) {
    fail(connection, new SharedUnavailableError(`Shared embedding service is unavailable: ${error ?? "unknown error"}`));
    return;
  }
  const pending = id === undefined ? undefined : connection.pending.get(id);
  if (id === undefined || !pending) {
    fail(connection, new SharedUnavailableError(`Shared embedding service protocol error: unknown request id ${String(id)}${error ? ` (${error})` : ""}`));
    return;
  }
  connection.pending.delete(id);
  if (error !== undefined) {
    pending.reject(new Error(`Shared embedding request failed: ${error}`));
    return;
  }
  try {
    pending.resolve(vectorsFromResponse(vectors, pending.count, connection));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    pending.reject(new Error(`Shared embedding service protocol error: ${message}`));
    fail(connection, new SharedUnavailableError(`Shared embedding service protocol error: ${message}`));
  }
}

function createConnection(socket: Socket, logPath: string): Connection {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  const connection: Connection = { socket, pending: new Map(), ready, resolveReady, rejectReady, buffer: "", dimensions: null, closed: false, logPath };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    connection.buffer += chunk;
    let newline: number;
    while (!connection.closed && (newline = connection.buffer.indexOf("\n")) >= 0) {
      const line = connection.buffer.slice(0, newline);
      connection.buffer = connection.buffer.slice(newline + 1);
      if (line) handleLine(connection, line);
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => fail(connection, new SharedUnavailableError(`Shared embedding service closed the connection${logTail(logPath)}`)));
  return connection;
}

async function openConnection(model: string, readyTimeoutMs: number): Promise<Connection> {
  const info = sharedServiceInfo(model);
  ensurePrivateDirectory(info.directory);
  const socket = await connectOrStart(info, readyTimeoutMs);
  // An idle connection must not keep a short-lived CLI alive; request timers do
  // that while work is pending.
  socket.unref();
  const connection = createConnection(socket, info.logPath);
  socket.write(`${JSON.stringify({ hello: info.identity })}\n`);
  const timeout = setTimeout(() => {
    fail(connection, new SharedUnavailableError(`Shared embedding service did not become ready within ${readyTimeoutMs}ms${logTail(info.logPath)}`));
  }, readyTimeoutMs);
  try {
    await connection.ready;
  } finally {
    clearTimeout(timeout);
  }
  return connection;
}

function acquire(model: string, readyTimeoutMs: number): Promise<Connection> {
  if (current && !current.closed) return Promise.resolve(current);
  opening ??= openConnection(model, readyTimeoutMs)
    .then((connection) => {
      current = connection;
      return connection;
    })
    .finally(() => {
      opening = null;
    });
  return opening;
}

export async function requestShared(texts: string[], model: string, readyTimeoutMs: number, requestTimeoutMs: number, retried = false): Promise<Float32Array[]> {
  try {
    const connection = await acquire(model, readyTimeoutMs);
    const id = nextRequestId++;
    return await new Promise<Float32Array[]>((resolve, reject) => {
      // The timeout includes time queued behind other clients' work.
      const timeout = setTimeout(() => {
        fail(connection, new SharedUnavailableError(`Shared embedding request timed out after ${requestTimeoutMs}ms${logTail(connection.logPath)}`));
      }, requestTimeoutMs);
      const request: PendingRequest = {
        resolve: (vectors) => {
          clearTimeout(timeout);
          resolve(vectors);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        count: texts.length,
      };
      if (connection.closed) {
        request.reject(new SharedUnavailableError("Shared embedding service became unavailable before the request was sent"));
        return;
      }
      connection.pending.set(id, request);
      connection.socket.write(`${JSON.stringify({ id, texts })}\n`);
    });
  } catch (error) {
    if (!retried && error instanceof SharedUnavailableError) return requestShared(texts, model, readyTimeoutMs, requestTimeoutMs, true);
    throw error;
  }
}
