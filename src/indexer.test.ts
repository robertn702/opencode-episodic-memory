import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAll, syncSession } from "./indexer";
import { localIndexStore, openConfiguredIndex, openIndex, type IndexStore } from "./store";

const dir = mkdtempSync(join(tmpdir(), "episodic-indexer-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function source(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE session_v2 (id TEXT, project_id TEXT, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)");
  db.run("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
  db.run("INSERT INTO session_v2 VALUES ('ses_private', 'project', NULL, 'Private', '/private', 1, 1, NULL)");
  db.run("INSERT INTO session_message VALUES ('msg_private', 'ses_private', 'user', 1, 1, ?)", [JSON.stringify({ text: "DO NOT INDEX THIS CHAT" })]);
  return db;
}
const session = { id: "ses_private", project_id: "project", parent_id: null, title: "Private", directory: "/private", time_created: 1, time_updated: 1 };

describe("v2 indexer privacy", () => {
  test("purges when the marker appears during remote freshness lookup", async () => {
    const db = source();
    db.run("DELETE FROM session_message");
    const removed: string[] = [];
    let replacements = 0;
    const index = {
      remote: true, sourceId: "privacy-source",
      async getIndexedSession() {
        db.run("INSERT INTO session_message VALUES ('late', 'ses_private', 'user', 2, 2, ?)", [JSON.stringify({ text: "DO NOT INDEX THIS CHAT" })]);
        return { ...session, source_time_updated: 1, indexed_at: 1, status: "indexed-v2" };
      },
      async replaceSessionChunks() { replacements++; },
      async removeSession(id: string) { removed.push(id); },
      async pruneOrphans() { return 0; },
      async search() { return []; }, async textSearch() { return []; },
      async isEmpty() { return false; },
      async stats() { return { sessions: 0, excluded: 0, chunks: 0, oldest: null, newest: null, byDirectory: [] }; },
      async readIndexed() { return []; }, async readIndexedWindow() { return []; }, close() {},
    } satisfies IndexStore;
    try {
      expect(await syncSession(db, index, session)).toBe("excluded");
      expect(removed).toEqual([session.id]);
      expect(replacements).toBe(0);
    } finally { db.close(); }
  });

  test("removes excluded remote metadata and chunks", async () => {
    const previous = { url: process.env.EPISODIC_INDEX_URL, source: process.env.EPISODIC_SOURCE_ID, token: process.env.EPISODIC_INDEX_AUTH_TOKEN };
    const db = source();
    try {
      process.env.EPISODIC_INDEX_URL = `file:${join(dir, "remote.db")}`;
      process.env.EPISODIC_SOURCE_ID = "privacy-source";
      delete process.env.EPISODIC_INDEX_AUTH_TOKEN;
      const index = await openConfiguredIndex();
      try {
        await index.replaceSessionChunks({ ...session, source_time_updated: 1 }, [{ seq: 0, time_created: 1, text: "old content", embedding: new Float32Array([1, 0]) }]);
        expect(await syncSession(db, index, session)).toBe("excluded");
        expect(await index.getIndexedSession(session.id)).toBeNull();
        expect(await index.readIndexed(session.id)).toEqual([]);
      } finally { index.close(); }
    } finally {
      db.close();
      if (previous.url === undefined) delete process.env.EPISODIC_INDEX_URL; else process.env.EPISODIC_INDEX_URL = previous.url;
      if (previous.source === undefined) delete process.env.EPISODIC_SOURCE_ID; else process.env.EPISODIC_SOURCE_ID = previous.source;
      if (previous.token === undefined) delete process.env.EPISODIC_INDEX_AUTH_TOKEN; else process.env.EPISODIC_INDEX_AUTH_TOKEN = previous.token;
    }
  });
});

test("v2 sync refreshes unqualified index statuses and prunes deleted sessions", async () => {
  const db = source();
  const index = localIndexStore(openIndex(join(dir, "transition.db")));
  try {
    db.run("DELETE FROM session_message");
    await index.replaceSessionChunks({ ...session, source_time_updated: 1 }, [], "empty");
    expect(await syncAll(db, index)).toMatchObject({ empty: 1, skippedFresh: 0 });
    expect(await index.getIndexedSession(session.id)).toMatchObject({ status: "empty-v2" });
    expect(await syncAll(db, index)).toMatchObject({ skippedFresh: 1 });
    db.run("DELETE FROM session_v2");
    expect(await syncAll(db, index)).toMatchObject({ pruned: 1 });
    expect(await index.getIndexedSession(session.id)).toBeNull();
  } finally { index.close(); db.close(); }
});

test("syncAll keeps a session indexed concurrently while it ran", async () => {
  const db = source();
  db.run("DELETE FROM session_message");
  const local = localIndexStore(openIndex(join(dir, "concurrent-prune.db")));
  const fresh = { ...session, id: "ses_new", title: "New", source_time_updated: 2 };
  let injected = false;
  // Simulates the plugin indexing a newly settled session mid-backfill.
  const index: IndexStore = Object.create(local, {
    replaceSessionChunks: {
      value: async (...args: Parameters<IndexStore["replaceSessionChunks"]>) => {
        await local.replaceSessionChunks(...args);
        if (injected) return;
        injected = true;
        db.run("INSERT INTO session_v2 VALUES ('ses_new', 'project', NULL, 'New', '/private', 2, 2, NULL)");
        await local.replaceSessionChunks(fresh, [], "empty-v2");
      },
    },
  });
  try {
    expect(await syncAll(db, index)).toMatchObject({ scanned: 1, pruned: 0 });
    expect(await local.getIndexedSession("ses_new")).toMatchObject({ status: "empty-v2" });
  } finally { local.close(); db.close(); }
});

test("syncSession does not overwrite a newer row written while it embedded", async () => {
  const sourcePath = join(dir, "overwrite-source.db");
  const db = new Database(sourcePath);
  db.run("CREATE TABLE session_v2 (id TEXT, project_id TEXT, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)");
  db.run("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
  db.run("INSERT INTO session_v2 VALUES ('ses_race', 'project', NULL, 'Race', '/dir', 1, 1, NULL)");
  db.run("INSERT INTO session_message VALUES ('u', 'ses_race', 'user', 1, 1, ?)", [JSON.stringify({ text: "stale prompt" })]);
  db.run("INSERT INTO session_message VALUES ('a', 'ses_race', 'assistant', 2, 1, ?)", [JSON.stringify({ content: [{ type: "text", text: "stale answer" }] })]);
  db.close();
  // Embedding needs a sidecar; run in a separate host so its process-wide state
  // never leaks into embed.test.ts.
  const script = `
    const { Database } = await import("bun:sqlite");
    const { syncSession } = await import(${JSON.stringify(new URL("./indexer.ts", import.meta.url).pathname)});
    const { getSession } = await import(${JSON.stringify(new URL("./reader.ts", import.meta.url).pathname)});
    const source = new Database(${JSON.stringify(sourcePath)}, { readonly: true });
    const newer = { id: "ses_race", project_id: "project", parent_id: null, title: "Race", directory: "/dir", time_created: 1, source_time_updated: 5, indexed_at: 5, status: "excluded-v2" };
    async function run(lookup, force) {
      let lookups = 0, writes = 0;
      const index = {
        remote: false,
        async getIndexedSession() { return lookup(lookups++); },
        async replaceSessionChunks() { writes++; },
        async removeSession() {},
      };
      const result = await syncSession(source, index, getSession(source, "ses_race"), force);
      return { result, lookups, writes };
    }
    console.log(JSON.stringify({
      // A newer row appeared while embedding: keep it.
      raced: await run((n) => n === 0 ? null : newer, false),
      // The same row before and after: --force rebuilds it even though its watermark is ahead.
      forced: await run(() => ({ ...newer, status: "indexed-v2" }), true),
    }));
    process.exit(0);
  `;
  const host = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      EPISODIC_NODE_BINARY: new URL("../spikes/fake-embed-sidecar.mjs", import.meta.url).pathname,
      EPISODIC_EMBED_MODE: "sidecar",
      EPISODIC_TEST_SIDECAR_LOG: join(dir, "overwrite-sidecar.log"),
      EPISODIC_TEST_SIDECAR_EXIT_ONCE: join(dir, "overwrite-exit-once"),
      EPISODIC_TEST_SIDECAR_STARTUP_ONCE: join(dir, "overwrite-startup-once"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const watchdog = setTimeout(() => host.kill(), 10_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited,
  ]).finally(() => clearTimeout(watchdog));
  if (exitCode !== 0) throw new Error(`isolated indexer host failed (${exitCode}): ${stderr}`);
  expect(JSON.parse(stdout.trim())).toEqual({
    raced: { result: "fresh", lookups: 2, writes: 0 },
    forced: { result: "indexed", lookups: 2, writes: 1 },
  });
});
