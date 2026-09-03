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
import type { Client, InStatement, Transaction } from "@libsql/client";
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
const REMOTE_PAGE_SIZE = 250;

export function indexDbPath(): string {
  return process.env.EPISODIC_INDEX_DB ?? DEFAULT_INDEX_DB;
}

export function openIndex(path: string = indexDbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
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
    anchor_message_id TEXT,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`);
  db.run("CREATE INDEX IF NOT EXISTS chunks_time_idx ON chunks(time_created)");

  // Full-text index over chunk text. External content (content='chunks') means
  // the text isn't duplicated; the FTS index is kept in sync by triggers on
  // chunks — robust to any write path (not just replaceSessionChunks), which is
  // the standard SQLite pattern for external-content FTS5.
  //
  // WARNING — never VACUUM this DB. content_rowid rides chunks' IMPLICIT rowid
  // (the PK is (session_id, seq), so there is no explicit INTEGER PRIMARY KEY
  // alias for rowid). VACUUM may renumber implicit rowids, which would silently
  // misalign every FTS posting from its chunk row. If VACUUM ever becomes
  // necessary, give chunks an explicit `rowid INTEGER PRIMARY KEY` first (a
  // migration) — do not just run it. See AGENTS.md.
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
  migrateAnchors(db);
  migrateFts(db);
  return db;
}

// Existing indexes predate per-exchange source anchors. Adding this nullable
// column preserves the chunks table's implicit rowids, which the external-
// content FTS table depends on. An immediate transaction serializes concurrent
// openIndex calls before the schema check; the busy timeout above lets a second
// opener wait for the first migration rather than racing a duplicate ALTER.
// Mark every existing session stale so its next normal sync replaces chunks with
// anchored versions; do not rebuild or VACUUM.
function migrateAnchors(db: Database): void {
  // The steady-state path stays read-like: don't take a write lock just to
  // confirm an already-migrated index has its anchor column.
  if (hasAnchorColumn(db)) return;
  let inTransaction = false;
  try {
    db.run("BEGIN IMMEDIATE");
    inTransaction = true;
    // A concurrent first opener may have completed migration while this caller
    // waited for the write lock, so re-check inside the atomic transaction.
    if (!hasAnchorColumn(db)) {
      db.run("ALTER TABLE chunks ADD COLUMN anchor_message_id TEXT");
      db.run("UPDATE sessions SET source_time_updated = -1");
    }
    db.run("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) db.run("ROLLBACK");
    throw error;
  }
}

function hasAnchorColumn(db: Database): boolean {
  return db.prepare<{ name: string }, []>("PRAGMA table_info(chunks)").all()
    .some((column) => column.name === "anchor_message_id");
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
  chunks: { seq: number; time_created: number; text: string; embedding: Float32Array; anchor_message_id?: string | null }[],
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
      "INSERT INTO chunks (session_id, seq, time_created, anchor_message_id, text, embedding) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const c of chunks) ins.run(s.id, c.seq, c.time_created, c.anchor_message_id ?? null, c.text, c.embedding);
  })();
}

export interface SearchHit {
  source_id?: string;
  session_id: string;
  seq: number;
  time_created: number;
  anchor_message_id?: string | null;
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
  source_id?: string;
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
  const detail = db.prepare<{ text: string; anchor_message_id: string | null; title: string; directory: string }, [string, number]>(
    `SELECT c.text, c.anchor_message_id, s.title, s.directory
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
      text: d.text, anchor_message_id: d.anchor_message_id, score: h.score, title: d.title, directory: d.directory,
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
  } catch (e) {
    // Degrade to the unranked LIKE scan ONLY for a malformed MATCH expression.
    // ftsQueryString fully quotes every token, so this is defensive/near-dead —
    // but a different SqliteError (e.g. a corrupt/missing FTS index) must NOT be
    // masked as "no ranking"; rethrow it so the real failure surfaces.
    if (e instanceof Error && e.message.includes("fts5: syntax error")) {
      return scoreLike(db, query, opts, depth);
    }
    throw e;
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

// Lexical BM25 search. NOTE the behavior change from the pre-FTS LIKE
// implementation: an empty or whitespace-only query now returns [] (the FTS
// MATCH expression is empty → matches nothing), whereas the old LIKE '%%' scan
// returned the most recent chunks. Callers wanting "recent" must query for it.
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

// The production boundary is intentionally small: local callers retain the
// synchronous helpers above, while configured indexes use this async shape so
// libSQL's network operations cannot be accidentally treated as local I/O.
export interface IndexStore {
  readonly remote: boolean;
  readonly sourceId?: string;
  getIndexedSession(id: string): Promise<IndexedSession | null>;
  replaceSessionChunks(
    session: { id: string; project_id: string; parent_id: string | null; title: string; directory: string; time_created: number; source_time_updated: number },
    chunks: { seq: number; time_created: number; text: string; embedding: Float32Array; anchor_message_id?: string | null }[],
    status?: string,
  ): Promise<void>;
  removeSession(id: string): Promise<void>;
  pruneOrphans(sourceIds: string[]): Promise<number>;
  search(query: Float32Array, opts?: SearchOptions): Promise<SearchHit[]>;
  textSearch(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  isEmpty(): Promise<boolean>;
  stats(): Promise<IndexStats>;
  readIndexed(sessionId: string, sourceId?: string): Promise<{ text: string }[]>;
  close(): void;
}

class LocalIndexStore implements IndexStore {
  readonly remote = false;
  constructor(private readonly db: Database) {}
  async getIndexedSession(id: string) { return getIndexedSession(this.db, id); }
  async replaceSessionChunks(...args: Parameters<IndexStore["replaceSessionChunks"]>) {
    replaceSessionChunks(this.db, ...args);
  }
  async removeSession(id: string) {
    this.db.transaction(() => {
      this.db.run("DELETE FROM chunks WHERE session_id = ?", [id]);
      this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
    })();
  }
  async pruneOrphans(sourceIds: string[]) {
    const ids = new Set(sourceIds);
    const rows = this.db.prepare<{ id: string }, []>("SELECT id FROM sessions").all();
    let pruned = 0;
    this.db.transaction(() => {
      for (const { id } of rows) {
        if (ids.has(id)) continue;
        this.db.run("DELETE FROM chunks WHERE session_id = ?", [id]);
        this.db.run("DELETE FROM sessions WHERE id = ?", [id]);
        pruned++;
      }
    })();
    return pruned;
  }
  async search(query: Float32Array, opts: SearchOptions = {}) { return search(this.db, query, opts); }
  async textSearch(query: string, opts: SearchOptions = {}) { return textSearch(this.db, query, opts); }
  async isEmpty() { return isIndexEmpty(this.db); }
  async stats() { return stats(this.db); }
  async readIndexed(sessionId: string) {
    return this.db.prepare<{ text: string }, [string]>("SELECT text FROM chunks WHERE session_id = ? ORDER BY seq").all(sessionId);
  }
  close() { this.db.close(); }
}

export function localIndexStore(db: Database): IndexStore {
  return new LocalIndexStore(db);
}

export interface RemoteIndexConfig { url: string; sourceId: string; authToken?: string; }

export function canLiveRead(config: RemoteIndexConfig | null, sourceId: string | undefined): boolean {
  return config === null || sourceId === config.sourceId;
}

export function remoteIndexConfig(env: NodeJS.ProcessEnv = process.env): RemoteIndexConfig | null {
  const url = env.EPISODIC_INDEX_URL;
  if (!url) return null;
  if (url.includes("\\")) throw new Error("EPISODIC_INDEX_URL must not contain backslashes.");
  const authority = /^\w+:\/\/([^/?#]*)/.exec(url)?.[1];
  if (authority?.includes("%")) throw new Error("EPISODIC_INDEX_URL must not percent-encode its authority.");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("EPISODIC_INDEX_URL must be a valid URL."); }
  if (parsed.protocol === "file:" && (!url.slice("file:".length).startsWith("/") || parsed.host)) {
    throw new Error("EPISODIC_INDEX_URL file URLs must use an absolute local path.");
  }
  if (parsed.username || parsed.password) throw new Error("EPISODIC_INDEX_URL must not contain credentials; use EPISODIC_INDEX_AUTH_TOKEN.");
  if ([...parsed.searchParams.keys()].some((key) => key.toLowerCase() === "authtoken")) {
    throw new Error("EPISODIC_INDEX_URL must not contain credentials; use EPISODIC_INDEX_AUTH_TOKEN.");
  }
  if (parsed.protocol === "http:" || parsed.protocol === "ws:") throw new Error("EPISODIC_INDEX_URL requires secure transport.");
  if (!["file:", "https:", "wss:", "libsql:"].includes(parsed.protocol)) throw new Error("EPISODIC_INDEX_URL must use file:, https:, wss:, or libsql:.");
  if (parsed.protocol !== "file:" && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(parsed.hostname)) {
    throw new Error("EPISODIC_INDEX_URL must use a canonical DNS hostname.");
  }
  if (parsed.protocol === "libsql:") {
    const queryStart = url.indexOf("?");
    const fragmentStart = url.indexOf("#", queryStart < 0 ? 0 : queryStart);
    const rawQuery = queryStart < 0 ? "" : url.slice(queryStart + 1, fragmentStart < 0 ? undefined : fragmentStart);
    if (parsed.hash || (rawQuery !== "" && rawQuery !== "tls=1")) {
      throw new Error("EPISODIC_INDEX_URL supports only the exact libsql query parameter tls=1.");
    }
  }
  const sourceId = env.EPISODIC_SOURCE_ID;
  if (!sourceId) throw new Error("EPISODIC_SOURCE_ID is required when EPISODIC_INDEX_URL is configured.");
  const authToken = env.EPISODIC_INDEX_AUTH_TOKEN;
  if (parsed.protocol !== "file:" && !authToken) throw new Error("EPISODIC_INDEX_AUTH_TOKEN is required for a remote EPISODIC_INDEX_URL.");
  return { url: parsed.href, sourceId, authToken };
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Remote index returned invalid ${key}.`);
  return value;
}

function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Remote index returned invalid ${key}.`);
  return value;
}

function rowNullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Remote index returned invalid ${key}.`);
  return value;
}

function rowBlob(row: Record<string, unknown>, key: string): Uint8Array {
  const value = row[key];
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  throw new Error(`Remote index returned invalid ${key}.`);
}

class RemoteIndexStore implements IndexStore {
  readonly remote = true;
  constructor(readonly sourceId: string, private readonly client: Client) {}

  static async open(url: string, sourceId: string, authToken?: string): Promise<RemoteIndexStore> {
    const { createClient } = await import("@libsql/client");
    const client = createClient({ url, authToken });
    const store = new RemoteIndexStore(sourceId, client);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await store.initialize();
          return store;
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("SQLITE_BUSY") || attempt === 9) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        }
      }
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private async tableExists(db: Pick<Transaction, "execute">, name: string): Promise<boolean> {
    const result = await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)", args: [name] });
    return result.rows.length > 0;
  }

  private async validateTable(db: Pick<Transaction, "execute">, name: string, requiredColumns: string[], primaryKey: string[]): Promise<void> {
    const result = await db.execute(`PRAGMA table_info(${name})`);
    const columns = result.rows.map((row) => ({ name: rowString(row, "name").toLowerCase(), pk: rowNumber(row, "pk") }));
    const actual = new Set(columns.map((column) => column.name));
    if (requiredColumns.some((column) => !actual.has(column.toLowerCase()))) {
      throw new Error(`Incompatible remote index schema: ${name} is missing required columns.`);
    }
    const actualPrimaryKey = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (actualPrimaryKey.join("\0") !== primaryKey.map((column) => column.toLowerCase()).join("\0")) {
      throw new Error(`Incompatible remote index schema: ${name} must use primary key (${primaryKey.join(", ")}).`);
    }
  }

  private async initialize(): Promise<void> {
    const transaction = await this.client.transaction("write");
    try {
      const versionsExist = await this.tableExists(transaction, "episodic_schema_versions");
      const initialVersion = versionsExist
        ? (await transaction.execute({ sql: "SELECT version FROM episodic_schema_versions WHERE name = ?", args: ["remote-index"] })).rows[0]
        : undefined;
      if (initialVersion) {
        const version = rowNumber(initialVersion, "version");
        if (version > 1) throw new Error(`Unsupported future remote index schema version: ${version}.`);
        if (version !== 1) throw new Error(`Unsupported remote index schema version: ${version}.`);
      }
      const sessionsExist = await this.tableExists(transaction, "episodic_sessions");
      const chunksExist = await this.tableExists(transaction, "episodic_chunks");
      if (sessionsExist !== chunksExist) throw new Error("Incompatible remote index schema: episodic_sessions and episodic_chunks must both exist.");
      if (sessionsExist) {
        await this.validateTable(transaction, "episodic_sessions", ["source_id", "session_id", "project_id", "parent_id", "title", "directory", "time_created", "source_time_updated", "indexed_at", "status"], ["source_id", "session_id"]);
        await this.validateTable(transaction, "episodic_chunks", ["source_id", "session_id", "seq", "time_created", "anchor_message_id", "text", "embedding"], ["source_id", "session_id", "seq"]);
      } else if (initialVersion) {
        throw new Error("Incompatible remote index schema: version 1 is missing required tables.");
      }

      if (!sessionsExist) {
        await transaction.batch([
          { sql: "CREATE TABLE IF NOT EXISTS episodic_schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL)" },
          { sql: `CREATE TABLE IF NOT EXISTS episodic_sessions (
            source_id TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT NOT NULL, parent_id TEXT,
            title TEXT NOT NULL, directory TEXT NOT NULL, time_created INTEGER NOT NULL,
            source_time_updated INTEGER NOT NULL, indexed_at INTEGER NOT NULL, status TEXT NOT NULL,
            PRIMARY KEY (source_id, session_id))` },
          { sql: `CREATE TABLE IF NOT EXISTS episodic_chunks (
            source_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
            anchor_message_id TEXT, text TEXT NOT NULL, embedding BLOB NOT NULL,
            PRIMARY KEY (source_id, session_id, seq))` },
          { sql: "CREATE INDEX IF NOT EXISTS episodic_chunks_time_idx ON episodic_chunks(time_created)" },
          { sql: "INSERT INTO episodic_schema_versions(name, version) VALUES ('remote-index', 1) ON CONFLICT(name) DO NOTHING" },
        ]);
      } else {
        // Existing tables were validated before this first write, so malformed
        // unversioned databases remain completely untouched.
        await transaction.batch([
          { sql: "CREATE TABLE IF NOT EXISTS episodic_schema_versions (name TEXT PRIMARY KEY, version INTEGER NOT NULL)" },
          { sql: "CREATE INDEX IF NOT EXISTS episodic_chunks_time_idx ON episodic_chunks(time_created)" },
          { sql: "INSERT INTO episodic_schema_versions(name, version) VALUES ('remote-index', 1) ON CONFLICT(name) DO NOTHING" },
        ]);
      }
      const versionResult = await transaction.execute({ sql: "SELECT version FROM episodic_schema_versions WHERE name = ?", args: ["remote-index"] });
      const versionRow = versionResult.rows[0];
      if (versionRow) {
        const version = rowNumber(versionRow, "version");
        if (version > 1) throw new Error(`Unsupported future remote index schema version: ${version}.`);
        if (version !== 1) throw new Error(`Unsupported remote index schema version: ${version}.`);
      } else throw new Error("Remote index schema version was not recorded.");
      await transaction.commit();
    } finally {
      transaction.close();
    }
  }

  async getIndexedSession(id: string): Promise<IndexedSession | null> {
    const result = await this.client.execute({ sql: "SELECT session_id AS id, project_id, parent_id, title, directory, time_created, source_time_updated, indexed_at, status FROM episodic_sessions WHERE source_id = ? AND session_id = ?", args: [this.sourceId, id] });
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: rowString(row, "id"), project_id: rowString(row, "project_id"), parent_id: rowNullableString(row, "parent_id"),
      title: rowString(row, "title"), directory: rowString(row, "directory"), time_created: rowNumber(row, "time_created"),
      source_time_updated: rowNumber(row, "source_time_updated"), indexed_at: rowNumber(row, "indexed_at"), status: rowString(row, "status"),
    };
  }

  async replaceSessionChunks(session: { id: string; project_id: string; parent_id: string | null; title: string; directory: string; time_created: number; source_time_updated: number }, chunks: { seq: number; time_created: number; text: string; embedding: Float32Array; anchor_message_id?: string | null }[], status: string = "indexed"): Promise<void> {
    const statements: InStatement[] = [{
      sql: `INSERT INTO episodic_sessions (source_id, session_id, project_id, parent_id, title, directory, time_created, source_time_updated, indexed_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, session_id) DO UPDATE SET project_id=excluded.project_id, parent_id=excluded.parent_id, title=excluded.title, directory=excluded.directory, time_created=excluded.time_created, source_time_updated=excluded.source_time_updated, indexed_at=excluded.indexed_at, status=excluded.status`,
      args: [this.sourceId, session.id, session.project_id, session.parent_id, session.title, session.directory, session.time_created, session.source_time_updated, Date.now(), status],
    }, { sql: "DELETE FROM episodic_chunks WHERE source_id = ? AND session_id = ?", args: [this.sourceId, session.id] }];
    for (const chunk of chunks) {
      statements.push({ sql: "INSERT INTO episodic_chunks (source_id, session_id, seq, time_created, anchor_message_id, text, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)", args: [this.sourceId, session.id, chunk.seq, chunk.time_created, chunk.anchor_message_id ?? null, chunk.text, new Uint8Array(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength)] });
    }
    await this.client.batch(statements, "write");
  }

  async removeSession(id: string): Promise<void> {
    await this.client.batch([
      { sql: "DELETE FROM episodic_chunks WHERE source_id = ? AND session_id = ?", args: [this.sourceId, id] },
      { sql: "DELETE FROM episodic_sessions WHERE source_id = ? AND session_id = ?", args: [this.sourceId, id] },
    ], "write");
  }

  async pruneOrphans(sourceIds: string[]): Promise<number> {
    const existing = await this.client.execute({ sql: "SELECT session_id FROM episodic_sessions WHERE source_id = ?", args: [this.sourceId] });
    const sourceSet = new Set(sourceIds);
    const stale = existing.rows.map((row) => rowString(row, "session_id")).filter((id) => !sourceSet.has(id));
    if (stale.length === 0) return 0;
    const statements = stale.flatMap((id) => [
      { sql: "DELETE FROM episodic_chunks WHERE source_id = ? AND session_id = ?", args: [this.sourceId, id] },
      { sql: "DELETE FROM episodic_sessions WHERE source_id = ? AND session_id = ?", args: [this.sourceId, id] },
    ]);
    await this.client.batch(statements, "write");
    return stale.length;
  }

  async search(query: Float32Array, opts: SearchOptions = {}): Promise<SearchHit[]> {
    if (opts.hybrid) throw new Error("Hybrid search is unavailable with EPISODIC_INDEX_URL; remote indexes support vector search only.");
    if (opts.text) throw new Error("Text filtering is unavailable with EPISODIC_INDEX_URL; remote indexes support vector search only.");
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (opts.after !== undefined) { clauses.push("c.time_created >= ?"); args.push(opts.after); }
    if (opts.before !== undefined) { clauses.push("c.time_created < ?"); args.push(opts.before); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const dims = query.length;
    const scored: ScoredChunk[] = [];
    const transaction = await this.client.transaction("read");
    try {
      for (let offset = 0; ; offset += REMOTE_PAGE_SIZE) {
        const result = await transaction.execute({ sql: `SELECT c.source_id, c.session_id, c.seq, c.time_created, c.embedding FROM episodic_chunks c ${where} ORDER BY c.source_id, c.session_id, c.seq LIMIT ? OFFSET ?`, args: [...args, REMOTE_PAGE_SIZE, offset] });
        for (const row of result.rows) {
          const blob = rowBlob(row, "embedding");
          if (blob.byteLength !== dims * 4) continue;
          const vector = new Float32Array(blob.buffer, blob.byteOffset, dims);
          let score = 0;
          for (let i = 0; i < dims; i++) score += query[i] * vector[i];
          if (score < (opts.minScore ?? 0)) continue;
          scored.push({ source_id: rowString(row, "source_id"), session_id: rowString(row, "session_id"), seq: rowNumber(row, "seq"), time_created: rowNumber(row, "time_created"), score });
        }
        if (result.rows.length < REMOTE_PAGE_SIZE) break;
      }
      const winners = scored.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 10);
      if (winners.length === 0) return [];
      const details = await transaction.batch(winners.map((winner) => ({
        sql: `SELECT c.text, c.anchor_message_id, s.title, s.directory FROM episodic_chunks c
          JOIN episodic_sessions s ON s.source_id = c.source_id AND s.session_id = c.session_id
          WHERE c.source_id = ? AND c.session_id = ? AND c.seq = ?`,
        args: [winner.source_id ?? "", winner.session_id, winner.seq],
      })));
      const hits: SearchHit[] = [];
      for (let i = 0; i < winners.length; i++) {
        const row = details[i].rows[0];
        if (!row) continue;
        const winner = winners[i];
        hits.push({ source_id: winner.source_id, session_id: winner.session_id, seq: winner.seq, time_created: winner.time_created, score: winner.score, text: rowString(row, "text"), anchor_message_id: rowNullableString(row, "anchor_message_id"), title: rowString(row, "title"), directory: rowString(row, "directory") });
      }
      return hits;
    } finally {
      transaction.close();
    }
  }

  async textSearch(): Promise<SearchHit[]> { throw new Error("Text search is unavailable with EPISODIC_INDEX_URL; remote indexes support vector search only."); }
  async isEmpty(): Promise<boolean> {
    const result = await this.client.execute("SELECT COUNT(*) AS n FROM episodic_chunks");
    const row = result.rows[0];
    return !row || rowNumber(row, "n") === 0;
  }
  async stats(): Promise<IndexStats> {
    const sessions = await this.client.execute("SELECT COUNT(*) AS n FROM episodic_sessions");
    const excluded = await this.client.execute("SELECT COUNT(*) AS n FROM episodic_sessions WHERE status != 'indexed'");
    const chunks = await this.client.execute("SELECT COUNT(*) AS n, MIN(time_created) AS oldest, MAX(time_created) AS newest FROM episodic_chunks");
    const directories = await this.client.execute("SELECT directory, COUNT(*) AS n FROM episodic_sessions WHERE status = 'indexed' GROUP BY directory ORDER BY n DESC LIMIT 10");
    const chunk = chunks.rows[0];
    if (!chunk) throw new Error("Remote stats query returned no row.");
    return { sessions: rowNumber(sessions.rows[0], "n"), excluded: rowNumber(excluded.rows[0], "n"), chunks: rowNumber(chunk, "n"), oldest: chunk.oldest === null ? null : rowNumber(chunk, "oldest"), newest: chunk.newest === null ? null : rowNumber(chunk, "newest"), byDirectory: directories.rows.map((row) => ({ directory: rowString(row, "directory"), n: rowNumber(row, "n") })) };
  }
  async readIndexed(sessionId: string, sourceId: string = this.sourceId): Promise<{ text: string }[]> {
    const result = await this.client.execute({ sql: "SELECT text FROM episodic_chunks WHERE source_id = ? AND session_id = ? ORDER BY seq", args: [sourceId, sessionId] });
    return result.rows.map((row) => ({ text: rowString(row, "text") }));
  }
  close() { this.client.close(); }
}

export async function openConfiguredIndex(): Promise<IndexStore> {
  const config = remoteIndexConfig();
  if (!config) return localIndexStore(openIndex());
  return RemoteIndexStore.open(config.url, config.sourceId, config.authToken);
}
