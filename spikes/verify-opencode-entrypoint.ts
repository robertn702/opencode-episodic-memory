// Pre-publish guard: replicate OpenCode's npm-plugin server-entrypoint
// resolution (plugin/shared.ts `resolvePackageEntrypoint`, kind="server") and
// confirm the resolved entry loads and registers the memory tools.
//
// Why this exists: OpenCode SILENTLY skips a plugin when its package.json has
// neither exports["./server"] nor main — the loader marks it "missing" and the
// report callback is an empty function, so nothing is logged anywhere. The
// pack-smoke import test used `import("opencode-episodic-memory")`, which
// resolves via exports["."] — so the package could import fine yet never load
// in OpenCode. This script tests the resolution OpenCode actually performs.
//
// Usage:
//   bun run spikes/verify-opencode-entrypoint.ts [packageDir]
// Defaults to the repo root; pack-smoke passes the clean-installed package dir.
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const dir = process.argv[2] ?? process.cwd();
const pkgJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

// --- mirror opencode's logic (packages/opencode/src/plugin/shared.ts) ---
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function extractExportValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  for (const key of ["import", "default"]) {
    const nested = value[key];
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

function resolveServerEntrypoint(pkg: Record<string, unknown>): string | undefined {
  const exportsField = pkg.exports;
  if (isRecord(exportsField)) {
    const raw = extractExportValue(exportsField["./server"]);
    if (raw) return raw;
  }
  // kind === "server" falls back to pkg.main when ./server is absent.
  const main = pkg.main;
  if (typeof main === "string" && main.trim()) return main.trim();
  return undefined;
}
// --- end mirror ---

const entry = resolveServerEntrypoint(pkgJson);
if (!entry) {
  throw new Error(
    `No OpenCode server entrypoint for ${pkgJson.name}@${pkgJson.version}:\n` +
      `  package.json has neither exports["./server"] nor main.\n` +
      `  OpenCode will SILENTLY SKIP this plugin (loader "missing" stage, no error logged).\n` +
      `  Fix: add "main": "./plugin/episodic-memory.ts" (or exports["./server"]).`,
  );
}
console.log("server entrypoint:", entry);

// Resolve relative to the package dir and import it, as OpenCode's loader does
// (import(fileURL) of the resolved entry). Confirms the entry is real and loads.
const entryPath = entry.startsWith("file://") ? entry : isAbsolute(entry) ? entry : resolve(dir, entry);
const mod = await import(entryPath);
const factory = mod.default ?? mod.EpisodicMemory;
if (typeof factory !== "function") {
  throw new Error("resolved entry does not export a plugin factory (default / EpisodicMemory)");
}

const hooks = await factory({ client: { app: { log: async () => {} } } });
const tools = Object.keys(hooks.tool ?? {});
for (const required of ["episodic_search", "episodic_read"]) {
  if (!tools.includes(required)) {
    throw new Error(`resolved entry missing tool "${required}" (got: ${tools.join(", ") || "none"})`);
  }
}
console.log("tools registered:", tools.join(", "));
console.log("OPENCODE ENTRYPOINT OK");
