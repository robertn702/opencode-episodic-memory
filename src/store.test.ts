import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex, replaceSessionChunks, search, textSearch, getIndexedSession } from "./store";

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

  test("LIKE wildcards in user input are escaped (treated literally)", () => {
    replaceSessionChunks(db, meta, [
      { seq: 0, time_created: 1000, text: "progress at 50% done", embedding: new Float32Array([1, 0]) },
      { seq: 1, time_created: 1001, text: "snake_case name here", embedding: new Float32Array([0, 1]) },
      { seq: 2, time_created: 1002, text: "path \\tmp", embedding: new Float32Array([1, 0]) },
    ]);
    // % must match literally, not as a wildcard
    expect(textSearch(db, "50%").map((h) => h.text)).toEqual(["progress at 50% done"]);
    // _ must match literally, not as a single-char wildcard
    expect(textSearch(db, "snake_case").map((h) => h.text)).toEqual(["snake_case name here"]);
    // a bare % should NOT match everything (would if unescaped)
    expect(textSearch(db, "%")).toHaveLength(1);
    expect(textSearch(db, "_")).toHaveLength(1);
    // a literal backslash must match only the row containing one — escapeLike
    // escapes the escape char itself, so this would break if that were missed
    expect(textSearch(db, "\\").map((h) => h.text)).toEqual(["path \\tmp"]);
    // search() text filter should also escape
    expect(search(db, new Float32Array([1, 0]), { text: "50%" })).toHaveLength(1);
  });
});
