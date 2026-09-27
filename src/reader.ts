// Read-only access to OpenCode's session store (opencode.db).
// V1: session / message / part; V2: session_v2 / session_message.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_SOURCE_DB = join(homedir(), ".local/share/opencode/opencode.db");

// Opt-out marker. Matched as a BARE SUBSTRING anywhere in any message part —
// broader than upstream's full instruction-tag match, so it also fires on
// conversations that merely quote the phrase. Re-exported by parser.ts.
export const EXCLUDE_MARKER = "DO NOT INDEX THIS CHAT";

// --- Validation strategy ----------------------------------------------------
// Two surfaces, two failure modes (see AGENTS.md):
//   1. Structural rows we SELECT from opencode.db (columns: id, time_created,
//      data, ...). These are a uniform contract; if a column's type/nullability
//      drifts it drifts for every row, so we THROW (`.parse`) to surface
//      OpenCode schema changes loudly instead of silently mis-reading them.
//   2. The JSON blob inside each `data` column (message role, part contents).
//      This format evolves and carries many part shapes we don't model, so we
//      DEGRADE per-row to "unknown"/undefined (`.catch`): one corrupt or
//      unfamiliar blob can never abort a whole transcript read, and the parser
//      already filters unknown types/roles downstream.
// No `as` assertions: schemas narrow via `.parse()`.

// --- Structural row schemas (throw on drift) --------------------------------
const SessionRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  parent_id: z.string().nullable(),
  title: z.string(),
  directory: z.string(),
  time_created: z.number(),
  time_updated: z.number(),
});
export type SourceSession = z.infer<typeof SessionRowSchema>;
const V2SessionRowSchema = SessionRowSchema.extend({ title: z.string().nullable() });
const V2MessageRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  seq: z.number().int(),
  time_created: z.number(),
  data: z.string(),
});
type V2MessageRow = z.infer<typeof V2MessageRowSchema>;
const SeqRowSchema = z.object({ seq: z.number().int() });
const TableNameSchema = z.object({ name: z.string() });
const ColumnNameSchema = z.object({ name: z.string() });

export type SourceLayout = "v1" | "v2";

// A V2 migration keeps the V1 tables until completion. Prefer V2, but reject
// incomplete layouts even when the other family is usable: otherwise old part
// data could be silently skipped by the privacy scan.
export function sourceLayout(db: Database): SourceLayout {
  const tables = new Set(TableNameSchema.array().parse(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  ).map((row) => row.name));
  const families: { names: string[]; columns: Record<string, string[]> }[] = [
    { names: ["session", "message", "part"], columns: {
      session: ["id", "project_id", "parent_id", "title", "directory", "time_created", "time_updated", "time_archived"],
      message: ["id", "session_id", "time_created", "data"],
      part: ["id", "message_id", "session_id", "time_created", "data"],
    } },
    { names: ["session_v2", "session_message"], columns: {
      session_v2: ["id", "project_id", "parent_id", "title", "directory", "time_created", "time_updated", "time_archived"],
      session_message: ["id", "session_id", "type", "seq", "time_created", "data"],
    } },
  ];
  for (const family of families) {
    if (!family.names.some((name) => tables.has(name))) continue;
    const missing = family.names.filter((name) => !tables.has(name));
    if (missing.length) throw new Error(`Incomplete OpenCode source layout: missing ${missing.join(", ")}`);
    for (const name of family.names) {
      const columns = new Set(ColumnNameSchema.array().parse(
        db.prepare(`PRAGMA table_info(${name})`).all()
      ).map((row) => row.name));
      const required = family.columns[name];
      const absent = required.filter((column) => !columns.has(column));
      if (absent.length) throw new Error(`Incomplete OpenCode source layout: ${name} missing ${absent.join(", ")}`);
    }
  }
  if (tables.has("session_v2")) return "v2";
  if (tables.has("session")) return "v1";
  throw new Error("Unknown OpenCode source layout: expected session/message/part or session_v2/session_message");
}

