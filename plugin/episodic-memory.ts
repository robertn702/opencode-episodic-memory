// OpenCode plugin: episodic memory over past conversations.
// - Native tools: episodic_search, episodic_read_window, episodic_read_session
// - Incremental reindex on session.idle (fire-and-forget, debounced)
import { type Plugin, tool } from "@opencode-ai/plugin";
import { openSource, getSession, getTranscriptChecked, getTranscriptContext, transcriptHasMarker } from "../src/reader";
import { canLiveRead, openConfiguredIndex, remoteIndexConfig, type IndexStore } from "../src/store";
import { syncSession, syncAll, pruneOrphans } from "../src/indexer";
import { embedQuery } from "../src/embed";
import { parseDateArg, formatHits, renderTranscript, renderTranscriptContext, renderIndexedContext } from "../src/format";

export const EpisodicMemory: Plugin = async ({ client }) => {
  const remoteSearch = Boolean(process.env.EPISODIC_INDEX_URL);
  const log = (level: "info" | "warn" | "error", message: string) =>
    client.app
      .log({ body: { service: "episodic-memory", level, message } })
      .catch(() => {});
  let configuredIndex: Promise<IndexStore> | undefined;
  const getIndex = () => configuredIndex ??= openConfiguredIndex().catch((error) => {
    configuredIndex = undefined;
    throw error;
  });

  // Debounce concurrent reindex runs for the same session.
  const inflight = new Map<string, Promise<void>>();
  const pending = new Set<string>();
  function reindex(sessionId?: string) {
    const key = sessionId ?? "__all__";
    if (inflight.has(key)) {
      pending.add(key);
      return inflight.get(key)!;
    }
    const p = (async () => {
      do {
        pending.delete(key);
        try {
          const source = openSource();
          const index = await getIndex();
          if (sessionId) {
            const s = getSession(source, sessionId);
            if (s) await syncSession(source, index, s);
            // Cheap (two small SELECTs + rare DELETEs), so prune on every idle:
            // the syncAll path below effectively never fires (session.idle always
            // carries a sessionID), and without this, deleted conversations would
            // linger in the index — searchable and readable — for plugin-only users.
            await pruneOrphans(source, index);
          } else {
            await syncAll(source, index); // syncAll prunes source-deleted orphans
          }
          await log("info", `reindexed ${key}`);
        } catch (e) {
          await log("warn", `reindex failed for ${key}: ${e}`);
        }
      } while (pending.has(key));
    })();
    inflight.set(key, p);
    p.finally(() => inflight.delete(key));
    return p;
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        // event is narrowed to EventSessionIdle here; properties.sessionID is typed.
        reindex(event.properties.sessionID); // fire-and-forget; never block the session
      }
    },

    tool: {
      episodic_search: tool({
        description:
          "Semantic search over your PAST OpenCode conversations. Use when the user references prior work, past decisions, or previous sessions (e.g. 'how did we handle X', 'the conversation about Y', 'what did we decide about Z'). Returns dated excerpts, session IDs, and anchors. Prefer episodic_search -> episodic_read_window for bounded context -> episodic_read_session only when more context is needed." +
          (remoteSearch ? " Remote index: vector search only, without text filtering. Preserve source_id when reading hits; foreign-source windows contain indexed excerpts, not live messages." : ""),
        args: {
          query: tool.schema.string().describe("Natural-language description of what you're looking for"),
          ...(!remoteSearch ? { text: tool.schema.string().optional().describe("Exact substring to require in results (ANDed with semantic ranking)") } : {}),
          mode: tool.schema.enum(remoteSearch ? ["vector"] : ["vector", "text", "hybrid"]).optional().describe(remoteSearch
            ? "'vector' (default): the only supported remote mode. Scores are cosine (~0.4-0.7)."
            : "'vector' (default) semantic search, scores are cosine (~0.4–0.7); 'text' lexical BM25; 'hybrid' fuses both via RRF (may surface lexical noise) — note hybrid hits carry fused RRF scores (~0.03), a DIFFERENT scale from cosine, so don't judge them against the vector thresholds"),
          after: tool.schema.string().optional().describe("Only conversations after YYYY-MM-DD"),
          before: tool.schema.string().optional().describe("Only conversations before YYYY-MM-DD"),
          limit: tool.schema.number().optional().describe("Max results, 1-50 (default 10)"),
        },
        async execute(args) {
          if (remoteIndexConfig() && (args.mode === "text" || args.mode === "hybrid" || args.text !== undefined)) {
            return 'Remote indexes support vector search only, without text filtering. Retry with mode: "vector" and omit text; include relevant terms in query. Use a local index for exact text filtering, BM25, or hybrid search. No search was run.';
          }
          const index = await getIndex();
          const after = parseDateArg(args.after);
          if (!after.ok) return after.error;
          const before = parseDateArg(args.before);
          if (!before.ok) return before.error;
          const opts = {
            limit: Math.min(Math.max(args.limit ?? 10, 1), 50),
            after: after.ms,
            before: before.ms,
            text: typeof args.text === "string" ? args.text : undefined,
          };
          const noHits = async () => await index.isEmpty()
            ? "No matching past conversations found. The index is empty — run `bun run src/cli.ts sync` to index conversations."
            : "No matching past conversations found.";
          if (args.mode === "text") {
            const hits = await index.textSearch(args.query, opts);
            if (hits.length === 0) return noHits();
            return formatHits(hits, 400, "score");
          }
          let vector: Float32Array;
          try {
            vector = (await embedQuery(args.query))[0];
          } catch (e) {
            await log("warn", `episodic_search embedding failed: ${e instanceof Error ? e.message : e}`);
            return index.remote
              ? "Semantic search unavailable: the embedding backend failed. Remote indexes support vector search only; run `bun run src/cli.ts doctor` for details."
              : 'Semantic search unavailable: the embedding backend failed. Use mode: "text" for embedding-free lexical search, or run `bun run src/cli.ts doctor` for details.';
          }
          const hits = args.mode === "hybrid"
            ? await index.search(vector, { ...opts, queryText: args.query, hybrid: true })
            : await index.search(vector, opts);
          if (hits.length === 0) return noHits();
          // Hybrid hits carry RRF scores (~0.03), not cosine — label them "rrf".
          return formatHits(hits, 400, args.mode === "hybrid" ? "rrf" : "score");
        },
      }),

      episodic_read_window: tool({
        description:
          "Read bounded context around an anchor from episodic_search. Preserve session_id, anchor_message_id, and source_id. Current-source hits use privacy-gated live messages; foreign-source hits use labeled indexed condensed exchanges that may be stale. Missing or stale anchors cannot provide a window; use episodic_read_session with source_id and indexed: true for indexed excerpts instead.",
        args: {
          session_id: tool.schema.string().describe("Session ID from episodic_search, e.g. ses_..."),
          source_id: tool.schema.string().optional().describe("Source ID shown by remote episodic_search results; required for remote indexes"),
          anchor_message_id: tool.schema.string().describe("Anchor message ID from episodic_search"),
          before: tool.schema.number().optional().describe("Messages before the anchor, or indexed chunks for a foreign source, 0-20 (default 3)"),
          after: tool.schema.number().optional().describe("Messages after the anchor, or indexed chunks for a foreign source, 0-20 (default 3)"),
        },
        async execute(args) {
          const remote = remoteIndexConfig();
          if (remote && !args.source_id) {
            throw new Error("source_id is required for episodic_read_window with a remote index. Use the source from the search hit.");
          }
          if (args.source_id && !canLiveRead(remote, args.source_id)) {
            const index = await getIndex();
            const rows = await index.readIndexedWindow(args.session_id, args.anchor_message_id, args.before, args.after, args.source_id);
            if (rows.length === 0) {
              throw new Error('No indexed window found for this source, session, and anchor. The anchor may be stale; use episodic_read_session with the same session_id, source_id, and indexed: true for available indexed excerpts.');
            }
            return renderIndexedContext(args.session_id, args.source_id, args.anchor_message_id, rows);
          }
          const source = openSource();
          const context = getTranscriptContext(source, args.session_id, args.anchor_message_id, args.before, args.after);
          if (!context.ok) {
            if (context.reason === "unknown_session") throw new Error(`No live conversation found for session ${args.session_id}.`);
            if (context.reason === "excluded") throw new Error("Session is marked private (exclusion marker present); context withheld.");
            if (context.reason === "invalid_anchor") throw new Error(`Anchor message ${args.anchor_message_id} is stale or invalid for session ${args.session_id}.`);
            throw new Error("before and after must be non-negative integers no greater than 20.");
          }
          return renderTranscriptContext(context.session, context);
        },
      }),

      episodic_read_session: tool({
        description:
          "Read the full transcript of a past OpenCode session, given a session ID (from episodic_search results). Use after episodic_read_window when the bounded window is insufficient. Reconstructs from the live session store; falls back to indexed excerpts if the session was deleted.",
        args: {
          session_id: tool.schema.string().describe("Session ID, e.g. ses_..."),
          source_id: tool.schema.string().optional().describe("Source ID shown by remote episodic_search results"),
          indexed: tool.schema.boolean().optional().describe("Force reading from the index instead of the live session store"),
        },
        async execute(args) {
          const remote = remoteIndexConfig();
          if (remote && args.source_id === undefined) {
            throw new Error("source_id is required for episodic_read_session with a remote index.");
          }
          const foreign = !canLiveRead(remote, args.source_id);
          if (!foreign) {
            try {
              const source = openSource();
              try {
                // Explicit indexed reads must also respect a marker added since sync.
                if (transcriptHasMarker(source, args.session_id)) {
                  return "Session is marked private (exclusion marker present); transcript withheld.";
                }
                if (!args.indexed) {
                  const s = getSession(source, args.session_id);
                  if (s) {
                    const checked = getTranscriptChecked(source, args.session_id);
                    if (checked.excluded) {
                      return "Session is marked private (exclusion marker present); transcript withheld.";
                    }
                    return renderTranscript(s, checked.messages).slice(0, 50000);
                  }
                }
              } finally {
                source.close();
              }
            } catch (e) {
              await log("warn", `episodic_read_session live-store read failed for ${args.session_id}: ${e}`);
              return "Live-source validation failed; indexed content withheld because current privacy status could not be verified.";
            }
          }
          const index = await getIndex();
          const rows = await index.readIndexed(args.session_id, args.source_id);
          if (rows.length === 0) return `No conversation found for session ${args.session_id}.`;
          return `(indexed excerpts — live session unavailable)\n\n${rows.map((r) => r.text).join("\n\n---\n\n")}`.slice(0, 50000);
        },
      }),
    },
  };
};

export default EpisodicMemory;
