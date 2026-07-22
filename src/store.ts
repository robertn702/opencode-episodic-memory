// Index database: plain SQLite (bun:sqlite). Embeddings stored as Float32
// blobs; similarity is brute-force cosine in JS. At our scale (tens of
// thousands of chunks) this is single-digit milliseconds per query and has
// zero native-extension risk. (sqlite-vec was rejected in Phase 0: bun:sqlite
// cannot load dynamic extensions. Swap in a vec0 backend here if scale ever
// demands it.)
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_INDEX_DB = join(homedir(), ".local/share/opencode-episodic-memory/index.db");

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
  return db;
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
  text?: string; // exact substring filter (ANDed with vector ranking)
  minScore?: number;
}

export function search(db: Database, queryVec: Float32Array, opts: SearchOptions = {}): SearchHit[] {
  const limit = opts.limit ?? 10;
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.after) { clauses.push("c.time_created >= ?"); params.push(opts.after); }
  if (opts.before) { clauses.push("c.time_created < ?"); params.push(opts.before); }
  if (opts.text) { clauses.push("c.text LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(opts.text)}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare<{
      session_id: string; seq: number; time_created: number; text: string;
      embedding: Uint8Array; title: string; directory: string;
    }, (string | number)[]>(
      `SELECT c.session_id, c.seq, c.time_created, c.text, c.embedding, s.title, s.directory
       FROM chunks c JOIN sessions s ON s.id = c.session_id ${where}`
    )
    .all(...params);

  const dims = queryVec.length;
  const minScore = opts.minScore ?? 0;
  return rows
    // Skip vectors from a different embedding model (e.g. mid-migration or
    // orphaned rows) — a dims mismatch would corrupt the dot product or throw.
    .filter((r) => r.embedding.byteLength === dims * 4)
    .map((r) => {
      const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, dims);
      let dot = 0;
      for (let i = 0; i < dims; i++) dot += queryVec[i] * v[i];
      return {
        session_id: r.session_id, seq: r.seq, time_created: r.time_created,
        text: r.text, score: dot, title: r.title, directory: r.directory,
      };
    })
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function textSearch(db: Database, query: string, opts: SearchOptions = {}): SearchHit[] {
  const limit = opts.limit ?? 10;
  const clauses = ["c.text LIKE ? ESCAPE '\\'"];
  const params: (string | number)[] = [`%${escapeLike(query)}%`];
  if (opts.after) { clauses.push("c.time_created >= ?"); params.push(opts.after); }
  if (opts.before) { clauses.push("c.time_created < ?"); params.push(opts.before); }
  const rows = db
    .prepare<Omit<SearchHit, "score">, (string | number)[]>(
      `SELECT c.session_id, c.seq, c.time_created, c.text, s.title, s.directory
       FROM chunks c JOIN sessions s ON s.id = c.session_id
       WHERE ${clauses.join(" AND ")} ORDER BY c.time_created DESC LIMIT ?`
    )
    .all(...params, limit);
  return rows.map((r) => ({ ...r, score: 1 }));
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