// During V1 migration the V2 tables may be only partially populated. Resolve
// individual sessions against V2 when copied, otherwise retain their V1 rows.
export function sessionLayout(db: Database, sessionId: string): SourceLayout {
  const layout = sourceLayout(db);
  if (layout === "v1") return layout;
  const found = MarkerCountSchema.parse(db.prepare(
    "SELECT COUNT(*) AS n FROM session_v2 WHERE id = ?"
  ).get(sessionId)).n;
  return found > 0 || !hasLegacyTables(db) ? "v2" : "v1";
}

const MessageRowSchema = z.object({
  id: z.string(),
  time_created: z.number(),
  data: z.string(),
});
type SourceMessageRow = z.infer<typeof MessageRowSchema>;

const AnchorRowSchema = z.object({
  id: z.string(),
  time_created: z.number(),
});

const PartRowSchema = z.object({
  message_id: z.string(),
  data: z.string(),
});
type SourcePartRow = z.infer<typeof PartRowSchema>;

const PartCountSchema = z.object({ message_id: z.string(), n: z.number() });

// Aggregate row for the raw marker scan (structural: throw on drift).
const MarkerCountSchema = z.object({ n: z.number() });

// --- JSON blob schemas (degrade to "unknown" on mismatch) -------------------
const PartDataSchema = z
  .object({
    type: z.string().catch("unknown"),
    text: z.string().optional().catch(undefined),
    tool: z.string().optional().catch(undefined),
  })
  .catch({ type: "unknown" });
export type SourcePart = z.infer<typeof PartDataSchema>;

const MessageDataSchema = z
  .object({ role: z.string().catch("unknown") })
  .catch({ role: "unknown" });

export interface SourceMessage {
  id: string;
  role: string;
  timeCreated: number;
  parts: SourcePart[];
  contextPartsOmitted?: number;
}

const MAX_CONTEXT_PART_BYTES = 8_192;
const MAX_CONTEXT_PARTS_PER_MESSAGE = 20;

export function openSource(path: string = sourceDbPath()): Database {
  return new Database(path, { readonly: true });
}

export function sourceDbPath(): string {
  return process.env.EPISODIC_SOURCE_DB ?? DEFAULT_SOURCE_DB;
}

// JSON.parse throws on malformed input; return undefined so the blob schema's
// `.catch` fallback applies (one bad blob can't abort a transcript read).
function safeJsonParse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

export function listSessions(db: Database): SourceSession[] {
  const table = sourceLayout(db) === "v2" ? "session_v2" : "session";
  const rows = db
    .prepare(
      `SELECT id, project_id, parent_id, title, directory, time_created, time_updated
       FROM ${table} WHERE time_archived IS NULL ORDER BY time_created`
    )
    .all();
  if (table === "session") return SessionRowSchema.array().parse(rows);
  const v2 = V2SessionRowSchema.array().parse(rows).map((row) => ({ ...row, title: row.title ?? "" }));
  if (!hasLegacyTables(db)) return v2;
  const remaining = SessionRowSchema.array().parse(db.prepare(
    `SELECT id, project_id, parent_id, title, directory, time_created, time_updated FROM session
     WHERE time_archived IS NULL AND NOT EXISTS (SELECT 1 FROM session_v2 WHERE session_v2.id = session.id)`
  ).all());
  return [...v2, ...remaining].sort((a, b) => a.time_created - b.time_created);
}

export function getSession(db: Database, sessionId: string): SourceSession | null {
  const table = sessionLayout(db, sessionId) === "v2" ? "session_v2" : "session";
  const row = db
    .prepare(
      `SELECT id, project_id, parent_id, title, directory, time_created, time_updated
       FROM ${table} WHERE id = ?`
    )
    .get(sessionId);
  if (row === null || row === undefined) return null;
  if (table === "session") return SessionRowSchema.parse(row);
  const session = V2SessionRowSchema.parse(row);
  return { ...session, title: session.title ?? "" };
}

