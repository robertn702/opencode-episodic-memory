// Simulates the OpenCode plugin runtime: mock ctx, call the factory,
// exercise the event hook and both tools.
import EpisodicMemory from "../plugin/episodic-memory";

const mockClient = {
  app: { log: async ({ body }: any) => console.log(`[log:${body.level}]`, body.message) },
} as any;

const hooks = await EpisodicMemory({
  client: mockClient,
  project: {},
  directory: process.cwd(),
  worktree: process.cwd(),
  $: {},
} as any);

console.log("hooks registered:", Object.keys(hooks));
console.log("tools:", Object.keys((hooks as any).tool));

// 1. event hook (session.idle for a real session id)
const { openSource, listSessions } = await import("../src/reader");
const source = openSource();
const sessions = listSessions(source);
const target = sessions[sessions.length - 1];
await (hooks as any).event({
  event: { type: "session.idle", properties: { sessionID: target.id } },
});
// give the fire-and-forget reindex a tick to start
await new Promise((r) => setTimeout(r, 500));
console.log("event hook OK (reindex fired for", target.id + ")");

// 2. episodic_search
const searchTool = (hooks as any).tool.episodic_search;
const result = await searchTool.execute(
  { query: "episodic memory architecture decisions", limit: 3 },
  { directory: process.cwd(), worktree: process.cwd() } as any
);
console.log("=== episodic_search ===");
console.log(result.slice(0, 900));

// 3. episodic_read (indexed fallback path, no live DB dependency)
const readTool = (hooks as any).tool.episodic_read;
const out = await readTool.execute(
  { session_id: target.id, indexed: true },
  { directory: process.cwd(), worktree: process.cwd() } as any
);
console.log("=== episodic_read (indexed) ===");
console.log(out.slice(0, 400));

console.log("\nPlugin harness OK.");
process.exit(0);
