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
    .prepare(
      `SELECT id, project_id, parent_id, title, directory, time_created, time_updated
       FROM session WHERE time_archived IS NULL ORDER BY time_created`
    )
    .all() as SourceSession[];
}

export function getSession(db: Database, sessionId: string): SourceSession | null {
  return (
    (db
      .prepare(
        `SELECT id, project_id, parent_id, title, directory, time_created, time_updated
         FROM session WHERE id = ?`
      )
      .get(sessionId) as SourceSession | null) ?? null
  );
}

export function getTranscript(db: Database, sessionId: string): SourceMessage[] {
  const messages = db
    .prepare(
      `SELECT id, time_created, data FROM message
       WHERE session_id = ? ORDER BY time_created, id`
    )
    .all(sessionId) as { id: string; time_created: number; data: string }[];

  const parts = db
    .prepare(
      `SELECT message_id, data FROM part
       WHERE session_id = ? ORDER BY time_created, id`
    )
    .all(sessionId) as { message_id: string; data: string }[];

  const partsByMsg = new Map<string, SourcePart[]>();
  for (const p of parts) {
    const d = JSON.parse(p.data) as SourcePart;
    let list = partsByMsg.get(p.message_id);
    if (!list) partsByMsg.set(p.message_id, (list = []));
    list.push(d);
  }

  return messages.map((m) => {
    const d = JSON.parse(m.data) as { role?: string };
    return {
      id: m.id,
      role: d.role ?? "unknown",
      timeCreated: m.time_created,
      parts: partsByMsg.get(m.id) ?? [],
    };
  });
}