// AUTHORITATIVE exclusion check: bare-substring match over the RAW `data`
// column of the session's part rows, with no JSON parsing. The parsed-text
// scan (parser.ts hasExcludeMarker) can miss the marker when a part blob fails
// to parse and degrades to text: undefined — the privacy kill-switch must not
// depend on blob parseability. `instr` is an exact, case-sensitive substring
// match (unlike LIKE, which is case-insensitive and has wildcard chars).
export function transcriptHasMarker(db: Database, sessionId: string): boolean {
  const layout = sourceLayout(db);
  if (layout === "v2" && rawMarker(db, "session_message", sessionId)) return true;
  // Even after migration, legacy rows may remain; never let their marker leak.
  if (layout === "v1" || hasLegacyTables(db)) {
    return rawMarker(db, "part", sessionId) || rawMarker(db, "message", sessionId);
  }
  return false;
}

function hasLegacyTables(db: Database): boolean {
  return MarkerCountSchema.parse(db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'part'"
  ).get()).n > 0;
}

function rawMarker(db: Database, table: "session_message" | "part" | "message", sessionId: string): boolean {
  return MarkerCountSchema.parse(db.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ? AND instr(data, ?) > 0`
  ).get(sessionId, EXCLUDE_MARKER)).n > 0;
}

// Module-internal: the raw read with no privacy gate. Production code must go
// through getTranscriptChecked so the exclusion marker can never be bypassed by
// forgetting a manual transcriptHasMarker() call. Not exported.
function getTranscript(db: Database, sessionId: string): SourceMessage[] {
  if (sessionLayout(db, sessionId) === "v2") {
    const rows = V2MessageRowSchema.array().parse(db.prepare(
      "SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq"
    ).all(sessionId));
    return rows.map((row) => materializeV2(row));
  }
  const messages = MessageRowSchema.array().parse(
    db
      .prepare(
        `SELECT id, time_created, data FROM message
         WHERE session_id = ? ORDER BY time_created, id`
      )
      .all(sessionId)
  );
  return materializeMessages(db, sessionId, messages);
}

const V2DataSchema = z.object({
  text: z.string().optional().catch(undefined),
  content: z.array(z.unknown()).optional().catch(undefined),
}).catch({});
const V2ContentSchema = z.object({
  type: z.string().catch("unknown"),
  text: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
}).catch({ type: "unknown" });

function materializeV2(row: V2MessageRow, limits?: { maxPartBytes: number; maxPartsPerMessage: number }): SourceMessage {
  const data = V2DataSchema.parse(safeJsonParse(row.data));
  // V2 user text lives directly on data; assistant content is an inline array.
  // Non-conversational events are retained as unknown and filtered by parser.ts.
  const parts: SourcePart[] = row.type === "user" || row.type === "synthetic" || row.type === "system"
    ? [{ type: "text", ...(data.text === undefined ? {} : { text: data.text }) }]
    : row.type === "assistant"
      ? (data.content ?? []).map((item) => {
          const content = V2ContentSchema.parse(item);
          if (content.type === "tool") return { type: "tool", ...(content.name === undefined ? {} : { tool: content.name }) };
          return { type: content.type, ...(content.text === undefined ? {} : { text: content.text }) };
        })
      : [];
  const selected = limits
    ? parts.filter((part) => Buffer.byteLength(JSON.stringify(part)) <= limits.maxPartBytes).slice(0, limits.maxPartsPerMessage)
    : parts;
  const omitted = parts.length - selected.length;
  return {
    id: row.id,
    role: row.type === "user" || row.type === "assistant" ? row.type : "unknown",
    timeCreated: row.time_created,
    parts: selected,
    ...(omitted > 0 ? { contextPartsOmitted: omitted } : {}),
  };
}

// Parse parts only for the supplied message rows. Full transcript reads pass
// every row; bounded context reads pass just their selected SQL window.
function materializeMessages(
  db: Database,
  sessionId: string,
  messages: SourceMessageRow[],
  contextLimits?: { maxPartBytes: number; maxPartsPerMessage: number }
): SourceMessage[] {
  if (messages.length === 0) return [];
  const ids = messages.map((message) => message.id);
  const placeholders = ids.map(() => "?").join(", ");
  const materialized = contextLimits
    ? boundedParts(db, sessionId, ids, placeholders, contextLimits)
    : {
      rows: PartRowSchema.array().parse(
        db
          .prepare(
            `SELECT message_id, data FROM part
             WHERE session_id = ? AND message_id IN (${placeholders}) ORDER BY time_created, id`
          )
          .all(sessionId, ...ids)
      ),
      omittedByMessage: new Map<string, number>(),
    };

  const partsByMsg = new Map<string, SourcePart[]>();
  for (const p of materialized.rows) {
    const d = PartDataSchema.parse(safeJsonParse(p.data));
    let list = partsByMsg.get(p.message_id);
    if (!list) partsByMsg.set(p.message_id, (list = []));
    list.push(d);
  }

  return messages.map((m) => {
    const omitted = materialized.omittedByMessage.get(m.id) ?? 0;
    return {
      id: m.id,
      role: MessageDataSchema.parse(safeJsonParse(m.data)).role,
      timeCreated: m.time_created,
      parts: partsByMsg.get(m.id) ?? [],
      ...(omitted > 0 ? { contextPartsOmitted: omitted } : {}),
    };
  });
}

// Context-only part fetch: SQL excludes oversized raw blobs before they cross
// into JS, ranks remaining parts per selected message, and records omissions.
// Full transcript reads continue through the unbounded path above.
function boundedParts(
  db: Database,
  sessionId: string,
  ids: string[],
  placeholders: string,
  limits: { maxPartBytes: number; maxPartsPerMessage: number }
): { rows: SourcePartRow[]; omittedByMessage: Map<string, number> } {
  const counts = PartCountSchema.array().parse(
    db.prepare(
      `SELECT message_id, COUNT(*) AS n FROM part
       WHERE session_id = ? AND message_id IN (${placeholders}) GROUP BY message_id`
    ).all(sessionId, ...ids)
  );
  const rows = PartRowSchema.array().parse(
    db.prepare(
      `WITH ranked AS (
         SELECT message_id, data, time_created, id,
                ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY time_created, id) AS part_rank
         FROM part
         WHERE session_id = ? AND message_id IN (${placeholders})
           AND (data IS NULL OR length(CAST(data AS BLOB)) <= ?)
       )
       SELECT message_id, data FROM ranked WHERE part_rank <= ? ORDER BY time_created, id`
    ).all(sessionId, ...ids, limits.maxPartBytes, limits.maxPartsPerMessage)
  );
  const retained = new Map<string, number>();
  for (const row of rows) retained.set(row.message_id, (retained.get(row.message_id) ?? 0) + 1);
  const omittedByMessage = new Map<string, number>();
  for (const count of counts) {
    const omitted = count.n - (retained.get(count.message_id) ?? 0);
    if (omitted > 0) omittedByMessage.set(count.message_id, omitted);
  }
  return { rows, omittedByMessage };
}

// Discriminated result: excluded conversations never yield a transcript.
export type CheckedTranscript =
  | { excluded: true }
  | { excluded: false; messages: SourceMessage[] };

// The single privacy-gated entry point for reading a transcript. Runs the
// AUTHORITATIVE raw-blob exclusion check (transcriptHasMarker) BEFORE reading,
// so the opt-out marker cannot be bypassed by a caller forgetting to check.
// All production call sites (CLI read, plugin episodic_read_session, indexer) use this;
// the raw getTranscript is module-internal.
export function getTranscriptChecked(db: Database, sessionId: string): CheckedTranscript {
  return readSnapshot(db, () => {
    if (transcriptHasMarker(db, sessionId)) return { excluded: true };
    return { excluded: false, messages: getTranscript(db, sessionId) };
  });
}

export const MAX_CONTEXT_MESSAGES = 20;

export type TranscriptContext =
  | { ok: true; session: SourceSession; messages: SourceMessage[]; anchorIndex: number; sliceStart: number; total: number }
  | { ok: false; reason: "unknown_session" | "excluded" | "invalid_anchor" | "invalid_bounds" };

// Read a small, chronological live-source window around an indexed user-message
// anchor. This deliberately has no indexed fallback: an index may outlive its
// source transcript, but it cannot safely reconstruct source message context.
export function getTranscriptContext(
  db: Database,
  sessionId: string,
  anchorMessageId: string,
  before: number = 3,
  after: number = 3
): TranscriptContext {
  if (!isContextBound(before) || !isContextBound(after)) return { ok: false, reason: "invalid_bounds" };
  return readSnapshot(db, () => {
    // Keep the whole-session raw scan first: privacy is session-wide, while
    // every subsequent query stays bounded to the requested context window.
    if (transcriptHasMarker(db, sessionId)) return { ok: false, reason: "excluded" };
    const session = getSession(db, sessionId);
    if (!session) return { ok: false, reason: "unknown_session" };
    if (sessionLayout(db, sessionId) === "v2") {
      const anchorRow = db.prepare("SELECT seq FROM session_message WHERE session_id = ? AND id = ? AND type = 'user'").get(sessionId, anchorMessageId);
      if (anchorRow === null || anchorRow === undefined) return { ok: false, reason: "invalid_anchor" };
      const anchor = SeqRowSchema.parse(anchorRow);
      const total = MarkerCountSchema.parse(db.prepare(
        "SELECT COUNT(*) AS n FROM session_message WHERE session_id = ?"
      ).get(sessionId)).n;
      const anchorIndex = MarkerCountSchema.parse(db.prepare(
        "SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND seq < ?"
      ).get(sessionId, anchor.seq)).n;
      const sliceStart = Math.max(0, anchorIndex - before);
      // V2 nests all parts in one JSON blob; dropping an oversized blob would
      // also discard small neighboring text/tool parts. Bound selected rows and
      // rendered parts, while retaining the structural data validation.
      const rows = V2MessageRowSchema.array().parse(db.prepare(
        "SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq LIMIT ? OFFSET ?"
      ).all(sessionId, Math.min(total, anchorIndex + after + 1) - sliceStart, sliceStart));
      return {
        ok: true, session, anchorIndex, sliceStart, total,
        messages: rows.map((row) => materializeV2(row, {
            maxPartBytes: MAX_CONTEXT_PART_BYTES,
            maxPartsPerMessage: MAX_CONTEXT_PARTS_PER_MESSAGE,
          })),
      };
    }
    const anchorRow = db.prepare("SELECT id, time_created FROM message WHERE session_id = ? AND id = ?").get(sessionId, anchorMessageId);
    if (anchorRow === null || anchorRow === undefined) return { ok: false, reason: "invalid_anchor" };
    const anchor = AnchorRowSchema.parse(anchorRow);
    const total = MarkerCountSchema.parse(
      db.prepare("SELECT COUNT(*) AS n FROM message WHERE session_id = ?").get(sessionId)
    ).n;
    const anchorIndex = MarkerCountSchema.parse(
      db.prepare(
        `SELECT COUNT(*) AS n FROM message
         WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?))`
      ).get(sessionId, anchor.time_created, anchor.time_created, anchor.id)
    ).n;
    const sliceStart = Math.max(0, anchorIndex - before);
    const sliceEnd = Math.min(total, anchorIndex + after + 1);
    const sliceLength = sliceEnd - sliceStart;
    const rows = MessageRowSchema.array().parse(
      db.prepare(
        `SELECT id, time_created, data FROM message
         WHERE session_id = ? ORDER BY time_created, id LIMIT ? OFFSET ?`
      ).all(sessionId, sliceLength, sliceStart)
    );
    return {
      ok: true,
      session,
      messages: materializeMessages(db, sessionId, rows, {
        maxPartBytes: MAX_CONTEXT_PART_BYTES,
        maxPartsPerMessage: MAX_CONTEXT_PARTS_PER_MESSAGE,
      }),
      anchorIndex,
      sliceStart,
      total,
    };
  });
}

// BEGIN is deferred, so this remains a read transaction against the readonly
// source DB while pinning all context queries to one SQLite snapshot.
function readSnapshot<T>(db: Database, read: () => T): T {
  let active = false;
  try {
    db.run("BEGIN");
    active = true;
    const result = read();
    db.run("COMMIT");
    active = false;
    return result;
  } catch (error) {
    if (active) db.run("ROLLBACK");
    throw error;
  }
}

function isContextBound(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CONTEXT_MESSAGES;
}
