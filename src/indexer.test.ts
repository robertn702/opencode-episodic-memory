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
