// Index database: plain SQLite (bun:sqlite). Embeddings stored as Float32
// blobs; vector similarity is brute-force cosine in JS. At our scale (tens of
// thousands of chunks) this is single-digit milliseconds per query and has
// zero native-extension risk. (sqlite-vec was rejected in Phase 0: bun:sqlite
// cannot load dynamic extensions. Swap in a vec0 backend here if scale ever
// demands it.)
//
// Lexical retrieval uses SQLite's built-in FTS5 (compiled into bun:sqlite —
// verified in spikes/fts5-check.ts; it's a static module, NOT a loadable
// extension, so the sqlite-vec limitation doesn't apply). search() fuses the
// vector and BM25 rankings via reciprocal rank fusion.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_INDEX_DB = join(homedir(), ".local/share/opencode-episodic-memory/index.db");

// Bump when the FTS schema changes to force a one-time rebuild on next open.
const FTS_SCHEMA_VERSION = 1;
// Reciprocal rank fusion constant (standard default) and how deep into each
// ranked list fusion looks — contributions past this depth are negligible.
const RRF_K = 60;
const FUSE_DEPTH = 200;

export function indexDbPath(): string {
  return process.env.EPISODIC_INDEX_DB ?? DEFAULT_INDEX_DB;
}

export function openIndex(path: string = indexDbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT,
    title TEXT NOT NULL,
    directory TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    source_time_updated INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'indexed'  -- 'indexed' | 'excluded' | 'empty'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS chunks (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`);
  db.run("CREATE INDEX IF NOT EXISTS chunks_time_idx ON chunks(time_created)");

  // Full-text index over chunk text. External content (content='chunks') means
  // the text isn't duplicated; the FTS index is kept in sync by triggers on
  // chunks — robust to any write path (not just replaceSessionChunks), which is
  // the standard SQLite pattern for external-content FTS5.
  db.run("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='rowid')");
  db.run(`CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
  END`);
  migrateFts(db);
  return db;
}

// One-time FTS backfill for index DBs created before FTS existed: they have
// chunks but an empty FTS index. COUNT(*) on an external-content FTS returns the
// content-row count (can't reveal "not indexed"), so gate on PRAGMA user_version
// instead. 'rebuild' repopulates from chunks and is a no-op on a fresh/empty DB.
function migrateFts(db: Database): void {
  const version = db.prepare<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  if (version < FTS_SCHEMA_VERSION) {
    db.run("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    db.run(`PRAGMA user_version = ${FTS_SCHEMA_VERSION}`);
  }
}

export interface IndexedSession {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  directory: string;
  time_created: number;
  source_time_updated: number;
  indexed_at: number;
  status: string;
}

export function getIndexedSession(db: Database, id: string): IndexedSession | null {
  return db.prepare<IndexedSession, [string]>("SELECT * FROM sessions WHERE id = ?").get(id) ?? null;
}

export function replaceSessionChunks(
  db: Database,
  s: { id: string; project_id: string; parent_id: string | null; title: string; directory: string; time_created: number; source_time_updated: number },
  chunks: { seq: number; time_created: number; text: string; embedding: Float32Array }[],
  status: string = "indexed"
): void {
  db.transaction(() => {
    db.run(
      `INSERT INTO sessions (id, project_id, parent_id, title, directory, time_created, source_time_updated, indexed_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, directory=excluded.directory,
         source_time_updated=excluded.source_time_updated,
         indexed_at=excluded.indexed_at, status=excluded.status`,
      [s.id, s.project_id, s.parent_id, s.title, s.directory, s.time_created, s.source_time_updated, Date.now(), status]
    );
    db.run("DELETE FROM chunks WHERE session_id = ?", [s.id]);
    const ins = db.prepare(
      "INSERT INTO chunks (session_id, seq, time_created, text, embedding) VALUES (?, ?, ?, ?, ?)"
    );
    for (const c of chunks) ins.run(s.id, c.seq, c.time_created, c.text, c.embedding);
  })();
}

export interface SearchHit {
  session_id: string;
  seq: number;
  time_created: number;
  text: string;
  score: number;
  title: string;
  directory: string;
}

// Escape LIKE wildcards so user input can't broaden a substring filter.
// Backslash escapes itself; used with the `ESCAPE '\'` clause below.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export interface SearchOptions {
  limit?: number;
  after?: number; // ms epoch
  before?: number; // ms epoch
  text?: string; // exact substring filter (ANDed with ranking)
  minScore?: number;
  // Raw natural-language query for the BM25/lexical arm of hybrid search
  // (used only together with hybrid: true).
  queryText?: string;
  // Opt in to hybrid (vector + BM25 fused via RRF) retrieval. Default is pure
  // vector: on this corpus BM25 tends to match injected boilerplate (e.g.
  // [MEMORY] preamble), so fusion is offered, not forced (see AGENTS.md).
  // Requires queryText.
  hybrid?: boolean;
}

// A scored candidate before display fields are fetched (phase 1 output).
interface ScoredChunk {
  session_id: string;
  seq: number;
  time_created: number;
  score: number;
}

// Shared time/text filter clauses (no leading WHERE). `after`/`before` use
// `!== undefined` (not truthiness) so a legitimate epoch-0 bound isn't dropped
// as "absent". `text` keeps a truthiness check: an empty substring filter is a
// no-op, not a match-everything `LIKE '%%'`. Reused by the vector, BM25, and
// LIKE-fallback candidate scans so the three stay filter-consistent.
function filterClauses(opts: SearchOptions): { clauses: string[]; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.after !== undefined) { clauses.push("c.time_created >= ?"); params.push(opts.after); }
  if (opts.before !== undefined) { clauses.push("c.time_created < ?"); params.push(opts.before); }
  if (opts.text) { clauses.push("c.text LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(opts.text)}%`); }
  return { clauses, params };
}

// Phase 1 (vector): score every candidate chunk by cosine against the query,
// apply the filters + minScore, and return them sorted best-first. Reads only
// the embedding blob (not the bulky text/title/directory), so the per-query
// cost is dims arithmetic, not full-row materialization.
function scoreVector(db: Database, queryVec: Float32Array, opts: SearchOptions): ScoredChunk[] {
  const { clauses, params } = filterClauses(opts);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const candidates = db
    .prepare<{ session_id: string; seq: number; time_created: number; embedding: Uint8Array }, (string | number)[]>(
      `SELECT c.session_id, c.seq, c.time_created, c.embedding FROM chunks c ${where}`
    )
    .all(...params);

  const dims = queryVec.length;
  const minScore = opts.minScore ?? 0;
  return candidates
    // Skip vectors from a different embedding model (e.g. mid-migration or
    // orphaned rows) — a dims mismatch would corrupt the dot product or throw.
    .filter((r) => r.embedding.byteLength === dims * 4)
    .map((r) => {
      const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, dims);
      let dot = 0;
      for (let i = 0; i < dims; i++) dot += queryVec[i] * v[i];
      return { session_id: r.session_id, seq: r.seq, time_created: r.time_created, score: dot };
    })
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

// Phase 2: fetch display fields (text/title/directory) only for the winners —
// a point lookup per hit on the (session_id, seq) primary key. K is bounded by
// the caller's limit (≤ 50 in the plugin), so this is a tiny handful of reads.
function hydrate(db: Database, scored: ScoredChunk[]): SearchHit[] {
  const detail = db.prepare<{ text: string; title: string; directory: string }, [string, number]>(
    `SELECT c.text, s.title, s.directory
     FROM chunks c JOIN sessions s ON s.id = c.session_id
     WHERE c.session_id = ? AND c.seq = ?`
  );
  const hits: SearchHit[] = [];
  for (const h of scored) {
    const d = detail.get(h.session_id, h.seq);
    // Inner-join semantics: skip a chunk whose session row is gone (shouldn't
    // happen — replaceSessionChunks/pruneOrphans keep chunks and sessions in
    // lockstep).
    if (!d) continue;
    hits.push({
      session_id: h.session_id, seq: h.seq, time_created: h.time_created,
      text: d.text, score: h.score, title: d.title, directory: d.directory,
    });
  }
  return hits;
}

// Turn a raw user query into a safe FTS5 MATCH expression: each whitespace-
// separated token is wrapped as a quoted string (internal quotes doubled). This
// neutralizes FTS operators (AND/OR/NOT/NEAR) and syntax chars in user input —
// they become literal search terms, never MATCH syntax — while preserving
// implicit-AND semantics across tokens. Empty input yields "" (→ no match).
function ftsQueryString(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

// Phase 1 (lexical): rank candidate chunks by BM25 over the FTS index, applying
// the shared filters. Returns best-first with score = -bm25 (bm25 is
// smaller-is-better/negative, so negating gives the higher-is-better convention
// used by the vector score). Falls back to a LIKE substring scan only if the
// MATCH expression is somehow still a syntax error.
function scoreFts(db: Database, query: string, opts: SearchOptions, depth: number): ScoredChunk[] {
  const match = ftsQueryString(query);
  if (!match) return [];
  const { clauses, params } = filterClauses(opts);
  const where = ["chunks_fts MATCH ?", ...clauses].join(" AND ");
  try {
    const rows = db
      .prepare<{ session_id: string; seq: number; time_created: number; rank: number }, (string | number)[]>(
        `SELECT c.session_id, c.seq, c.time_created, bm25(chunks_fts) AS rank
         FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
         WHERE ${where} ORDER BY rank LIMIT ?`
      )
      .all(match, ...params, depth);
    return rows.map((r) => ({ session_id: r.session_id, seq: r.seq, time_created: r.time_created, score: -r.rank }));
  } catch {
    return scoreLike(db, query, opts, depth);
  }
}

// LIKE substring fallback for scoreFts. Order by recency (the pre-FTS textSearch
// behavior); score is a constant since substring match has no ranking signal.
function scoreLike(db: Database, query: string, opts: SearchOptions, depth: number): ScoredChunk[] {
  const { clauses, params } = filterClauses(opts);
  const where = ["c.text LIKE ? ESCAPE '\\'", ...clauses].join(" AND ");
  const rows = db
    .prepare<{ session_id: string; seq: number; time_created: number }, (string | number)[]>(
      `SELECT c.session_id, c.seq, c.time_created FROM chunks c
       WHERE ${where} ORDER BY c.time_created DESC LIMIT ?`
    )
    .all(`%${escapeLike(query)}%`, ...params, depth);
  return rows.map((r) => ({ session_id: r.session_id, seq: r.seq, time_created: r.time_created, score: 1 }));
}

// Reciprocal rank fusion: combine several best-first ranked lists into one.
// Each list contributes 1/(k + rank) per item (rank 1-based); scores sum across
// lists, so an item ranked well by either signal surfaces. Ties/overlap dedupe
// by (session_id, seq).
function reciprocalRankFusion(lists: ScoredChunk[][], k: number = RRF_K): ScoredChunk[] {
  const fused = new Map<string, { chunk: ScoredChunk; score: number }>();
  for (const list of lists) {
    list.forEach((c, i) => {
      const key = `${c.session_id}\u0000${c.seq}`;
      const contribution = 1 / (k + i + 1);
      const existing = fused.get(key);
      if (existing) existing.score += contribution;
      else fused.set(key, { chunk: c, score: contribution });
    });
  }
  return [...fused.values()]
    .map((e) => ({ ...e.chunk, score: e.score }))
    .sort((a, b) => b.score - a.score);
}

// Pure vector search by default. Opt in to hybrid retrieval (vector + BM25
// fused via RRF) with hybrid: true + queryText. Pure vector is the default
// because, empirically on this corpus, the BM25 arm surfaces boilerplate noise
// and drags relevant semantic hits down (see AGENTS.md). minScore is applied to
// the vector scores BEFORE fusion (its calibration is cosine, not BM25).
export function search(db: Database, queryVec: Float32Array, opts: SearchOptions = {}): SearchHit[] {
  const limit = opts.limit ?? 10;
  const vector = scoreVector(db, queryVec, opts);

  const queryText = opts.hybrid === true ? opts.queryText : undefined;
  if (queryText === undefined || queryText.length === 0) {
    return hydrate(db, vector.slice(0, limit));
  }

  const lexical = scoreFts(db, queryText, opts, FUSE_DEPTH);
  const fused = reciprocalRankFusion([vector.slice(0, FUSE_DEPTH), lexical]);
  return hydrate(db, fused.slice(0, limit));
}

export function textSearch(db: Database, query: string, opts: SearchOptions = {}): SearchHit[] {
  const limit = opts.limit ?? 10;
  return hydrate(db, scoreFts(db, query, opts, limit));
}

// Cheap "is there anything to search?" check. Shared by the CLI and the plugin
// so their empty-index messaging stays consistent (a single COUNT, not the full
// stats() roll-up).
export function isIndexEmpty(db: Database): boolean {
  return (db.prepare<{ n: number }, []>("SELECT COUNT(*) n FROM chunks").get()?.n ?? 0) === 0;
}

export interface IndexStats {
  sessions: number;
  excluded: number;
  chunks: number;
  oldest: number | null;
  newest: number | null;
  byDirectory: { directory: string; n: number }[];
}

export function stats(db: Database): IndexStats {
  // COUNT/MIN/MAX always return exactly one row; guard anyway so the row type
  // stays non-null without a cast.
  function one<T>(sql: string): T {
    const row = db.prepare<T, []>(sql).get();
    if (!row) throw new Error(`stats query returned no row: ${sql}`);
    return row;
  }
  return {
    sessions: one<{ n: number }>("SELECT COUNT(*) n FROM sessions").n,
    excluded: one<{ n: number }>("SELECT COUNT(*) n FROM sessions WHERE status != 'indexed'").n,
    chunks: one<{ n: number }>("SELECT COUNT(*) n FROM chunks").n,
    oldest: one<{ t: number | null }>("SELECT MIN(time_created) t FROM chunks").t,
    newest: one<{ t: number | null }>("SELECT MAX(time_created) t FROM chunks").t,
    byDirectory: db
      .prepare<{ directory: string; n: number }, []>(
        "SELECT directory, COUNT(*) n FROM sessions WHERE status = 'indexed' GROUP BY directory ORDER BY n DESC LIMIT 10"
      )
      .all(),
  };
}
