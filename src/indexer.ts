// Incremental, idempotent indexer. Watermark = session.time_updated; a session
// is re-embedded only when the source changed since we last indexed it.
import type { Database } from "bun:sqlite";
import { getTranscript, listSessions, type SourceSession } from "./reader";
import { parseTranscript, exchangeText } from "./parser";
import { embed } from "./embed";
import { getIndexedSession, replaceSessionChunks } from "./store";

export interface SyncResult {
  scanned: number;
  indexed: number;
  skippedFresh: number;
  excluded: number;
  empty: number;
  pruned: number;
}

export async function syncSession(
  source: Database,
  index: Database,
  s: SourceSession,
  force = false
): Promise<"indexed" | "fresh" | "excluded" | "empty"> {
  const prior = getIndexedSession(index, s.id);
  if (!force && prior && prior.source_time_updated >= s.time_updated) return "fresh";

  const { exchanges, excluded } = parseTranscript(getTranscript(source, s.id));
  const meta = {
    id: s.id, project_id: s.project_id, parent_id: s.parent_id,
    title: s.title, directory: s.directory,
    time_created: s.time_created, source_time_updated: s.time_updated,
  };

  if (excluded) {
    replaceSessionChunks(index, meta, [], "excluded");
    return "excluded";
  }
  if (exchanges.length === 0) {
    replaceSessionChunks(index, meta, [], "empty");
    return "empty";
  }

  const date = new Date(s.time_created).toISOString().slice(0, 10);
  const texts = exchanges.map((e) => exchangeText(s.title, date, e));
  const vectors = await embed(texts);
  replaceSessionChunks(
    index,
    meta,
    exchanges.map((e, i) => ({ seq: i, time_created: e.time, text: texts[i], embedding: vectors[i] }))
  );
  return "indexed";
}

export async function syncAll(
  source: Database,
  index: Database,
  opts: { force?: boolean; onProgress?: (done: number, total: number, title: string) => void } = {}
): Promise<SyncResult> {
  const sessions = listSessions(source);
  const result: SyncResult = { scanned: sessions.length, indexed: 0, skippedFresh: 0, excluded: 0, empty: 0, pruned: 0 };
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const r = await syncSession(source, index, s, opts.force);
    if (r === "indexed") result.indexed++;
    else if (r === "fresh") result.skippedFresh++;
    else if (r === "excluded") result.excluded++;
    else result.empty++;
    opts.onProgress?.(i + 1, sessions.length, s.title);
  }

  // Prune index rows whose session no longer exists in the source DB;
  // otherwise their stale (possibly wrong-dims) chunks linger forever.
  result.pruned = pruneOrphans(source, index, sessions);

  return result;
}

// Delete index rows (sessions + chunks) whose session has been removed from the
// source DB. Extracted so the plugin's full-reindex path can call it without
// re-running the whole sync. Pass already-fetched sessions to avoid a redundant
// query in syncAll; omitted, it re-reads the source.
export function pruneOrphans(source: Database, index: Database, knownSource?: SourceSession[]): number {
  const sourceIds = new Set((knownSource ?? listSessions(source)).map((s) => s.id));
  const indexedIds = index.prepare("SELECT id FROM sessions").all() as { id: string }[];
  let pruned = 0;
  for (const { id } of indexedIds) {
    if (sourceIds.has(id)) continue;
    index.run("DELETE FROM chunks WHERE session_id = ?", [id]);
    index.run("DELETE FROM sessions WHERE id = ?", [id]);
    pruned++;
  }
  return pruned;
}
