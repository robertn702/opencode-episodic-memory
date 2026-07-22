// Phase 0 verification for item 5 (FTS5 hybrid search): does bun:sqlite's
// bundled SQLite include the FTS5 extension? bun:sqlite cannot load dynamic
// extensions (that's why sqlite-vec was rejected), but FTS5 may be COMPILED IN.
// If any step below throws (typically "no such module: fts5"), FTS5 is
// unavailable and the hybrid-search item must be skipped.
//
// Run: bun run spikes/fts5-check.ts
import { Database } from "bun:sqlite";

const db = new Database(":memory:");

try {
  // External-content-style standalone FTS5 table (the standalone form is enough
  // to prove the module exists; the store uses an external-content variant).
  db.run("CREATE VIRTUAL TABLE t USING fts5(body)");
  db.run("INSERT INTO t (rowid, body) VALUES (1, ?)", ["the quick brown fox jumps"]);
  db.run("INSERT INTO t (rowid, body) VALUES (2, ?)", ["a slow green turtle rests"]);
  db.run("INSERT INTO t (rowid, body) VALUES (3, ?)", ["quick foxes are quick"]);

  const rows = db
    .prepare<{ rowid: number; body: string; rank: number }, [string]>(
      "SELECT rowid, body, bm25(t) AS rank FROM t WHERE t MATCH ? ORDER BY rank"
    )
    .all('"quick"');

  console.log("FTS5 MATCH + bm25() works. Ranked results for query \"quick\":");
  for (const r of rows) console.log(`  rowid=${r.rowid} rank=${r.rank.toFixed(4)}  ${r.body}`);

  if (rows.length !== 2) throw new Error(`expected 2 matches for "quick", got ${rows.length}`);
  // bm25 is negative; the doc with more "quick" hits should rank first (more negative).
  if (rows[0].rowid !== 3) throw new Error(`expected rowid 3 (two 'quick' hits) first, got ${rows[0].rowid}`);

  console.log("\nFTS5 AVAILABLE — item 5 (hybrid search) can proceed.");
  process.exit(0);
} catch (e) {
  console.error("FTS5 NOT AVAILABLE in bun:sqlite:", e instanceof Error ? e.message : e);
  console.error("Skip item 5 (hybrid search); keep LIKE-based textSearch.");
  process.exit(1);
}
