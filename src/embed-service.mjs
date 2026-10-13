// Shared local embedding service for EPISODIC_EMBED_MODE=shared. One process
// per compatible configuration serves NDJSON over a user-private Unix socket,
// so several OpenCode processes reuse one loaded model. Clients spawn it on
// demand; it exits after EPISODIC_EMBED_IDLE_TIMEOUT_MS without embedding work.
import { linkSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, chmodSync } from "node:fs";
import { connect, createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { loadEmbedder, MAX_REQUEST_TEXTS, MODEL, positiveIntegerEnv, validRequest } from "./embed-model.mjs";

// Keep synchronized with SHARED_PROTOCOL in embed-shared.ts.
export const PROTOCOL = 1;
const MAX_QUEUED_REQUESTS = 256;
const MAX_LINE_LENGTH = 4 * 1024 * 1024;
const OWNERSHIP_CHECK_MS = 5_000;
const LIVENESS_PROBE_MS = 1_000;

function log(message) {
  process.stderr.write(`${new Date().toISOString()} [${process.pid}] ${message}\n`);
}

function requestTimeoutEnv() {
  const value = process.env.EPISODIC_EMBED_REQUEST_TIMEOUT_MS ?? "120000";
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid EPISODIC_EMBED_REQUEST_TIMEOUT_MS ${JSON.stringify(value)}`);
  return Number(value);
}

function idleTimeoutEnv() {
  const value = process.env.EPISODIC_EMBED_IDLE_TIMEOUT_MS ?? "300000";
  if (!/^\d+$/.test(value)) throw new Error(`Invalid EPISODIC_EMBED_IDLE_TIMEOUT_MS ${JSON.stringify(value)}`);
  return Number(value);
}

export function serviceIdentity() {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return { protocol: PROTOCOL, version, model: MODEL };
}

function sameIdentity(a, b) {
  return Boolean(a) && typeof a === "object" && a.protocol === b.protocol && a.version === b.version && a.model === b.model;
}

function isLive(path) {
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    const timer = setTimeout(() => { socket.destroy(); resolve(true); }, LIVENESS_PROBE_MS);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

// Publishes our temporary socket at `path` with link(2), which fails instead of
// replacing an existing file, so only one starter can win. A stale socket left
// by a crash is moved aside and removed only if it is still the inode probed.
async function claim(temporaryPath, path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      linkSync(temporaryPath, path);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let stale;
    try { stale = lstatSync(path); } catch { continue; }
    if (await isLive(path)) return false;
    const aside = `${temporaryPath}.stale`;
    try { renameSync(path, aside); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const moved = lstatSync(aside);
    if (moved.ino === stale.ino && moved.dev === stale.dev) {
      unlinkSync(aside);
      log(`removed stale socket ${path}`);
      continue;
    }
    // Another starter replaced the stale socket after our probe; put it back.
    try { linkSync(aside, path); } catch {}
    unlinkSync(aside);
    return false;
  }
  throw new Error(`could not claim shared embedding socket ${path}`);
}

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function runService({ socketPath, load }) {
  const identity = serviceIdentity();
  const idleTimeoutMs = idleTimeoutEnv();
  // Half the client request timeout, so a wedged service exits before its
  // clients give up and their single retry reaches a fresh service.
  const inferenceTimeoutMs = Math.max(1, Math.floor(requestTimeoutEnv() / 2));
  const batchSize = positiveIntegerEnv("EPISODIC_EMBED_BATCH_SIZE", 32, MAX_REQUEST_TEXTS);
  const connections = new Set();
  let embed = null;
  let loadError = null;
  let queue = Promise.resolve();
  let outstanding = 0;
  let idleTimer = null;
  let ownershipTimer = null;
  let socketInode = null;
  let stopping = false;

  const write = (connection, response) => {
    if (!connection.socket.destroyed) connection.socket.write(`${JSON.stringify(response)}\n`);
  };

  const announce = (connection) => {
    if (embed) write(connection, { ready: true });
    else if (loadError) write(connection, { ready: false, error: loadError });
  };

  function stop(reason, exitCode = 0) {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    log(`stopping: ${reason}`);
    clearTimeout(idleTimer);
    clearInterval(ownershipTimer);
    try {
      if (socketInode !== null && lstatSync(socketPath).ino === socketInode) unlinkSync(socketPath);
    } catch {}
    server.close();
    for (const connection of connections) connection.socket.end();
    // Let final error responses flush before exiting.
    setTimeout(() => process.exit(exitCode), 100).unref();
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!idleTimeoutMs || outstanding !== 0 || stopping) return;
    idleTimer = setTimeout(() => {
      if (outstanding === 0) stop(`idle for ${idleTimeoutMs}ms`);
    }, idleTimeoutMs);
  }

  function handleLine(connection, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(connection, { id: null, error: "request must be valid JSON" });
      return;
    }
    if (!connection.accepted) {
      if (!message || typeof message !== "object" || !sameIdentity(message.hello, identity)) {
        write(connection, { ready: false, error: `incompatible shared embedding service: it serves ${JSON.stringify(identity)}, client requested ${JSON.stringify(message?.hello ?? null)}` });
        connection.socket.end();
        return;
      }
      connection.accepted = true;
      announce(connection);
      return;
    }
    if (!validRequest(message)) {
      write(connection, { id: message && typeof message === "object" && "id" in message ? message.id : null, error: `request must have an integer id and at most ${MAX_REQUEST_TEXTS} string texts` });
      return;
    }
    if (stopping) return;
    if (!embed) {
      write(connection, { id: message.id, error: "shared embedding model is not ready; wait for the ready message" });
      return;
    }
    if (outstanding >= MAX_QUEUED_REQUESTS) {
      write(connection, { id: message.id, error: `shared embedding service is busy (${MAX_QUEUED_REQUESTS} queued requests)` });
      return;
    }
    outstanding += 1;
    clearTimeout(idleTimer);
    // One request runs at a time across all clients; others wait in FIFO order.
    queue = queue.then(async () => {
      if (connection.socket.destroyed || stopping) return;
      // A hung inference cannot be cancelled, so exit and let clients retry on
      // a fresh service rather than queueing forever behind it.
      const watchdog = setTimeout(() => stop(`inference exceeded ${inferenceTimeoutMs}ms`, 1), inferenceTimeoutMs);
      try {
        write(connection, { id: message.id, vectors: await embed(message.texts) });
      } catch (error) {
        write(connection, { id: message.id, error: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(watchdog);
      }
    }).finally(() => {
      outstanding -= 1;
      scheduleIdle();
    });
  }

  const server = createServer((socket) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    const connection = { socket, accepted: false, remainder: "" };
    connections.add(connection);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      connection.remainder += chunk;
      if (connection.remainder.length > MAX_LINE_LENGTH) {
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = connection.remainder.indexOf("\n")) >= 0) {
        const line = connection.remainder.slice(0, newline);
        connection.remainder = connection.remainder.slice(newline + 1);
        if (line) handleLine(connection, line);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(connection));
  });

  // Bind privately, then publish with link(2). Closing the server unlinks only
  // the temporary name, never a socket another service may now own.
  const temporaryPath = `${socketPath}.${process.pid}`;
  try { unlinkSync(temporaryPath); } catch {}
  await listen(server, temporaryPath);
  chmodSync(temporaryPath, 0o600);
  // The published name is a hard link, so it shares this inode.
  const boundInode = lstatSync(temporaryPath).ino;
  let claimed;
  try {
    claimed = await claim(temporaryPath, socketPath);
  } finally {
    unlinkSync(temporaryPath);
  }
  if (!claimed) {
    log(`another service already owns ${socketPath}; exiting`);
    server.close();
    return;
  }
  socketInode = boundInode;
  server.on("error", (error) => stop(`server error: ${error.message}`, 1));
  log(`serving ${JSON.stringify(identity)} on ${socketPath}`);

  // Retire if the published path no longer names our socket (removed, or
  // replaced after a rare stale-socket race), so clients converge on one service.
  ownershipTimer = setInterval(() => {
    let current = null;
    try { current = lstatSync(socketPath).ino; } catch {}
    if (current !== socketInode) {
      socketInode = null;
      stop("socket path no longer belongs to this service");
    }
  }, OWNERSHIP_CHECK_MS);
  ownershipTimer.unref();

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  try {
    embed = await load(identity.model, batchSize);
    log("model ready");
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
    log(`model failed to load: ${loadError}`);
    for (const connection of connections) if (connection.accepted) announce(connection);
    stop("model failed to load", 1);
    return;
  }
  for (const connection of connections) if (connection.accepted) announce(connection);
  scheduleIdle();
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const socketPath = process.argv[2];
  if (!socketPath) {
    log("usage: embed-service.mjs <socket-path>");
    process.exit(2);
  }
  runService({ socketPath, load: loadEmbedder }).catch((error) => {
    log(`fatal: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  });
}
