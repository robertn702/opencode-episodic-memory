// Persistent Node-side embedding server. stdout is reserved for NDJSON protocol
// messages; all diagnostics (including dependency chatter) go to stderr.
const originalConsole = globalThis.console;
globalThis.console = {
  ...originalConsole,
  log: (...args) => originalConsole.error(...args),
  info: (...args) => originalConsole.error(...args),
  debug: (...args) => originalConsole.error(...args),
  warn: (...args) => originalConsole.error(...args),
};

const model = process.env.EPISODIC_EMBED_MODEL ?? "Snowflake/snowflake-arctic-embed-m-v1.5";
let embedder;
let queue = Promise.resolve();

function send(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function requestError(id, error) {
  send({ id, error: error instanceof Error ? error.message : String(error) });
}

function validRequest(value) {
  return value && typeof value === "object" && Number.isSafeInteger(value.id)
    && Array.isArray(value.texts) && value.texts.every((text) => typeof text === "string");
}

async function embed(texts) {
  const output = await embedder(texts, { pooling: "cls", normalize: true });
  const dimensions = output.dims.at(-1);
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new Error("model returned invalid embedding dimensions");
  const data = output.data;
  if (data.length !== texts.length * dimensions) throw new Error("model returned an invalid embedding batch");
  const vectors = [];
  for (let index = 0; index < texts.length; index++) {
    vectors.push(Array.from(data.slice(index * dimensions, (index + 1) * dimensions)));
  }
  return vectors;
}

async function initialize() {
  try {
    const { pipeline } = await import("@huggingface/transformers");
    embedder = await pipeline("feature-extraction", model, { dtype: "q8" });
    send({ ready: true });
  } catch (error) {
    send({ ready: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
    process.stdin.destroy();
  }
}

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
      requestError(request && typeof request === "object" && "id" in request ? request.id : null, "request must have an integer id and an array of string texts");
      continue;
    }
    queue = queue.then(async () => {
      try {
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

await initialize();
