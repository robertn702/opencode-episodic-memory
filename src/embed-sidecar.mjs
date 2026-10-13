// Persistent Node-side embedding server. stdout is reserved for NDJSON protocol
// messages; all diagnostics (including dependency chatter) go to stderr.
import { loadEmbedder, MAX_REQUEST_TEXTS, MODEL, positiveIntegerEnv, validRequest } from "./embed-model.mjs";

const originalConsole = globalThis.console;
globalThis.console = {
  ...originalConsole,
  log: (...args) => originalConsole.error(...args),
  info: (...args) => originalConsole.error(...args),
  debug: (...args) => originalConsole.error(...args),
  warn: (...args) => originalConsole.error(...args),
};

const batchSize = positiveIntegerEnv("EPISODIC_EMBED_BATCH_SIZE", 32, MAX_REQUEST_TEXTS);
let embed;
let queue = Promise.resolve();

function send(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function requestError(id, error) {
  send({ id, error: error instanceof Error ? error.message : String(error) });
}

async function initialize() {
  try {
    embed = await loadEmbedder(MODEL, batchSize);
    send({ ready: true });
  } catch (error) {
    send({ ready: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
    process.stdin.destroy();
    throw error;
  }
}

const initialization = initialize();
let remainder = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  let newline;
  while ((newline = remainder.indexOf("\n")) >= 0) {
    const line = remainder.slice(0, newline);
    remainder = remainder.slice(newline + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      requestError(null, "request must be valid JSON");
      continue;
    }
    if (!validRequest(request)) {
      requestError(request && typeof request === "object" && "id" in request ? request.id : null, `request must have an integer id and at most ${MAX_REQUEST_TEXTS} string texts`);
      continue;
    }
    queue = queue.then(async () => {
      try {
        await initialization;
        send({ id: request.id, vectors: await embed(request.texts) });
      } catch (error) {
        requestError(request.id, error);
      }
    });
  }
});
process.stdin.on("error", () => process.exit());
process.stdin.on("end", () => process.exit());
process.on("SIGTERM", () => process.exit());
process.on("SIGINT", () => process.exit());

await initialization.catch(() => {});
