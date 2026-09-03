// Simulates the OpenCode plugin runtime: mock ctx, call the factory,
// exercise the event hook and all tools.
// Uses throwaway source and index DBs in /tmp so live data is never touched.
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const harnessDir = mkdtempSync(join(tmpdir(), "episodic-harness-"));
const sourcePath = join(harnessDir, "opencode.db");
process.env.EPISODIC_SOURCE_DB = sourcePath;
process.env.EPISODIC_INDEX_DB = join(harnessDir, "index.db");

const fixture = new Database(sourcePath);
fixture.run(`CREATE TABLE session (
  id TEXT, project_id TEXT, parent_id TEXT, title TEXT, directory TEXT,
  time_created INTEGER, time_updated INTEGER, time_archived INTEGER
)`);
fixture.run(`CREATE TABLE message (
  id TEXT, session_id TEXT, time_created INTEGER, data TEXT
)`);
fixture.run(`CREATE TABLE part (
  id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT
)`);
const sessionId = "ses_harness";
const created = Date.UTC(2026, 0, 2);
fixture.run(
  `INSERT INTO session
   (id, project_id, parent_id, title, directory, time_created, time_updated, time_archived)
   VALUES (?, ?, NULL, ?, ?, ?, ?, NULL)`,
  [sessionId, "proj_harness", "Episodic memory architecture", process.cwd(), created, created]
);
fixture.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)", [
  "msg_before",
  sessionId,
  created - 1,
  JSON.stringify({ role: "assistant" }),
]);
fixture.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)", [
  "msg_user",
  sessionId,
  created,
  JSON.stringify({ role: "user" }),
]);
fixture.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)", [
  "msg_assistant",
  sessionId,
  created + 1,
  JSON.stringify({ role: "assistant" }),
]);
fixture.run(
  "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
  [
    "part_user",
    "msg_user",
    sessionId,
    created,
    JSON.stringify({ type: "text", text: "How should episodic memory architecture work?" }),
  ]
);
fixture.run(
  "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
  [
    "part_before",
    "msg_before",
    sessionId,
    created - 1,
    JSON.stringify({ type: "text", text: "x".repeat(7_000) }),
  ]
);
fixture.run(
  "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
  [
    "part_assistant",
    "msg_assistant",
    sessionId,
    created + 1,
    JSON.stringify({ type: "text", text: "Use local embeddings and a SQLite index." }),
  ]
);
fixture.close();

import EpisodicMemory from "../plugin/episodic-memory";
import type { PluginInput, ToolContext } from "@opencode-ai/plugin";

// The plugin only reads client.app.log; the rest of PluginInput is a large
// generated SDK surface we don't reconstruct here. Structurally typed (not any).
// Captured log messages let the harness observe the fire-and-forget reindex.
const logMessages: string[] = [];
const mockClient = {
  app: {
    log: async (input: { body: { level: string; message: string } }) => {
      logMessages.push(input.body.message);
      console.log(`[log:${input.body.level}]`, input.body.message);
    },
  },
};

// The factory only destructures `client`, but its parameter is the full
// PluginInput. Widen the minimal stub once — the only assertion in this harness.
const mockInput = { client: mockClient } as unknown as PluginInput;

const hooks = await EpisodicMemory(mockInput);

console.log("hooks registered:", Object.keys(hooks));
if (!hooks.tool) throw new Error("plugin registered no tools");
if (!hooks.event) throw new Error("plugin registered no event hook");
const tools = hooks.tool;
console.log("tools:", Object.keys(hooks.tool));
const expectedToolNames = ["episodic_read_session", "episodic_read_window", "episodic_search"];
const actualToolNames = Object.keys(tools).sort();
if (actualToolNames.join(",") !== expectedToolNames.join(",")) {
  throw new Error(`harness error: unexpected public tools (got: ${actualToolNames.join(", ") || "none"})`);
}

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

// Live reads must not touch the index at all. Point it at an impossible nested
// path before either live tool runs; restore it before exercising indexing.
const validIndexPath = process.env.EPISODIC_INDEX_DB;
const blockedIndexParent = join(harnessDir, "not-a-directory");
writeFileSync(blockedIndexParent, "blocked");
process.env.EPISODIC_INDEX_DB = join(blockedIndexParent, "index.db");
const preIndexWindow = await tools.episodic_read_window.execute(
  { session_id: sessionId, anchor_message_id: "msg_user" },
  ctx
);
const preIndexSession = await tools.episodic_read_session.execute({ session_id: sessionId }, ctx);
if (typeof preIndexWindow !== "string" || typeof preIndexSession !== "string") throw new Error("harness error: live reads unexpectedly needed the index");
process.env.EPISODIC_INDEX_DB = validIndexPath;

