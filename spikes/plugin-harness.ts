// Simulates the OpenCode plugin runtime: mock ctx, call the factory,
// exercise the event hook and both tools.
// Uses a throwaway index DB in /tmp so the live index is never touched.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EPISODIC_INDEX_DB = join(mkdtempSync(join(tmpdir(), "episodic-harness-")), "index.db");

import EpisodicMemory from "../plugin/episodic-memory";
import type { PluginInput, ToolContext } from "@opencode-ai/plugin";

// The plugin only reads client.app.log; the rest of PluginInput is a large
// generated SDK surface we don't reconstruct here. Structurally typed (not any).
const mockClient = {
  app: {
    log: async (input: { body: { level: string; message: string } }) =>
      console.log(`[log:${input.body.level}]`, input.body.message),
  },
};

// The factory only destructures `client`, but its parameter is the full
// PluginInput. Widen the minimal stub once — the only assertion in this harness.
const mockInput = { client: mockClient } as unknown as PluginInput;

const hooks = await EpisodicMemory(mockInput);

console.log("hooks registered:", Object.keys(hooks));
if (!hooks.tool) throw new Error("plugin registered no tools");
if (!hooks.event) throw new Error("plugin registered no event hook");
console.log("tools:", Object.keys(hooks.tool));

// A minimal but complete ToolContext for invoking tools directly.
const ctx: ToolContext = {
  sessionID: "harness",
  messageID: "harness",
  agent: "harness",
  directory: process.cwd(),
  worktree: process.cwd(),
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
};

// 1. event hook (session.idle for a real session id)
const { openSource, listSessions } = await import("../src/reader");
const source = openSource();
const sessions = listSessions(source);
const target = sessions[sessions.length - 1];
await hooks.event({
  event: { type: "session.idle", properties: { sessionID: target.id } },
});
// give the fire-and-forget reindex a tick to start
await new Promise((r) => setTimeout(r, 500));
console.log("event hook OK (reindex fired for", target.id + ")");

// 2. episodic_search
const result = await hooks.tool.episodic_search.execute(
  { query: "episodic memory architecture decisions", limit: 3 },
  ctx
);
console.log("=== episodic_search ===");
console.log(typeof result === "string" ? result.slice(0, 900) : result);

// 3. episodic_read (indexed fallback path, no live DB dependency)
const out = await hooks.tool.episodic_read.execute(
  { session_id: target.id, indexed: true },
  ctx
);
console.log("=== episodic_read (indexed) ===");
console.log(typeof out === "string" ? out.slice(0, 400) : out);

console.log("\nPlugin harness OK.");
process.exit(0);
