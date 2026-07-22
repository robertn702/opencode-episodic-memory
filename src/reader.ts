// Read-only access to OpenCode's session store (opencode.db).
// Schema (verified 2026-07-22): session / message / part tables, JSON blobs in `data`.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_SOURCE_DB = join(homedir(), ".local/share/opencode/opencode.db");

export interface SourceSession {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  directory: string;
  time_created: number;
  time_updated: number;
}

export interface SourcePart {
  type: string;
  text?: string;
  tool?: string;
}

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

export function listSessions(db: Database): SourceSession[] {
  return db
    .prepare<SourceSession, []>(
      `SELECT id, project_id, parent_id, title, directory, time_created, time_updated
       FROM session WHERE time_archived IS NULL ORDER BY time_created`
    )
    .all();
}

export function getSession(db: Database, sessionId: string): SourceSession | null {
  return (
    db
      .prepare<SourceSession, [string]>(
        `SELECT id, project_id, parent_id, title, directory, time_created, time_updated
         FROM session WHERE id = ?`
      )
      .get(sessionId) ?? null
  );
}

// JSON.parse returns `any`; these guards validate shape at runtime so no type
// assertion is needed. Malformed rows degrade gracefully (unknown type/role) —
// including a corrupt `data` blob whose JSON.parse throws, so one bad row can't
// abort the whole transcript read.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function safeParse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function parsePart(data: string): SourcePart {
  const raw = safeParse(data);
  if (!isRecord(raw)) return { type: "unknown" };
  return {
    type: typeof raw.type === "string" ? raw.type : "unknown",
    text: typeof raw.text === "string" ? raw.text : undefined,
    tool: typeof raw.tool === "string" ? raw.tool : undefined,
  };
}

function parseRole(data: string): string {
  const raw = safeParse(data);
  return isRecord(raw) && typeof raw.role === "string" ? raw.role : "unknown";
}

export function getTranscript(db: Database, sessionId: string): SourceMessage[] {
  const messages = db
    .prepare<{ id: string; time_created: number; data: string }, [string]>(
      `SELECT id, time_created, data FROM message
       WHERE session_id = ? ORDER BY time_created, id`
    )
    .all(sessionId);

  const parts = db
    .prepare<{ message_id: string; data: string }, [string]>(
      `SELECT message_id, data FROM part
       WHERE session_id = ? ORDER BY time_created, id`
    )
    .all(sessionId);

  const partsByMsg = new Map<string, SourcePart[]>();
  for (const p of parts) {
    const d = parsePart(p.data);
    let list = partsByMsg.get(p.message_id);
    if (!list) partsByMsg.set(p.message_id, (list = []));
    list.push(d);
  }

  return messages.map((m) => ({
    id: m.id,
    role: parseRole(m.data),
    timeCreated: m.time_created,
    parts: partsByMsg.get(m.id) ?? [],
  }));
}
