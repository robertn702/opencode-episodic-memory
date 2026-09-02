// Read-only access to OpenCode's session store (opencode.db).
// Schema (verified 2026-07-22): session / message / part tables, JSON blobs in `data`.
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
  const rows = db
    .prepare(
      `SELECT id, project_id, parent_id, title, directory, time_created, time_updated
       FROM session WHERE time_archived IS NULL ORDER BY time_created`
    )
    .all();
  return SessionRowSchema.array().parse(rows);
}

export function getSession(db: Database, sessionId: string): SourceSession | null {
  const row = db
    .prepare(
      `SELECT id, project_id, parent_id, title, directory, time_created, time_updated
       FROM session WHERE id = ?`
    )
    .get(sessionId);
  return row === null || row === undefined ? null : SessionRowSchema.parse(row);
}

// AUTHORITATIVE exclusion check: bare-substring match over the RAW `data`
// column of the session's part rows, with no JSON parsing. The parsed-text
// scan (parser.ts hasExcludeMarker) can miss the marker when a part blob fails
// to parse and degrades to text: undefined — the privacy kill-switch must not
// depend on blob parseability. `instr` is an exact, case-sensitive substring
// match (unlike LIKE, which is case-insensitive and has wildcard chars).
export function transcriptHasMarker(db: Database, sessionId: string): boolean {
  const row = MarkerCountSchema.parse(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM part
         WHERE session_id = ? AND instr(data, ?) > 0`
      )
      .get(sessionId, EXCLUDE_MARKER)
  );
  return row.n > 0;
}

// Module-internal: the raw read with no privacy gate. Production code must go
// through getTranscriptChecked so the exclusion marker can never be bypassed by
// forgetting a manual transcriptHasMarker() call. Not exported.
function getTranscript(db: Database, sessionId: string): SourceMessage[] {
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
  if (transcriptHasMarker(db, sessionId)) return { excluded: true };
  return { excluded: false, messages: getTranscript(db, sessionId) };
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