// 1. event hook (session.idle for the fixture session)
const { openSource, listSessions } = await import("../src/reader");
const source = openSource();
const sessions = listSessions(source);
if (sessions.length !== 1 || sessions[0].id !== sessionId) throw new Error("harness error: fixture session missing");
const target = sessions[0];
await Promise.all([
  hooks.event({ event: { type: "session.idle", properties: { sessionID: target.id } } }),
  hooks.event({ event: { type: "session.idle", properties: { sessionID: target.id } } }),
]);
// The reindex is fire-and-forget; poll the captured plugin logs (bounded) for
// both completion markers. The second overlapping idle must queue one rerun,
// not disappear behind the in-flight debounce.
const REINDEX_TIMEOUT_MS = 30_000;
const deadline = Date.now() + REINDEX_TIMEOUT_MS;
let reindexMessages: string[] = [];
while (Date.now() < deadline) {
  reindexMessages = logMessages.filter((m) => m.startsWith("reindexed ") || m.startsWith("reindex failed"));
  if (reindexMessages.length >= 2) break;
  await new Promise((r) => setTimeout(r, 100));
}
if (reindexMessages.length < 2) throw new Error(`harness error: queued reindex did not complete within ${REINDEX_TIMEOUT_MS}ms`);
const failedReindex = reindexMessages.find((message) => message.startsWith("reindex failed"));
if (failedReindex) throw new Error(`harness error: ${failedReindex}`);
console.log(`event hook OK (${reindexMessages.join(", ")})`);

// 2. episodic_search
const result = await tools.episodic_search.execute(
  { query: "episodic memory architecture decisions", limit: 3 },
  ctx
);
if (typeof result !== "string" || !result.includes(sessionId) || !result.includes("local embeddings")) {
  throw new Error("harness error: episodic_search did not return the fixture conversation");
}
if (!result.includes("anchor: msg_user")) {
  throw new Error("harness error: episodic_search did not return a usable context anchor");
}
console.log("=== episodic_search ===");
console.log(result.slice(0, 900));

// 3. episodic_read_window (search-result anchor -> bounded live window)
const context = await tools.episodic_read_window.execute(
  { session_id: target.id, anchor_message_id: "msg_user", before: 1, after: 1 },
  ctx
);
if (typeof context !== "string" || !context.includes("... [truncated]") || !context.includes("msg_before") || !context.includes("msg_user") || !context.includes("(anchor)") || !context.includes("local embeddings")) {
  throw new Error("harness error: episodic_read_window did not return the anchored fixture window");
}
console.log("=== episodic_read_window ===");
console.log(context.slice(0, 400));

async function expectWindowError(args: { session_id: string; anchor_message_id: string; before?: number; after?: number }, text: string): Promise<void> {
  try {
    await tools.episodic_read_window.execute(args, ctx);
  } catch (error) {
    if (error instanceof Error && error.message.includes(text)) return;
    throw error;
  }
  throw new Error(`harness error: expected episodic_read_window error containing ${text}`);
}

await expectWindowError({ session_id: "missing", anchor_message_id: "msg_user" }, "No live conversation");
await expectWindowError({ session_id: target.id, anchor_message_id: "stale" }, "stale or invalid");
await expectWindowError({ session_id: target.id, anchor_message_id: "msg_user", before: -1 }, "non-negative integers");

// 4. episodic_read_session (indexed fallback path, no live DB dependency)
const out = await tools.episodic_read_session.execute(
  { session_id: target.id, indexed: true },
  ctx
);
if (typeof out !== "string" || !out.includes("How should episodic memory architecture work?") || !out.includes("local embeddings")) {
  throw new Error("harness error: episodic_read_session did not return the indexed fixture transcript");
}
console.log("=== episodic_read_session (indexed) ===");
console.log(out.slice(0, 400));

const privateFixture = new Database(sourcePath);
privateFixture.run("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)", [
  "part_private", "msg_user", sessionId, created + 2, JSON.stringify({ type: "text", text: "DO NOT INDEX THIS CHAT" }),
]);
privateFixture.close();
await expectWindowError({ session_id: target.id, anchor_message_id: "msg_user" }, "private");

console.log("\nPlugin harness OK.");
process.exit(0);
