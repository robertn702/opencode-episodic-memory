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

const PartRowSchema = z.object({
  message_id: z.string(),
  data: z.string(),
});

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
}

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

export function getTranscript(db: Database, sessionId: string): SourceMessage[] {
  const messages = MessageRowSchema.array().parse(
    db
      .prepare(
        `SELECT id, time_created, data FROM message
         WHERE session_id = ? ORDER BY time_created, id`
      )
      .all(sessionId)
  );

  const parts = PartRowSchema.array().parse(
    db
      .prepare(
        `SELECT message_id, data FROM part
         WHERE session_id = ? ORDER BY time_created, id`
      )
      .all(sessionId)
  );

  const partsByMsg = new Map<string, SourcePart[]>();
  for (const p of parts) {
    const d = PartDataSchema.parse(safeJsonParse(p.data));
    let list = partsByMsg.get(p.message_id);
    if (!list) partsByMsg.set(p.message_id, (list = []));
    list.push(d);
  }

  return messages.map((m) => ({
    id: m.id,
    role: MessageDataSchema.parse(safeJsonParse(m.data)).role,
    timeCreated: m.time_created,
    parts: partsByMsg.get(m.id) ?? [],
  }));
}
