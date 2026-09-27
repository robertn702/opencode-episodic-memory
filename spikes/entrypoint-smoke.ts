// Verify V1 and V2 loader selection of the same ./server path.
// Usage: bun run spikes/entrypoint-smoke.ts [packageDir]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2] ?? process.cwd();
const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
const v1Entry = pkg.main;
const v2Entry = pkg.exports?.["./server"];
if (typeof v1Entry !== "string" || typeof v2Entry !== "string") {
  throw new Error("Expected V1 main and shared ./server export");
}

// Import the resolved files just as the two hosts do (rather than trusting a
// package self-reference, which may resolve differently in the checkout).
const v1 = await import(pathToFileURL(resolve(dir, v1Entry)).href);
const v2 = await import(pathToFileURL(resolve(dir, v2Entry)).href);
if (typeof v1.default !== "function" || v2.default?.id !== "episodic-memory" || typeof v2.default.setup !== "function" || typeof v2.default.server !== "function") {
  throw new Error("Entrypoints do not expose the expected V1 factory and V2 definition");
}
const old = await v1.default({ client: { app: { log: async () => {} } } });
const selectedByV1_18_32 = await v2.default.server({ client: { app: { log: async () => {} } } });
const names = Object.keys(old.tool ?? {}).sort();
if (Object.keys(selectedByV1_18_32.tool ?? {}).sort().join(",") !== names.join(",")) throw new Error("V1 1.18.32 server selector differs from legacy V1 main");
const definitions: Array<{ name: string; input: { properties?: Record<string, unknown>; required?: string[] }; execute: Function }> = [];
let subscriptionSignal: AbortSignal | undefined;
const ctx = {
  location: { directory: dir },
  tool: { transform: async (edit: Function) => {
    edit({ add: (definition: typeof definitions[number]) => definitions.push(definition) });
    return { dispose: async () => {} };
  } },
  event: { subscribe: ({ signal }: { signal: AbortSignal }) => {
    subscriptionSignal = signal;
    return { async *[Symbol.asyncIterator]() { await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true })); } };
  } },
};
const cleanup = await v2.default.setup(ctx);
const expected = ["episodic_read_session", "episodic_read_window", "episodic_search"];
if (names.join(",") !== expected.join(",") || definitions.map((d) => d.name).sort().join(",") !== names.join(",")) {
  throw new Error("Entrypoints registered different public tool names");
}
for (const definition of definitions) {
  const legacy = old.tool[definition.name];
  if (Object.keys(definition.input.properties ?? {}).sort().join(",") !== Object.keys(legacy.args).sort().join(",")) {
    throw new Error(`V2 args differ from V1 for ${definition.name}`);
  }
  const required = Object.entries(legacy.args)
    .filter(([, schema]) => typeof schema === "object" && schema !== null && "isOptional" in schema && typeof schema.isOptional === "function" && !schema.isOptional())
    .map(([name]) => name).sort();
  if (definition.input.required?.slice().sort().join(",") !== required.join(",")) {
    throw new Error(`V2 required args differ from V1 for ${definition.name}`);
  }
  if (typeof definition.execute !== "function" || !Array.isArray(definition.input.required)) {
    throw new Error(`V2 tool ${definition.name} lacks an executor or JSON Schema`);
  }
}
if (!subscriptionSignal || typeof cleanup !== "function") throw new Error("V2 did not subscribe or register cleanup");
await cleanup();
if (!subscriptionSignal.aborted) throw new Error("V2 cleanup did not abort its event stream");
console.log(`V1 legacy main: ${v1Entry}; shared server (V1 1.18.32 / V2 2.0.18): ${v2Entry}`);
console.log(`Both entrypoints registered: ${names.join(", ")}`);
console.log("ENTRYPOINT SMOKE OK");
