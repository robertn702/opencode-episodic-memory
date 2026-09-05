import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canLiveRead, openIndex, replaceSessionChunks, search, textSearch, getIndexedSession, localIndexStore, openConfiguredIndex, remoteIndexConfig } from "./store";
import { pruneOrphans } from "./indexer";
import { formatHit } from "./format";
import type { SourceSession } from "./reader";

const dir = mkdtempSync(join(tmpdir(), "episodic-store-test-"));
const db = openIndex(join(dir, "index.db"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const meta = {
  id: "ses_test", project_id: "p", parent_id: null,
  title: "Test session", directory: "/tmp",
  time_created: 1000, source_time_updated: 1000,
};

describe("store", () => {
  test("remote live reads require the source identity returned by search", () => {
    const remote = { url: "libsql://example.turso.io", sourceId: "desktop", authToken: "token" };
    expect(canLiveRead(remote, undefined)).toBeFalse();
    expect(canLiveRead(remote, "laptop")).toBeFalse();
    expect(canLiveRead(remote, "desktop")).toBeTrue();
    expect(canLiveRead(null, undefined)).toBeTrue();
  });

  test("remote configuration requires a source and network token", async () => {
    const original = { url: process.env.EPISODIC_INDEX_URL, source: process.env.EPISODIC_SOURCE_ID, token: process.env.EPISODIC_INDEX_AUTH_TOKEN };
    try {
      process.env.EPISODIC_INDEX_URL = "libsql://example.turso.io";
      delete process.env.EPISODIC_SOURCE_ID;
      delete process.env.EPISODIC_INDEX_AUTH_TOKEN;
      await expect(openConfiguredIndex()).rejects.toThrow("EPISODIC_SOURCE_ID");
      process.env.EPISODIC_SOURCE_ID = "test-source";
      await expect(openConfiguredIndex()).rejects.toThrow("EPISODIC_INDEX_AUTH_TOKEN");
    } finally {
      if (original.url === undefined) delete process.env.EPISODIC_INDEX_URL; else process.env.EPISODIC_INDEX_URL = original.url;
      if (original.source === undefined) delete process.env.EPISODIC_SOURCE_ID; else process.env.EPISODIC_SOURCE_ID = original.source;
      if (original.token === undefined) delete process.env.EPISODIC_INDEX_AUTH_TOKEN; else process.env.EPISODIC_INDEX_AUTH_TOKEN = original.token;
    }
  });

  test("remote configuration accepts only secure URLs without embedded credentials", () => {
    const base = { EPISODIC_SOURCE_ID: "source", EPISODIC_INDEX_AUTH_TOKEN: "token" };
    expect(remoteIndexConfig({ ...base, EPISODIC_INDEX_URL: "file:/tmp/index.db" })).toMatchObject({ sourceId: "source" });
    expect(remoteIndexConfig({ ...base, EPISODIC_INDEX_URL: "libsql://trusted.example?tls=1" })?.url).toBe("libsql://trusted.example?tls=1");
    for (const url of ["file:relative.db", "http://host", "ws://host", "libsql://host?tls=0", "libsql://host?tls=false", "libsql://host?tls=true", "libsql://host?TLS=1", "libsql://host?%74ls=1", "libsql://host?t%6cs=1", "libsql://host?tls=%31", "libsql://host?tls=1#fragment", "https://token@host", "libsql://host?authToken=secret", "libsql://trusted.example%40evil", "libsql://trusted.example?tls=1&tls=0"]) {
      expect(() => remoteIndexConfig({ ...base, EPISODIC_INDEX_URL: url })).toThrow();
    }
    expect(() => remoteIndexConfig({ ...base, EPISODIC_INDEX_URL: "https://trusted.example\\@evil.example" })).toThrow("backslashes");
    expect(remoteIndexConfig({ ...base, EPISODIC_INDEX_URL: "https://trusted.example" })?.url).toBe("https://trusted.example/");
    expect(() => remoteIndexConfig({ EPISODIC_INDEX_URL: "https://host.example", EPISODIC_SOURCE_ID: "source" })).toThrow("EPISODIC_INDEX_AUTH_TOKEN");
  });

  test("remote index combines sources and prunes only the current source", async () => {
    const original = { url: process.env.EPISODIC_INDEX_URL, source: process.env.EPISODIC_SOURCE_ID, token: process.env.EPISODIC_INDEX_AUTH_TOKEN };
    const remotePath = join(dir, "remote.db");
    try {
      process.env.EPISODIC_INDEX_URL = `file:${remotePath}`;
      delete process.env.EPISODIC_INDEX_AUTH_TOKEN;
      process.env.EPISODIC_SOURCE_ID = "laptop";
      const laptop = await openConfiguredIndex();
      await laptop.replaceSessionChunks({ ...meta, id: "ses_same", title: "Laptop", source_time_updated: 10 }, [{ seq: 0, time_created: 1, text: "laptop memory", embedding: new Float32Array([1, 0]) }]);
      process.env.EPISODIC_SOURCE_ID = "desktop";
      const desktop = await openConfiguredIndex();
      await desktop.replaceSessionChunks({ ...meta, id: "ses_same", title: "Desktop", source_time_updated: 20 }, [{ seq: 0, time_created: 2, text: "desktop memory", embedding: new Float32Array([1, 0]) }]);
      const hits = await desktop.search(new Float32Array([1, 0]));
      expect(hits.map((hit) => hit.source_id).sort()).toEqual(["desktop", "laptop"]);
      expect((await laptop.getIndexedSession("ses_same"))?.source_time_updated).toBe(10);
      expect((await desktop.getIndexedSession("ses_same"))?.source_time_updated).toBe(20);
      expect(await laptop.readIndexed("ses_same", "desktop")).toEqual([{ text: "desktop memory" }]);
      await expect(desktop.textSearch("memory")).rejects.toThrow("vector search only");
      await expect(desktop.search(new Float32Array([1, 0]), { hybrid: true, queryText: "memory" })).rejects.toThrow("vector search only");
      expect(await laptop.getIndexedSession("ses_same")).not.toBeNull();
      expect(await desktop.pruneOrphans([])).toBe(1);
      expect(await laptop.getIndexedSession("ses_same")).not.toBeNull();
      expect(await desktop.getIndexedSession("ses_same")).toBeNull();
      laptop.close();
      desktop.close();
    } finally {
      if (original.url === undefined) delete process.env.EPISODIC_INDEX_URL; else process.env.EPISODIC_INDEX_URL = original.url;
      if (original.source === undefined) delete process.env.EPISODIC_SOURCE_ID; else process.env.EPISODIC_SOURCE_ID = original.source;
      if (original.token === undefined) delete process.env.EPISODIC_INDEX_AUTH_TOKEN; else process.env.EPISODIC_INDEX_AUTH_TOKEN = original.token;
    }
  });

  test("indexed windows are bounded, anchored, and source-scoped", async () => {
    const local = localIndexStore(openIndex(join(dir, "window-local.db")));
    try {
      await local.replaceSessionChunks({ ...meta, id: "ses_window" }, Array.from({ length: 51 }, (_, seq) => ({
        seq, time_created: seq, anchor_message_id: seq === 0 ? "local-start" : seq === 3 ? "local-default" : seq === 10 || seq === 11 ? "local-duplicate" : seq === 20 ? "local-max" : seq === 50 ? "local-end" : null,
        text: seq === 3 ? "x".repeat(5_000) : `local ${seq}`,
        embedding: new Float32Array([1, 0]),
      })));
      expect((await local.readIndexedWindow("ses_window", "local-default")).map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect((await local.readIndexedWindow("ses_window", "local-default"))[3].text).toHaveLength(4_000);
      expect((await local.readIndexedWindow("ses_window", "local-start", 20, 20)).map((row) => row.seq)).toEqual(Array.from({ length: 21 }, (_, seq) => seq));
      expect((await local.readIndexedWindow("ses_window", "local-end")).map((row) => row.seq)).toEqual([47, 48, 49, 50]);
      expect((await local.readIndexedWindow("ses_window", "local-duplicate", 0, 0)).map((row) => row.seq)).toEqual([10]);
      expect((await local.readIndexedWindow("ses_window", "local-max", 20, 20)).map((row) => row.seq)).toEqual(Array.from({ length: 41 }, (_, seq) => seq));
      expect(await local.readIndexedWindow("ses_window", "missing")).toEqual([]);
      expect(await local.readIndexedWindow("missing-session", "local-default")).toEqual([]);
      for (const invalid of [NaN, Infinity, -Infinity, 0.5, 21, -1]) {
        await expect(local.readIndexedWindow("ses_window", "local-default", invalid)).rejects.toThrow();
        await expect(local.readIndexedWindow("ses_window", "local-default", 0, invalid)).rejects.toThrow();
      }
    } finally {
      local.close();
    }

    const original = { url: process.env.EPISODIC_INDEX_URL, source: process.env.EPISODIC_SOURCE_ID, token: process.env.EPISODIC_INDEX_AUTH_TOKEN };
    let laptop: Awaited<ReturnType<typeof openConfiguredIndex>> | undefined;
    let desktop: Awaited<ReturnType<typeof openConfiguredIndex>> | undefined;
    try {
      process.env.EPISODIC_INDEX_URL = `file:${join(dir, "window-remote.db")}`;
      delete process.env.EPISODIC_INDEX_AUTH_TOKEN;
      process.env.EPISODIC_SOURCE_ID = "laptop";
      laptop = await openConfiguredIndex();
      await laptop.replaceSessionChunks({ ...meta, id: "ses_window" }, [
        { seq: 0, time_created: 0, anchor_message_id: null, text: "laptop before", embedding: new Float32Array([1, 0]) },
        { seq: 1, time_created: 1, anchor_message_id: "shared-anchor", text: "laptop anchor", embedding: new Float32Array([1, 0]) },
        { seq: 2, time_created: 2, anchor_message_id: null, text: "laptop after", embedding: new Float32Array([1, 0]) },
      ]);
      process.env.EPISODIC_SOURCE_ID = "desktop";
      desktop = await openConfiguredIndex();
      await desktop.replaceSessionChunks({ ...meta, id: "ses_window" }, Array.from({ length: 51 }, (_, seq) => ({
        seq, time_created: seq, anchor_message_id: seq === 0 ? "remote-start" : seq === 1 ? "shared-anchor" : seq === 3 ? "remote-default" : seq === 20 ? "remote-max" : seq === 50 ? "remote-end" : null,
        text: seq === 3 ? "r".repeat(5_000) : `desktop ${seq}`, embedding: new Float32Array([1, 0]),
      })));
      expect((await laptop.readIndexedWindow("ses_window", "shared-anchor", 1, 1, "laptop")).map((row) => row.text)).toEqual(["laptop before", "laptop anchor", "laptop after"]);
      expect((await desktop.readIndexedWindow("ses_window", "remote-default", 3, 3, "desktop"))[3].text).toHaveLength(4_000);
      expect((await desktop.readIndexedWindow("ses_window", "remote-default", undefined, undefined, "desktop")).map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect((await desktop.readIndexedWindow("ses_window", "remote-start", 20, 20, "desktop")).map((row) => row.seq)).toEqual(Array.from({ length: 21 }, (_, seq) => seq));
      expect((await desktop.readIndexedWindow("ses_window", "remote-max", 20, 20, "desktop")).map((row) => row.seq)).toEqual(Array.from({ length: 41 }, (_, seq) => seq));
      expect((await desktop.readIndexedWindow("ses_window", "remote-end", undefined, undefined, "desktop")).map((row) => row.seq)).toEqual([47, 48, 49, 50]);
      expect((await laptop.readIndexedWindow("ses_window", "shared-anchor", 1, 1, "desktop")).map((row) => row.seq)).toEqual([0, 1, 2]);
      expect(await laptop.readIndexedWindow("ses_window", "remote-default", 1, 1, "laptop")).toEqual([]);
      await expect(laptop.readIndexedWindow("ses_window", "shared-anchor")).rejects.toThrow("sourceId");
      await expect(laptop.readIndexedWindow("ses_window", "shared-anchor", 0, 0, "")).rejects.toThrow("sourceId");
      for (const invalid of [NaN, Infinity, -Infinity, 0.5, 21, -1]) {
        await expect(desktop.readIndexedWindow("ses_window", "remote-default", invalid, 0, "desktop")).rejects.toThrow();
        await expect(desktop.readIndexedWindow("ses_window", "remote-default", 0, invalid, "desktop")).rejects.toThrow();
      }
      await laptop.removeSession("ses_window");
      expect(await laptop.readIndexedWindow("ses_window", "shared-anchor", 1, 1, "laptop")).toEqual([]);
    } finally {
      laptop?.close();
      desktop?.close();
      if (original.url === undefined) delete process.env.EPISODIC_INDEX_URL; else process.env.EPISODIC_INDEX_URL = original.url;
      if (original.source === undefined) delete process.env.EPISODIC_SOURCE_ID; else process.env.EPISODIC_SOURCE_ID = original.source;
      if (original.token === undefined) delete process.env.EPISODIC_INDEX_AUTH_TOKEN; else process.env.EPISODIC_INDEX_AUTH_TOKEN = original.token;
    }
  });

  test("remote search paginates candidates before hydrating winners", async () => {
    const original = { url: process.env.EPISODIC_INDEX_URL, source: process.env.EPISODIC_SOURCE_ID, token: process.env.EPISODIC_INDEX_AUTH_TOKEN };
    try {
      process.env.EPISODIC_INDEX_URL = `file:${join(dir, "paged-remote.db")}`;
      process.env.EPISODIC_SOURCE_ID = "pager";
      delete process.env.EPISODIC_INDEX_AUTH_TOKEN;
      const remote = await openConfiguredIndex();
      await remote.replaceSessionChunks({ ...meta, id: "ses_paged" }, Array.from({ length: 251 }, (_, seq) => ({
        seq, time_created: seq, text: `candidate ${seq}`,
        embedding: new Float32Array(seq === 250 ? [1, 0] : [0, 1]),
      })));
      expect((await remote.search(new Float32Array([1, 0]), { limit: 1 }))[0].text).toBe("candidate 250");
      remote.close();
    } finally {
      if (original.url === undefined) delete process.env.EPISODIC_INDEX_URL; else process.env.EPISODIC_INDEX_URL = original.url;
      if (original.source === undefined) delete process.env.EPISODIC_SOURCE_ID; else process.env.EPISODIC_SOURCE_ID = original.source;
      if (original.token === undefined) delete process.env.EPISODIC_INDEX_AUTH_TOKEN; else process.env.EPISODIC_INDEX_AUTH_TOKEN = original.token;
    }
  });

  test("concurrent first remote opens adopt one compatible schema", async () => {
    const original = { url: process.env.EPISODIC_INDEX_URL, source: process.env.EPISODIC_SOURCE_ID, token: process.env.EPISODIC_INDEX_AUTH_TOKEN };
    try {
      process.env.EPISODIC_INDEX_URL = `file:${join(dir, "concurrent-remote.db")}`;
      process.env.EPISODIC_SOURCE_ID = "concurrent";
      delete process.env.EPISODIC_INDEX_AUTH_TOKEN;
      const stores = await Promise.all(Array.from({ length: 4 }, () => openConfiguredIndex()));
      for (const store of stores) store.close();
    } finally {
      if (original.url === undefined) delete process.env.EPISODIC_INDEX_URL; else process.env.EPISODIC_INDEX_URL = original.url;
      if (original.source === undefined) delete process.env.EPISODIC_SOURCE_ID; else process.env.EPISODIC_SOURCE_ID = original.source;
      if (original.token === undefined) delete process.env.EPISODIC_INDEX_AUTH_TOKEN; else process.env.EPISODIC_INDEX_AUTH_TOKEN = original.token;
    }
  });

  test("remote open rejects incompatible and future schemas", async () => {
    const original = { url: process.env.EPISODIC_INDEX_URL, source: process.env.EPISODIC_SOURCE_ID, token: process.env.EPISODIC_INDEX_AUTH_TOKEN };
    try {
      process.env.EPISODIC_SOURCE_ID = "schema-test";
      delete process.env.EPISODIC_INDEX_AUTH_TOKEN;
      const incompatible = join(dir, "incompatible-remote.db");
      const legacy = new Database(incompatible);
      legacy.run("CREATE TABLE episodic_sessions (source_id TEXT, session_id TEXT, PRIMARY KEY (session_id))");
      legacy.run("CREATE TABLE episodic_chunks (source_id TEXT, session_id TEXT, seq INTEGER, PRIMARY KEY (session_id, seq))");
      legacy.close();
      process.env.EPISODIC_INDEX_URL = `file:${incompatible}`;
      await expect(openConfiguredIndex()).rejects.toThrow("Incompatible remote index schema");
      const untouched = new Database(incompatible);
      expect(untouched.prepare<{ n: number }, []>("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'episodic_schema_versions'").get()?.n).toBe(0);
      expect(untouched.prepare<{ n: number }, []>("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'index' AND name = 'episodic_chunks_time_idx'").get()?.n).toBe(0);
      untouched.close();

      const mixedCase = join(dir, "mixed-case-remote.db");
      const uppercase = new Database(mixedCase);
      uppercase.run("CREATE TABLE EPISODIC_SESSIONS (source_id TEXT, session_id TEXT, PRIMARY KEY (session_id))");
      uppercase.run("CREATE TABLE EPISODIC_CHUNKS (source_id TEXT, session_id TEXT, seq INTEGER, PRIMARY KEY (session_id, seq))");
      uppercase.close();
      process.env.EPISODIC_INDEX_URL = `file:${mixedCase}`;
      await expect(openConfiguredIndex()).rejects.toThrow("Incompatible remote index schema");
      const mixedUntouched = new Database(mixedCase);
      expect(mixedUntouched.prepare<{ n: number }, []>("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'episodic_schema_versions'").get()?.n).toBe(0);
      expect(mixedUntouched.prepare<{ n: number }, []>("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'index' AND name = 'episodic_chunks_time_idx'").get()?.n).toBe(0);
      mixedUntouched.close();

      const future = join(dir, "future-remote.db");
      const futureDb = new Database(future);
      futureDb.run("CREATE TABLE episodic_schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL)");
      futureDb.run("INSERT INTO episodic_schema_versions VALUES ('remote-index', 2)");
      futureDb.close();
      process.env.EPISODIC_INDEX_URL = `file:${future}`;
      await expect(openConfiguredIndex()).rejects.toThrow("Unsupported future remote index schema version: 2");
      const checked = new Database(future);
      expect(checked.prepare<{ n: number }, []>("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('episodic_sessions', 'episodic_chunks')").get()?.n).toBe(0);
      checked.close();
    } finally {
      if (original.url === undefined) delete process.env.EPISODIC_INDEX_URL; else process.env.EPISODIC_INDEX_URL = original.url;
      if (original.source === undefined) delete process.env.EPISODIC_SOURCE_ID; else process.env.EPISODIC_SOURCE_ID = original.source;
      if (original.token === undefined) delete process.env.EPISODIC_INDEX_AUTH_TOKEN; else process.env.EPISODIC_INDEX_AUTH_TOKEN = original.token;
    }
  });
  test("replaceSessionChunks + search round-trip ranks by cosine", () => {
    replaceSessionChunks(db, meta, [
      { seq: 0, time_created: 1000, anchor_message_id: "msg_alpha", text: "alpha chunk", embedding: new Float32Array([1, 0]) },
      { seq: 1, time_created: 1001, anchor_message_id: "msg_beta", text: "beta chunk", embedding: new Float32Array([0, 1]) },
    ]);
    const hits = search(db, new Float32Array([1, 0]));
    expect(hits).toHaveLength(2);
    expect(hits[0].text).toBe("alpha chunk");
    expect(hits[0].score).toBeCloseTo(1);
    expect(hits[0].anchor_message_id).toBe("msg_alpha");
    expect(hits[1].score).toBeCloseTo(0);
    expect(getIndexedSession(db, "ses_test")?.title).toBe("Test session");
  });

  test("search skips embeddings with mismatched dims instead of crashing", () => {
    // 4-byte blob while the query is 2 dims (8 bytes) — must be skipped.
    db.run("INSERT INTO chunks (session_id, seq, time_created, text, embedding) VALUES (?, ?, ?, ?, ?)",
      ["ses_test", 99, 1002, "stale wrong-dims chunk", new Float32Array([0.5])]);
    const hits = search(db, new Float32Array([1, 0]));
    expect(hits.map((h) => h.text)).not.toContain("stale wrong-dims chunk");
    expect(hits).toHaveLength(2);
  });

  test("re-embedding a session replaces its chunks", () => {
    replaceSessionChunks(db, meta, [
      { seq: 0, time_created: 1000, text: "only chunk now", embedding: new Float32Array([1, 0]) },
    ]);
    const hits = search(db, new Float32Array([1, 0]));
    expect(hits.map((h) => h.text)).toEqual(["only chunk now"]);
  });

  test("textSearch does exact substring matching", () => {
    expect(textSearch(db, "only chunk")).toHaveLength(1);
    expect(textSearch(db, "no such phrase")).toHaveLength(0);
  });

  test("search() text filter escapes LIKE wildcards (treated literally)", () => {
    // textSearch is now FTS/token-based; the LIKE substring escaping lives on
    // in search()'s `text` filter (and the FTS LIKE fallback), so assert it here.
    replaceSessionChunks(db, meta, [
      { seq: 0, time_created: 1000, text: "progress at 50% done", embedding: new Float32Array([1, 0]) },
      { seq: 1, time_created: 1001, text: "snake_case name here", embedding: new Float32Array([0, 1]) },
      { seq: 2, time_created: 1002, text: "path \\tmp", embedding: new Float32Array([1, 0]) },
    ]);
    const vec = new Float32Array([1, 0]);
    // % and _ match literally, not as LIKE wildcards.
    expect(search(db, vec, { text: "50%" }).map((h) => h.text)).toEqual(["progress at 50% done"]);
    expect(search(db, vec, { text: "snake_case" }).map((h) => h.text)).toEqual(["snake_case name here"]);
    // a bare % / _ must NOT match everything (would if unescaped).
    expect(search(db, vec, { text: "%" })).toHaveLength(1);
    expect(search(db, vec, { text: "_" })).toHaveLength(1);
    // escapeLike escapes the escape char itself: a literal backslash matches
    // only the row containing one.
    expect(search(db, vec, { text: "\\" }).map((h) => h.text)).toEqual(["path \\tmp"]);
  });

  test("two-phase search hydrates full display fields only for the top-K winners", () => {
    replaceSessionChunks(db, meta, [
      { seq: 0, time_created: 1000, text: "alpha chunk", embedding: new Float32Array([1, 0]) },
      { seq: 1, time_created: 1001, text: "beta chunk", embedding: new Float32Array([0, 1]) },
    ]);
    // limit 1 → only the top winner is hydrated (phase 2), but it carries the
    // full text/title/directory — identical to the old single-query path.
    const hits = search(db, new Float32Array([1, 0]), { limit: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      session_id: "ses_test", seq: 0, text: "alpha chunk",
      title: "Test session", directory: "/tmp",
    });
    expect(hits[0].score).toBeCloseTo(1);
  });

  test("after/before use !== undefined so an epoch-0 bound is honored, not dropped", () => {
    replaceSessionChunks(db, meta, [
      { seq: 0, time_created: 0, text: "at epoch zero", embedding: new Float32Array([1, 0]) },
      { seq: 1, time_created: 5000, text: "later chunk", embedding: new Float32Array([1, 0]) },
    ]);
    // before: 0 must filter to nothing. Under the old falsy check the 0 bound
    // was skipped and every row leaked through.
    expect(search(db, new Float32Array([1, 0]), { before: 0 })).toHaveLength(0);
    // after: 0 is an inclusive lower bound (both rows are >= 0).
    expect(search(db, new Float32Array([1, 0]), { after: 0 }).map((h) => h.text).sort())
      .toEqual(["at epoch zero", "later chunk"]);
    // textSearch shares the same fix.
    expect(textSearch(db, "chunk", { before: 0 })).toHaveLength(0);
  });

  test("openIndex backfills the FTS index from pre-existing chunks (migration)", () => {
    // Simulate a pre-FTS index DB: sessions + chunks populated, no chunks_fts,
    // user_version 0. openIndex must create the FTS table/triggers and rebuild.
    const p = join(dir, "legacy.db");
    const legacy = new Database(p);
    legacy.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL,
      directory TEXT NOT NULL, time_created INTEGER NOT NULL, source_time_updated INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'indexed')`);
    legacy.run(`CREATE TABLE chunks (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
      text TEXT NOT NULL, embedding BLOB NOT NULL, PRIMARY KEY (session_id, seq))`);
    legacy.run("INSERT INTO sessions (id, project_id, parent_id, title, directory, time_created, source_time_updated, indexed_at, status) VALUES ('ses_leg','p',NULL,'Legacy','/tmp',1,1,1,'indexed')");
    legacy.run("INSERT INTO chunks (session_id, seq, time_created, text, embedding) VALUES ('ses_leg',0,1,'legacy migrated searchable content',?)", [new Float32Array([1, 0])]);
    legacy.close();

    const migrated = openIndex(p);
    try {
      expect(textSearch(migrated, "legacy").map((h) => h.text)).toEqual(["legacy migrated searchable content"]);
      expect(textSearch(migrated, "legacy")[0].anchor_message_id).toBeNull();
      expect(formatHit(textSearch(migrated, "legacy")[0])).toContain("anchor: unavailable (refresh/reindex required)");
      expect(getIndexedSession(migrated, "ses_leg")?.source_time_updated).toBe(-1);
      expect(migrated.prepare<{ n: number }, []>("SELECT COUNT(*) n FROM pragma_table_info('chunks') WHERE name = 'anchor_message_id'").get()?.n).toBe(1);
    } finally {
      migrated.close();
    }
  });

  test("anchor migration preserves v1 FTS rowids and postings; subsequent opens use the schema fast path", () => {
    const p = join(dir, "v1-populated.db");
    const legacy = new Database(p);
    legacy.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL,
      directory TEXT NOT NULL, time_created INTEGER NOT NULL, source_time_updated INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'indexed')`);
    legacy.run(`CREATE TABLE chunks (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
      text TEXT NOT NULL, embedding BLOB NOT NULL, PRIMARY KEY (session_id, seq))`);
    legacy.run("CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid')");
    legacy.run(`CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
    END`);
    legacy.run(`CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    END`);
    legacy.run(`CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
    END`);
    legacy.run("INSERT INTO sessions (id, project_id, parent_id, title, directory, time_created, source_time_updated, indexed_at, status) VALUES ('ses_v1','p',NULL,'V1','/tmp',1,1,1,'indexed')");
    legacy.run("INSERT INTO chunks (session_id, seq, time_created, text, embedding) VALUES ('ses_v1',0,1,'orchid unique term',?)", [new Float32Array([1, 0])]);
    legacy.run("INSERT INTO chunks (session_id, seq, time_created, text, embedding) VALUES ('ses_v1',1,2,'marigold distinct term',?)", [new Float32Array([0, 1])]);
    legacy.run("PRAGMA user_version = 1");
    const rowids = legacy.prepare<{ rowid: number; seq: number }, []>("SELECT rowid, seq FROM chunks ORDER BY seq").all();
    expect(legacy.prepare<{ n: number }, []>("SELECT COUNT(*) n FROM chunks_fts").get()?.n).toBe(2);
    legacy.close();

    const migrated = openIndex(p);
    try {
      expect(migrated.prepare<{ rowid: number; seq: number }, []>("SELECT rowid, seq FROM chunks ORDER BY seq").all()).toEqual(rowids);
      expect(textSearch(migrated, "orchid").map((hit) => hit.seq)).toEqual([0]);
      expect(textSearch(migrated, "marigold").map((hit) => hit.seq)).toEqual([1]);
      expect(migrated.prepare<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1);
    } finally {
      migrated.close();
    }
    // The anchor column now exists, so this directly exercises the no-write-lock
    // migration fast path rather than entering BEGIN IMMEDIATE again.
    const reopened = openIndex(p);
    try {
      expect(reopened.prepare<{ rowid: number; seq: number }, []>("SELECT rowid, seq FROM chunks ORDER BY seq").all()).toEqual(rowids);
      expect(textSearch(reopened, "orchid").map((hit) => hit.seq)).toEqual([0]);
    } finally {
      reopened.close();
    }
  });

  test("concurrent first openers serialize the anchor migration", async () => {
    const p = join(dir, "concurrent-first-open.db");
    const legacy = new Database(p);
    legacy.run("PRAGMA journal_mode = WAL");
    legacy.run(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL,
      directory TEXT NOT NULL, time_created INTEGER NOT NULL, source_time_updated INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'indexed')`);
    legacy.run(`CREATE TABLE chunks (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
      text TEXT NOT NULL, embedding BLOB NOT NULL, PRIMARY KEY (session_id, seq))`);
    legacy.run("CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid')");
    legacy.run("CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END");
    legacy.run("CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); END");
    legacy.run("CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text); END");
    legacy.run("INSERT INTO sessions (id, project_id, parent_id, title, directory, time_created, source_time_updated, indexed_at, status) VALUES ('ses_race','p',NULL,'Race','/tmp',1,42,1,'indexed')");
    legacy.run("INSERT INTO chunks (session_id, seq, time_created, text, embedding) VALUES ('ses_race',0,1,'concurrent orchid term',?)", [new Float32Array([1, 0])]);
    legacy.run("INSERT INTO chunks (session_id, seq, time_created, text, embedding) VALUES ('ses_race',1,2,'concurrent marigold term',?)", [new Float32Array([0, 1])]);
    legacy.run("PRAGMA user_version = 1");
    const rowids = legacy.prepare<{ rowid: number; seq: number }, []>("SELECT rowid, seq FROM chunks ORDER BY seq").all();
    legacy.close();

    const storeModule = new URL("./store.ts", import.meta.url).href;
    const workerCode = `import { openIndex } from ${JSON.stringify(storeModule)}; const db = openIndex(process.argv[1]); db.close();`;
    const openers = Array.from({ length: 8 }, async () => {
      const child = Bun.spawn([process.execPath, "-e", workerCode, p], { stdout: "ignore", stderr: "pipe" });
      const result = await Promise.race([
        child.exited.then((code) => ({ timedOut: false, code })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 5_000)),
      ]);
      if (result.timedOut) {
        child.kill();
        throw new Error("concurrent openIndex worker timed out");
      }
      if (result.code !== 0) throw new Error(`concurrent openIndex worker exited ${result.code}`);
    });
    await Promise.all(openers);

    const opened = openIndex(p);
    try {
      expect(opened.prepare<{ n: number }, []>("SELECT COUNT(*) n FROM pragma_table_info('chunks') WHERE name = 'anchor_message_id'").get()?.n).toBe(1);
      expect(getIndexedSession(opened, "ses_race")?.source_time_updated).toBe(-1);
      expect(opened.prepare<{ rowid: number; seq: number }, []>("SELECT rowid, seq FROM chunks ORDER BY seq").all()).toEqual(rowids);
      expect(textSearch(opened, "orchid").map((hit) => hit.seq)).toEqual([0]);
      expect(textSearch(opened, "marigold").map((hit) => hit.seq)).toEqual([1]);
    } finally {
      opened.close();
    }
  });

  test("an already-migrated index opens while another connection holds a write lock", () => {
    const p = join(dir, "already-migrated.db");
    const initialized = openIndex(p);
    initialized.close();
    const writer = new Database(p);
    writer.run("BEGIN IMMEDIATE");
    try {
      const opened = openIndex(p);
      try {
        expect(opened.prepare<{ n: number }, []>("SELECT COUNT(*) n FROM pragma_table_info('chunks') WHERE name = 'anchor_message_id'").get()?.n).toBe(1);
      } finally {
        opened.close();
      }
    } finally {
      writer.run("ROLLBACK");
      writer.close();
    }
  });

  test("textSearch ranks by BM25 (higher term frequency ranks first)", () => {
    replaceSessionChunks(db, meta, [
      { seq: 0, time_created: 1000, text: "database migration notes", embedding: new Float32Array([1, 0]) },
      { seq: 1, time_created: 1001, text: "database database database heavy", embedding: new Float32Array([0, 1]) },
    ]);
    const hits = textSearch(db, "database");
    expect(hits.map((h) => h.seq)).toEqual([1, 0]);
    expect(hits[0].score).toBeGreaterThan(0); // -bm25 exposed as positive relevance
  });

  test("hybrid search is opt-in and fuses vector + BM25 (minScore before fusion)", () => {
    replaceSessionChunks(db, meta, [
      { seq: 0, time_created: 1000, text: "quantum entanglement notes", embedding: new Float32Array([1, 0]) },
      { seq: 1, time_created: 1001, text: "kubernetes deployment guide", embedding: new Float32Array([0, 1]) },
    ]);
    const vec = new Float32Array([1, 0]);
    // minScore excludes the orthogonal chunk from the vector arm → only seq0.
    expect(search(db, vec, { minScore: 0.5 }).map((h) => h.seq)).toEqual([0]);
    // queryText alone does NOT enable fusion — hybrid is opt-in.
    expect(search(db, vec, { minScore: 0.5, queryText: "kubernetes deployment" }).map((h) => h.seq)).toEqual([0]);
    // hybrid: true fuses in the BM25 arm, which surfaces seq1 (matched by text)
    // even though minScore dropped it from the vector arm → union of both.
    const hybrid = search(db, vec, { minScore: 0.5, hybrid: true, queryText: "kubernetes deployment" });
    expect(hybrid.map((h) => h.seq).sort()).toEqual([0, 1]);
  });

  test("FTS query operators are neutralized (no injection)", () => {
    replaceSessionChunks(db, meta, [
      { seq: 0, time_created: 1000, text: "alpha only", embedding: new Float32Array([1, 0]) },
      { seq: 1, time_created: 1001, text: "beta only", embedding: new Float32Array([0, 1]) },
    ]);
    // If "OR" were the boolean operator this would match both rows; quoted, the
    // three tokens are AND-ed literals → no single row has all → 0 matches.
    expect(textSearch(db, "alpha OR beta")).toHaveLength(0);
    // Malformed quoting must never throw (scoreFts falls back to LIKE).
    expect(() => textSearch(db, 'dangling " quote')).not.toThrow();
  });

  test("hybrid fusion reorders relative to pure vector (deterministic RRF ordering)", () => {
    // seq0 wins on vector (cosine 1.0 vs 0.8) but is invisible to BM25; seq1 is
    // second on vector yet the sole BM25 match for the query. RRF: seq0 gets
    // 1/(60+1); seq1 gets 1/(60+2) [vector rank 2] + 1/(60+1) [BM25 rank 1],
    // which is strictly larger — so fusion must FLIP the order to [seq1, seq0].
    replaceSessionChunks(db, meta, [
      { seq: 0, time_created: 1000, text: "alpha standalone note", embedding: new Float32Array([1, 0]) },
      { seq: 1, time_created: 1001, text: "kubernetes deployment guide", embedding: new Float32Array([0.8, 0.6]) },
    ]);
    const vec = new Float32Array([1, 0]);
    // Pure vector keeps seq0 first (higher cosine).
    expect(search(db, vec).map((h) => h.seq)).toEqual([0, 1]);
    // Hybrid flips to seq1-first — asserting ORDER, not just set membership.
    const hybrid = search(db, vec, { hybrid: true, queryText: "kubernetes deployment" });
    expect(hybrid.map((h) => h.seq)).toEqual([1, 0]);
  });

  test("pruneOrphans removes FTS postings, not just chunk rows (chunks_ad trigger)", async () => {
    // Isolated DB so pruning everything can't disturb the shared `db` above.
    const idx = openIndex(join(dir, "prune.db"));
    try {
      replaceSessionChunks(idx, { ...meta, id: "ses_keep", title: "Keep" }, [
        { seq: 0, time_created: 1, text: "keepable kubernetes content", embedding: new Float32Array([1, 0]) },
      ]);
      replaceSessionChunks(idx, { ...meta, id: "ses_drop", title: "Drop" }, [
        { seq: 0, time_created: 1, text: "droppable elasticsearch content", embedding: new Float32Array([1, 0]) },
      ]);
      // Both are lexically searchable through the FTS index up front.
      expect(textSearch(idx, "kubernetes").map((h) => h.session_id)).toEqual(["ses_keep"]);
      expect(textSearch(idx, "elasticsearch").map((h) => h.session_id)).toEqual(["ses_drop"]);

      // Source now retains only ses_keep → ses_drop is an orphan. (knownSource is
      // supplied, so the `source` Database arg is unused — pass idx as a stand-in.)
      const kept: SourceSession[] = [
        { id: "ses_keep", project_id: "p", parent_id: null, title: "Keep", directory: "/tmp", time_created: 1, time_updated: 1 },
      ];
       expect(await pruneOrphans(idx, localIndexStore(idx), kept)).toBe(1);

      // The dropped session's FTS posting is gone (the DELETE fired chunks_ad),
      // while the kept session still matches — proving the trigger, not just the
      // row delete, took effect.
      expect(textSearch(idx, "elasticsearch")).toHaveLength(0);
      expect(textSearch(idx, "kubernetes").map((h) => h.session_id)).toEqual(["ses_keep"]);
    } finally {
      idx.close();
    }
  });
});
