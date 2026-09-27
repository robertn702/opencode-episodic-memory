import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAll, syncSession } from "./indexer";
import { localIndexStore, openConfiguredIndex, openIndex, type IndexStore } from "./store";

const dir = mkdtempSync(join(tmpdir(), "episodic-indexer-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function sourceWithExcludedSession(): Database {
  const source = new Database(":memory:");
  source.run("CREATE TABLE session (id TEXT, project_id TEXT, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)");
  source.run("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
  source.run("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
  source.run("INSERT INTO session VALUES ('ses_private', 'project', NULL, 'Private', '/private', 1, 1, NULL)");
  source.run("INSERT INTO message VALUES ('msg_private', 'ses_private', 1, ?)", [JSON.stringify({ role: "user" })]);
  source.run("INSERT INTO part VALUES ('part_private', 'msg_private', 'ses_private', 1, ?)", [JSON.stringify({ type: "text", text: "DO NOT INDEX THIS CHAT" })]);
  return source;
}

describe("syncSession remote privacy", () => {
  test("purges when the marker appears during the remote freshness lookup", async () => {
    const source = new Database(":memory:");
    source.run("CREATE TABLE session (id TEXT, project_id TEXT, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)");
    source.run("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
    source.run("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
    source.run("INSERT INTO session VALUES ('ses_race', 'project', NULL, 'Race', '/tmp', 1, 1, NULL)");
    source.run("INSERT INTO message VALUES ('msg_race', 'ses_race', 1, ?)", [JSON.stringify({ role: "user" })]);
    const removed: string[] = [];
    let replacements = 0;
    const index = {
      remote: true,
      sourceId: "privacy-source",
      async getIndexedSession() {
        source.run("INSERT INTO part VALUES ('part_race', 'msg_race', 'ses_race', 1, ?)", [JSON.stringify({ type: "text", text: "DO NOT INDEX THIS CHAT" })]);
        return { id: "ses_race", project_id: "project", parent_id: null, title: "Race", directory: "/tmp", time_created: 1, source_time_updated: 1, indexed_at: 1, status: "indexed" };
      },
      async replaceSessionChunks() { replacements++; },
      async removeSession(id: string) { removed.push(id); },
      async pruneOrphans() { return 0; },
      async search() { return []; },
      async textSearch() { return []; },
      async isEmpty() { return false; },
      async stats() { return { sessions: 0, excluded: 0, chunks: 0, oldest: null, newest: null, byDirectory: [] }; },
      async readIndexed() { return []; },
      async readIndexedWindow() { return []; },
      close() {},
    } satisfies IndexStore;
    const session = { id: "ses_race", project_id: "project", parent_id: null, title: "Race", directory: "/tmp", time_created: 1, time_updated: 1 };
    try {
      expect(await syncSession(source, index, session)).toBe("excluded");
      expect(removed).toEqual(["ses_race"]);
      expect(replacements).toBe(0);
    } finally {
      source.close();
    }
  });

  test("removes an excluded session instead of uploading a remote tombstone", async () => {
    const original = { url: process.env.EPISODIC_INDEX_URL, source: process.env.EPISODIC_SOURCE_ID, token: process.env.EPISODIC_INDEX_AUTH_TOKEN };
    const source = sourceWithExcludedSession();
    try {
      process.env.EPISODIC_INDEX_URL = `file:${join(dir, "remote.db")}`;
      process.env.EPISODIC_SOURCE_ID = "privacy-source";
      delete process.env.EPISODIC_INDEX_AUTH_TOKEN;
      const index = await openConfiguredIndex();
      const session = { id: "ses_private", project_id: "project", parent_id: null, title: "Private", directory: "/private", time_created: 1, time_updated: 1 };
      await index.replaceSessionChunks({ ...session, source_time_updated: session.time_updated }, [{ seq: 0, time_created: 1, text: "old content", embedding: new Float32Array([1, 0]) }]);
      expect(await syncSession(source, index, session)).toBe("excluded");
      expect(await index.getIndexedSession("ses_private")).toBeNull();
      expect(await index.readIndexed("ses_private")).toEqual([]);
      index.close();
    } finally {
      source.close();
      if (original.url === undefined) delete process.env.EPISODIC_INDEX_URL; else process.env.EPISODIC_INDEX_URL = original.url;
      if (original.source === undefined) delete process.env.EPISODIC_SOURCE_ID; else process.env.EPISODIC_SOURCE_ID = original.source;
      if (original.token === undefined) delete process.env.EPISODIC_INDEX_AUTH_TOKEN; else process.env.EPISODIC_INDEX_AUTH_TOKEN = original.token;
    }
  });
});

test("V1 to V2 transition reprocesses unchanged timestamps and prunes only after layout validation", async () => {
  const source = new Database(":memory:");
  const index = localIndexStore(openIndex(join(dir, "transition.db")));
  try {
    source.run("CREATE TABLE session (id TEXT, project_id TEXT, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)");
    source.run("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
    source.run("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
    source.run("INSERT INTO session VALUES ('ses_transition', 'project', NULL, 'Old', '/tmp', 1, 1, NULL)");
    source.run("CREATE TABLE session_v2 (id TEXT, project_id TEXT, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)");
    source.run("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
    source.run("INSERT INTO session_v2 VALUES ('ses_transition', 'project', NULL, 'New', '/tmp', 1, 1, NULL)");
    source.run("INSERT INTO session VALUES ('ses_pending', 'project', NULL, 'Pending', '/tmp', 2, 2, NULL)");
    await index.replaceSessionChunks({ id: 'ses_transition', project_id: 'project', parent_id: null, title: 'Old', directory: '/tmp', time_created: 1, source_time_updated: 1 }, [], 'empty');
    expect(await syncAll(source, index)).toMatchObject({ indexed: 0, empty: 2, skippedFresh: 0, pruned: 0 });
    expect(await index.getIndexedSession('ses_transition')).toMatchObject({ status: 'empty-v2', title: 'New' });
    expect(await index.getIndexedSession('ses_pending')).toMatchObject({ status: 'empty' });
    source.run("INSERT INTO session_v2 VALUES ('ses_pending', 'project', NULL, 'Migrated', '/tmp', 2, 2, NULL)");
    expect(await syncAll(source, index)).toMatchObject({ skippedFresh: 1, empty: 1 });
    expect(await index.getIndexedSession('ses_pending')).toMatchObject({ status: 'empty-v2', title: 'Migrated' });
    source.run("DELETE FROM session_v2");
    expect(await syncAll(source, index)).toMatchObject({ skippedFresh: 0, empty: 2, pruned: 0 });
    source.run("DELETE FROM session");
    expect(await syncAll(source, index)).toMatchObject({ pruned: 2 });
    expect(await index.getIndexedSession('ses_transition')).toBeNull();
    source.run("DROP TABLE session_message");
    await index.replaceSessionChunks({ id: 'ses_transition', project_id: 'project', parent_id: null, title: 'Old', directory: '/tmp', time_created: 1, source_time_updated: 1 }, [], 'empty');
    await expect(syncAll(source, index)).rejects.toThrow('Incomplete OpenCode source layout');
    expect(await index.getIndexedSession('ses_transition')).not.toBeNull();
  } finally { index.close(); source.close(); }
});
