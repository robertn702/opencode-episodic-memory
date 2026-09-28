// Read-only access to OpenCode v2's session store (opencode.db).
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_SOURCE_DB = join(homedir(), ".local/share/opencode/opencode.db");
export const EXCLUDE_MARKER = "DO NOT INDEX THIS CHAT";

// Structural rows fail loudly on schema drift. JSON content degrades per row.
const SessionRowSchema = z.object({
  id: z.string(), project_id: z.string(), parent_id: z.string().nullable(),
  title: z.string().nullable(), directory: z.string(),
  time_created: z.number(), time_updated: z.number(),
});
export type SourceSession = Omit<z.infer<typeof SessionRowSchema>, "title"> & { title: string };
const MessageRowSchema = z.object({
  id: z.string(), type: z.string(), seq: z.number().int(),
  time_created: z.number(), data: z.string(),
});
type MessageRow = z.infer<typeof MessageRowSchema>;
const SeqRowSchema = z.object({ seq: z.number().int() });
const NameRowSchema = z.object({ name: z.string() });
const CountRowSchema = z.object({ n: z.number() });
const DataSchema = z.object({
  text: z.string().optional().catch(undefined),
  content: z.array(z.unknown()).optional().catch(undefined),
}).catch({});
const ContentSchema = z.object({
  type: z.string().catch("unknown"),
  text: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
}).catch({ type: "unknown" });
export interface SourcePart { type: string; text?: string; tool?: string }
export interface SourceMessage {
  id: string;
  role: string;
  timeCreated: number;
  parts: SourcePart[];
  contextPartsOmitted?: number;
}

const MAX_CONTEXT_PART_BYTES = 8_192;
const MAX_CONTEXT_PARTS_PER_MESSAGE = 20;
export const MAX_CONTEXT_MESSAGES = 20;

export function openSource(path: string = sourceDbPath()): Database {
  return new Database(path, { readonly: true });
}
export function sourceDbPath(): string {
  return process.env.EPISODIC_SOURCE_DB ?? DEFAULT_SOURCE_DB;
}

// The migration copies old conversations into these v2 tables. Retained v1
// tables are irrelevant to runtime reads; a partial v2 layout is an error.
export function sourceLayout(db: Database): "v2" {
  const tables = new Set(NameRowSchema.array().parse(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  ).map((row) => row.name));
  const required: Record<string, string[]> = {
    session_v2: ["id", "project_id", "parent_id", "title", "directory", "time_created", "time_updated", "time_archived"],
    session_message: ["id", "session_id", "type", "seq", "time_created", "data"],
  };
  for (const [table, columns] of Object.entries(required)) {
    if (!tables.has(table)) throw new Error(`Incomplete OpenCode v2 source layout: missing ${table}`);
    const present = new Set(NameRowSchema.array().parse(db.prepare(`PRAGMA table_info(${table})`).all()).map((row) => row.name));
    const missing = columns.filter((column) => !present.has(column));
    if (missing.length) throw new Error(`Incomplete OpenCode v2 source layout: ${table} missing ${missing.join(", ")}`);
  }
  return "v2";
}

function normalizeSession(row: z.infer<typeof SessionRowSchema>): SourceSession {
  return { ...row, title: row.title ?? "" };
}
export function listSessions(db: Database): SourceSession[] {
  sourceLayout(db);
  return SessionRowSchema.array().parse(db.prepare(
    `SELECT id, project_id, parent_id, title, directory, time_created, time_updated
     FROM session_v2 WHERE time_archived IS NULL ORDER BY time_created, id`
  ).all()).map(normalizeSession);
}
export function getSession(db: Database, sessionId: string): SourceSession | null {
  sourceLayout(db);
  const row = db.prepare(
    `SELECT id, project_id, parent_id, title, directory, time_created, time_updated
     FROM session_v2 WHERE id = ?`
  ).get(sessionId);
  return row == null ? null : normalizeSession(SessionRowSchema.parse(row));
}

// Authoritative privacy gate: exact case-sensitive substring scan of RAW
// message blobs. Malformed JSON and unmodeled nested fields still count.
export function transcriptHasMarker(db: Database, sessionId: string): boolean {
  sourceLayout(db);
  return CountRowSchema.parse(db.prepare(
    "SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND instr(data, ?) > 0"
  ).get(sessionId, EXCLUDE_MARKER)).n > 0;
}

