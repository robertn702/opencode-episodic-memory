import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIndexedSession, openIndex } from "../src/store";
import { formatLogLine, openCodeLogFile } from "./log";
import v2 from "./v2";

const root = mkdtempSync(join(tmpdir(), "episodic-plugin-v2-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const controlled = ["XDG_DATA_HOME", "EPISODIC_SOURCE_DB", "EPISODIC_INDEX_DB", "EPISODIC_INDEX_URL", "EPISODIC_SOURCE_ID", "EPISODIC_INDEX_AUTH_TOKEN"] as const;
const original = new Map(controlled.map((name) => [name, process.env[name]]));
let dir = "";
let source: Database;

beforeEach(() => {
  dir = mkdtempSync(join(root, "case-"));
  process.env.XDG_DATA_HOME = dir;
  process.env.EPISODIC_SOURCE_DB = join(dir, "opencode.db");
  process.env.EPISODIC_INDEX_DB = join(dir, "index.db");
  delete process.env.EPISODIC_INDEX_URL;
  delete process.env.EPISODIC_SOURCE_ID;
  delete process.env.EPISODIC_INDEX_AUTH_TOKEN;
  source = new Database(process.env.EPISODIC_SOURCE_DB);
  source.run("CREATE TABLE session_v2 (id TEXT, project_id TEXT, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)");
  source.run("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
});
afterEach(() => {
  source.close();
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// Sessions without exchanges index as "empty" without embedding, so these tests
// never start a sidecar; the index row alone proves syncSession ran.
function addSession(id: string) {
  source.run("INSERT INTO session_v2 VALUES (?, 'project', NULL, ?, '/dir', 1, 1, NULL)", [id, id]);
}

function indexed(id: string): string | undefined {
  if (!existsSync(process.env.EPISODIC_INDEX_DB!)) return undefined;
  const index = openIndex(process.env.EPISODIC_INDEX_DB);
  try {
    return getIndexedSession(index, id)?.status;
  } finally {
    index.close();
  }
}

function logText(): string {
  const file = openCodeLogFile("latest");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

async function waitFor(predicate: () => boolean, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition not met; log was:\n${logText()}`);
}

// A controllable stand-in for ctx.event.subscribe, shaped like OpenCode 2.0.x events.
function eventStream() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  return {
    push(event: unknown) {
      queue.push(event);
      wake?.();
    },
    subscribe({ signal }: { signal: AbortSignal }) {
      return {
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (queue.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve;
                signal.addEventListener("abort", () => resolve(), { once: true });
              });
              continue;
            }
            yield queue.shift();
          }
        },
      };
    },
  };
}

async function start(subscribe: (options: { signal: AbortSignal }) => AsyncIterable<unknown>) {
  const ctx = {
    app: { name: "test", version: "0", channel: "latest" },
    tool: { transform: async () => ({ dispose: async () => {} }) },
    event: { subscribe },
  };
  // @ts-expect-error -- partial plugin context: only the domains setup uses.
  const cleanup = await v2.setup(ctx);
  if (typeof cleanup !== "function") throw new Error("setup must return cleanup");
  return cleanup;
}

const settled = (type: string, sessionID: string, extra: Record<string, unknown> = {}) => ({
  id: `evt_${type}_${sessionID}`, type, created: Date.now(), durable: { aggregateID: sessionID, seq: 1, version: 1 },
  data: { sessionID, ...extra },
});

describe("v2 plugin reindex trigger", () => {
  test("reindexes a session when OpenCode v2 reports its execution settled", async () => {
    const events = eventStream();
    const cleanup = await start(events.subscribe);
    try {
      await waitFor(() => logText().includes("reindexed __all__"));
      addSession("ses_done");
      addSession("ses_failed");
      addSession("ses_stopped");
      addSession("ses_shutdown");
      addSession("ses_superseded");
      events.push(settled("session.execution.interrupted", "ses_shutdown", { reason: "shutdown" }));
      events.push(settled("session.execution.interrupted", "ses_superseded", { reason: "superseded" }));
      events.push(settled("session.execution.succeeded", "ses_done"));
      events.push(settled("session.execution.failed", "ses_failed", { error: { type: "unknown", message: "boom" } }));
      events.push(settled("session.execution.interrupted", "ses_stopped", { reason: "user" }));
      // The log line is written after the index row, so wait for both.
      await waitFor(() => ["ses_done", "ses_failed", "ses_stopped"].every((id) =>
        indexed(id) === "empty-v2" && logText().includes(`message="[episodic-memory] reindexed ${id}"`)));
      expect(indexed("ses_shutdown")).toBeUndefined();
      expect(indexed("ses_superseded")).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test("backfills a local index on startup without waiting for an event", async () => {
    addSession("ses_missed");
    const cleanup = await start(eventStream().subscribe);
    try {
      await waitFor(() => indexed("ses_missed") === "empty-v2" && logText().includes("reindexed __all__"));
      expect(logText()).toContain("started; backfilling local index");
    } finally {
      await cleanup();
    }
  });

  test("skips the startup backfill for a remote index and says how to backfill", async () => {
    process.env.EPISODIC_INDEX_URL = `file:${join(dir, "remote.db")}`;
    process.env.EPISODIC_SOURCE_ID = "test-source";
    addSession("ses_remote");
    const cleanup = await start(eventStream().subscribe);
    try {
      await waitFor(() => logText().includes("no startup backfill"));
      // A wrongly started backfill would open the index and log shortly after.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(existsSync(join(dir, "remote.db"))).toBe(false);
      expect(logText()).not.toContain("reindexed");
    } finally {
      await cleanup();
    }
  });

  test("records subscription failures in the OpenCode log", async () => {
    const cleanup = await start(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error("stream exploded");
      },
    }));
    try {
      await waitFor(() => logText().includes("event subscription failed: Error: stream exploded") && logText().includes("reindexed __all__"));
      expect(logText()).toMatch(/level=WARN service=episodic-memory message="\[episodic-memory\] event subscription failed/);
    } finally {
      await cleanup();
    }
  });
});

describe("plugin log channel", () => {
  test("targets the file OpenCode writes for the app channel", () => {
    expect(openCodeLogFile("latest", { XDG_DATA_HOME: "/data" })).toBe("/data/opencode/log/opencode.log");
    expect(openCodeLogFile("local", { XDG_DATA_HOME: "/data" })).toBe("/data/opencode/log/opencode-local.log");
  });

  test("formats one key=value line and escapes multi-line messages", () => {
    const line = formatLogLine("warn", "reindex failed:\nboom", new Date(0));
    expect(line).toBe('timestamp=1970-01-01T00:00:00.000Z level=WARN service=episodic-memory message="[episodic-memory] reindex failed:\\nboom"\n');
  });
});
