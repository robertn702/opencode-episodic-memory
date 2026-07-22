import { describe, test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex, replaceSessionChunks, search, textSearch, getIndexedSession } from "./store";
import { pruneOrphans } from "./indexer";
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
  test("replaceSessionChunks + search round-trip ranks by cosine", () => {
    replaceSessionChunks(db, meta, [
      { seq: 0, time_created: 1000, text: "alpha chunk", embedding: new Float32Array([1, 0]) },
      { seq: 1, time_created: 1001, text: "beta chunk", embedding: new Float32Array([0, 1]) },
    ]);
    const hits = search(db, new Float32Array([1, 0]));
    expect(hits).toHaveLength(2);
    expect(hits[0].text).toBe("alpha chunk");
    expect(hits[0].score).toBeCloseTo(1);
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
    } finally {
      migrated.close();
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

  test("pruneOrphans removes FTS postings, not just chunk rows (chunks_ad trigger)", () => {
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
      expect(pruneOrphans(idx, idx, kept)).toBe(1);

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