function safeJsonParse(data: string): unknown {
  try { return JSON.parse(data); } catch { return undefined; }
}
function materialize(row: MessageRow, limits?: { maxPartBytes: number; maxPartsPerMessage: number }): SourceMessage {
  const data = DataSchema.parse(safeJsonParse(row.data));
  const parts: SourcePart[] = row.type === "user" || row.type === "synthetic" || row.type === "system"
    ? [{ type: "text", ...(data.text === undefined ? {} : { text: data.text }) }]
    : row.type === "assistant"
      ? (data.content ?? []).map((item) => {
          const content = ContentSchema.parse(item);
          return content.type === "tool"
            ? { type: "tool", ...(content.name === undefined ? {} : { tool: content.name }) }
            : { type: content.type, ...(content.text === undefined ? {} : { text: content.text }) };
        })
      : [];
  const selected = limits
    ? parts.filter((part) => Buffer.byteLength(JSON.stringify(part)) <= limits.maxPartBytes).slice(0, limits.maxPartsPerMessage)
    : parts;
  const omitted = parts.length - selected.length;
  return {
    id: row.id, role: row.type === "user" || row.type === "assistant" ? row.type : "unknown",
    timeCreated: row.time_created, parts: selected,
    ...(omitted > 0 ? { contextPartsOmitted: omitted } : {}),
  };
}
function getTranscript(db: Database, sessionId: string): SourceMessage[] {
  const rows = MessageRowSchema.array().parse(db.prepare(
    "SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq, id"
  ).all(sessionId));
  return rows.map((row) => materialize(row));
}
export type CheckedTranscript =
  | { excluded: true }
  | { excluded: false; messages: SourceMessage[] };
export function getTranscriptChecked(db: Database, sessionId: string): CheckedTranscript {
  return readSnapshot(db, () => {
    if (transcriptHasMarker(db, sessionId)) return { excluded: true };
    return { excluded: false, messages: getTranscript(db, sessionId) };
  });
}

export type TranscriptContext =
  | { ok: true; session: SourceSession; messages: SourceMessage[]; anchorIndex: number; sliceStart: number; total: number }
  | { ok: false; reason: "unknown_session" | "excluded" | "invalid_anchor" | "invalid_bounds" };
export function getTranscriptContext(
  db: Database, sessionId: string, anchorMessageId: string,
  before: number = 3, after: number = 3
): TranscriptContext {
  if (!isContextBound(before) || !isContextBound(after)) return { ok: false, reason: "invalid_bounds" };
  return readSnapshot(db, () => {
    if (transcriptHasMarker(db, sessionId)) return { ok: false, reason: "excluded" };
    const session = getSession(db, sessionId);
    if (!session) return { ok: false, reason: "unknown_session" };
    const anchorRow = db.prepare(
      "SELECT seq FROM session_message WHERE session_id = ? AND id = ? AND type = 'user'"
    ).get(sessionId, anchorMessageId);
    if (anchorRow == null) return { ok: false, reason: "invalid_anchor" };
    const anchor = SeqRowSchema.parse(anchorRow);
    const total = CountRowSchema.parse(db.prepare(
      "SELECT COUNT(*) AS n FROM session_message WHERE session_id = ?"
    ).get(sessionId)).n;
    const anchorIndex = CountRowSchema.parse(db.prepare(
      "SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND (seq < ? OR (seq = ? AND id < ?))"
    ).get(sessionId, anchor.seq, anchor.seq, anchorMessageId)).n;
    const sliceStart = Math.max(0, anchorIndex - before);
    const length = Math.min(total, anchorIndex + after + 1) - sliceStart;
    const rows = MessageRowSchema.array().parse(db.prepare(
      "SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq, id LIMIT ? OFFSET ?"
    ).all(sessionId, length, sliceStart));
    return {
      ok: true, session, anchorIndex, sliceStart, total,
      messages: rows.map((row) => materialize(row, {
        maxPartBytes: MAX_CONTEXT_PART_BYTES,
        maxPartsPerMessage: MAX_CONTEXT_PARTS_PER_MESSAGE,
      })),
    };
  });
}

// A read-only transaction pins the marker check and subsequent reads to one
// SQLite snapshot while OpenCode may be writing in WAL mode.
function readSnapshot<T>(db: Database, read: () => T): T {
  let active = false;
  try {
    db.run("BEGIN"); active = true;
    const result = read();
    db.run("COMMIT"); active = false;
    return result;
  } catch (error) {
    if (active) db.run("ROLLBACK");
    throw error;
  }
}
function isContextBound(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CONTEXT_MESSAGES;
}
