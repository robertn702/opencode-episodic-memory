// Incremental, idempotent indexer. Watermark = session.time_updated; a session
// is re-embedded only when the source changed since we last indexed it.
import type { Database } from "bun:sqlite";
import { getTranscriptChecked, listSessions, transcriptHasMarker, type SourceSession } from "./reader";
import { parseTranscript, exchangeText } from "./parser";
import { embed } from "./embed";
import type { IndexStore } from "./store";

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
  index: IndexStore,
  s: SourceSession,
  force = false
): Promise<"indexed" | "fresh" | "excluded" | "empty"> {
  const removeIfRemoteExcluded = async (): Promise<boolean> => {
    if (!index.remote || !transcriptHasMarker(source, s.id)) return false;
    await index.removeSession(s.id);
    return true;
  };
  // Remote freshness must never preserve metadata for a newly excluded session.
  // Local mode intentionally keeps its established cheap freshness-first path.
  const checked = index.remote ? getTranscriptChecked(source, s.id) : undefined;
  if (checked?.excluded) {
    await index.removeSession(s.id);
    return "excluded";
  }
  const prior = await index.getIndexedSession(s.id);
  if (await removeIfRemoteExcluded()) return "excluded";
  if (!force && prior && prior.source_time_updated >= s.time_updated) return "fresh";

  // Authoritative opt-out gate lives inside getTranscriptChecked (raw-blob
  // scan before any read); parseTranscript's own parsed-text check is a
  // harmless redundant fast path for the non-excluded branch.
  const transcript = checked ?? getTranscriptChecked(source, s.id);
  const { exchanges, excluded } = transcript.excluded
    ? { exchanges: [], excluded: true }
    : parseTranscript(transcript.messages);
  const meta = {
    id: s.id, project_id: s.project_id, parent_id: s.parent_id,
    title: s.title, directory: s.directory,
    time_created: s.time_created, source_time_updated: s.time_updated,
  };

  if (excluded) {
    // A remote index is an opt-in upload boundary: unlike the local index's
    // useful excluded tombstone, it must retain no metadata for marked chats.
    if (index.remote) await index.removeSession(s.id);
    else await index.replaceSessionChunks(meta, [], "excluded");
    return "excluded";
  }
  if (exchanges.length === 0) {
    if (await removeIfRemoteExcluded()) return "excluded";
    await index.replaceSessionChunks(meta, [], "empty");
    return "empty";
  }

  const date = new Date(s.time_created).toISOString().slice(0, 10);
  const texts = exchanges.map((e) => exchangeText(s.title, date, e));
  const vectors = await embed(texts);
  // Embedding can take long enough for the source conversation to change. Run
  // the cheap authoritative raw-marker check again immediately before a remote
  // upload so a marker added during embedding never exports the prepared data.
  if (await removeIfRemoteExcluded()) return "excluded";
  await index.replaceSessionChunks(
    meta,
    exchanges.map((e, i) => ({
      seq: i, time_created: e.time, text: texts[i], embedding: vectors[i], anchor_message_id: e.anchorMessageId,
    }))
  );
  return "indexed";
}

export async function syncAll(
  source: Database,
  index: IndexStore,
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
  result.pruned = await pruneOrphans(source, index, sessions);

  return result;
}

// Delete index rows (sessions + chunks) whose session has been removed from the
// source DB. Extracted so the plugin's full-reindex path can call it without
// re-running the whole sync. Pass already-fetched sessions to avoid a redundant
// query in syncAll; omitted, it re-reads the source.
export async function pruneOrphans(source: Database, index: IndexStore, knownSource?: SourceSession[]): Promise<number> {
  return index.pruneOrphans((knownSource ?? listSessions(source)).map((s) => s.id));
}
