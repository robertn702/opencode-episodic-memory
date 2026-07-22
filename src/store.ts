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
  return (db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as IndexedSession | null) ?? null;
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
  if (opts.before) { clauses.push("c.time_created <= ?"); params.push(opts.before); }
  if (opts.text) { clauses.push("c.text LIKE ?"); params.push(`%${opts.text}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT c.session_id, c.seq, c.time_created, c.text, c.embedding, s.title, s.directory
       FROM chunks c JOIN sessions s ON s.id = c.session_id ${where}`
    )
    .all(...params) as {
    session_id: string; seq: number; time_created: number; text: string;
    embedding: Uint8Array; title: string; directory: string;
  }[];

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
  const rows = db
    .prepare(
      `SELECT c.session_id, c.seq, c.time_created, c.text, s.title, s.directory
       FROM chunks c JOIN sessions s ON s.id = c.session_id
       WHERE c.text LIKE ? ORDER BY c.time_created DESC LIMIT ?`
    )
    .all(`%${query}%`, limit) as Omit<SearchHit, "score">[];
  return rows.map((r) => ({ ...r, score: 1 }));
}

export function stats(db: Database) {
  const one = (sql: string) => db.prepare(sql).get() as Record<string, number | string | null>;
  return {
    sessions: one("SELECT COUNT(*) n FROM sessions").n,
    excluded: one("SELECT COUNT(*) n FROM sessions WHERE status != 'indexed'").n,
    chunks: one("SELECT COUNT(*) n FROM chunks").n,
    oldest: one("SELECT MIN(time_created) t FROM chunks").t,
    newest: one("SELECT MAX(time_created) t FROM chunks").t,
    byDirectory: db
      .prepare("SELECT directory, COUNT(*) n FROM sessions WHERE status = 'indexed' GROUP BY directory ORDER BY n DESC LIMIT 10")
      .all(),
  };
}
