// Verify the v2 plugin definition and tool registration without starting OpenCode.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2] ?? process.cwd();
const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
const entry = pkg.exports?.["./server"];
if (typeof entry !== "string" || pkg.main !== entry || pkg.exports?.["."] !== entry) {
  throw new Error("v2 main, root, and server entrypoints must agree");
}
const mod = await import(pathToFileURL(resolve(dir, entry)).href);
if (mod.default?.id !== "episodic-memory" || typeof mod.default.setup !== "function" || "server" in mod.default) {
  throw new Error("server entrypoint must expose a v2-only plugin definition");
}
const definitions: Array<{ name: string; input: { properties?: Record<string, unknown>; required?: string[] }; execute: Function }> = [];
let signal: AbortSignal | undefined;
const ctx = {
  location: { directory: dir },
  tool: { transform: async (edit: Function) => {
    edit({ add: (definition: typeof definitions[number]) => definitions.push(definition) });
    return { dispose: async () => {} };
  } },
  event: { subscribe: ({ signal: value }: { signal: AbortSignal }) => {
    signal = value;
    return { async *[Symbol.asyncIterator]() {
      await new Promise<void>((done) => value.addEventListener("abort", () => done(), { once: true }));
    } };
  } },
};
const cleanup = await mod.default.setup(ctx);
const names = definitions.map((d) => d.name).sort();
if (names.join(",") !== "episodic_read_session,episodic_read_window,episodic_search") {
  throw new Error(`Unexpected tools: ${names.join(",")}`);
}
for (const definition of definitions) {
  if (typeof definition.execute !== "function" || !Array.isArray(definition.input.required)) {
    throw new Error(`Missing executor or JSON Schema for ${definition.name}`);
  }
}
if (!signal || typeof cleanup !== "function") throw new Error("Missing event subscription or cleanup");
await cleanup();
if (!signal.aborted) throw new Error("Cleanup did not abort event stream");
console.log(`V2 entrypoint OK: ${names.join(", ")}`);
