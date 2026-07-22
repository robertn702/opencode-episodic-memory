// OpenCode plugin: episodic memory over past conversations.
// - Native tools: episodic_search, episodic_read
// - Incremental reindex on session.idle (fire-and-forget, debounced)
import { type Plugin, tool } from "@opencode-ai/plugin";
import { openSource, getSession, getTranscriptChecked } from "../src/reader";
import { openIndex, search, textSearch, isIndexEmpty } from "../src/store";
import { syncSession, syncAll, pruneOrphans } from "../src/indexer";
import { embedQuery } from "../src/embed";
import { parseDateArg, formatHits, renderTranscript } from "../src/format";

export const EpisodicMemory: Plugin = async ({ client }) => {
  const log = (level: "info" | "warn" | "error", message: string) =>
    client.app
      .log({ body: { service: "episodic-memory", level, message } })
      .catch(() => {});

  // Debounce concurrent reindex runs for the same session.
  const inflight = new Map<string, Promise<void>>();
  function reindex(sessionId?: string) {
    const key = sessionId ?? "__all__";
    if (inflight.has(key)) return inflight.get(key)!;
    const p = (async () => {
      try {
        const source = openSource();
        const index = openIndex();
        if (sessionId) {
          const s = getSession(source, sessionId);
          if (s) await syncSession(source, index, s);
          // Cheap (two small SELECTs + rare DELETEs), so prune on every idle:
          // the syncAll path below effectively never fires (session.idle always
          // carries a sessionID), and without this, deleted conversations would
          // linger in the index — searchable and readable — for plugin-only users.
          pruneOrphans(source, index);
        } else {
          await syncAll(source, index); // syncAll prunes source-deleted orphans
        }
        await log("info", `reindexed ${key}`);
      } catch (e) {
        await log("warn", `reindex failed for ${key}: ${e}`);
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
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
          "Semantic search over your PAST OpenCode conversations. Use when the user references prior work, past decisions, or previous sessions (e.g. 'how did we handle X', 'the conversation about Y', 'what did we decide about Z'). Returns dated excerpts with session IDs; follow up with episodic_read for the full conversation.",
        args: {
          query: tool.schema.string().describe("Natural-language description of what you're looking for"),
          text: tool.schema.string().optional().describe("Exact substring to require in results (ANDed with semantic ranking)"),
          mode: tool.schema.enum(["vector", "text"]).optional().describe("'vector' (default) semantic search; 'text' exact substring only"),
          after: tool.schema.string().optional().describe("Only conversations after YYYY-MM-DD"),
          before: tool.schema.string().optional().describe("Only conversations before YYYY-MM-DD"),
          limit: tool.schema.number().optional().describe("Max results, 1-50 (default 10)"),
        },
        async execute(args) {
          const index = openIndex();
          const after = parseDateArg(args.after);
          if (!after.ok) return after.error;
          const before = parseDateArg(args.before);
          if (!before.ok) return before.error;
          const opts = {
            limit: Math.min(Math.max(args.limit ?? 10, 1), 50),
            after: after.ms,
            before: before.ms,
            text: args.text,
          };
          const hits =
            args.mode === "text"
              ? textSearch(index, args.query, opts)
              : search(index, (await embedQuery(args.query))[0], opts);
          if (hits.length === 0) {
            if (isIndexEmpty(index)) return "No matching past conversations found. The index is empty — run `bun run src/cli.ts sync` to index conversations.";
            return "No matching past conversations found.";
          }
          return formatHits(hits);
        },
      }),

      episodic_read: tool({
        description:
          "Read the full transcript of a past OpenCode conversation, given a session ID (from episodic_search results). Reconstructs from the live session store; falls back to indexed excerpts if the session was deleted.",
        args: {
          session_id: tool.schema.string().describe("Session ID, e.g. ses_..."),
          indexed: tool.schema.boolean().optional().describe("Force reading from the index instead of the live session store"),
        },
        async execute(args) {
          if (!args.indexed) {
            try {
              const source = openSource();
              const s = getSession(source, args.session_id);
              if (s) {
                // Privacy gate lives inside getTranscriptChecked (authoritative
                // raw-blob scan before any read).
                const checked = getTranscriptChecked(source, args.session_id);
                if (checked.excluded) {
                  return "Session is marked private (exclusion marker present); transcript withheld.";
                }
                return renderTranscript(s, checked.messages).slice(0, 50000);
              }
            } catch (e) {
              // Log before falling through — a bare swallow would also hide
              // structural Zod drift, which is meant to be loud.
              await log("warn", `episodic_read live-store read failed for ${args.session_id}: ${e}`);
              // fall through to indexed copy
            }
          }
          const index = openIndex();
          const rows = index
            .prepare<{ text: string }, [string]>("SELECT text FROM chunks WHERE session_id = ? ORDER BY seq")
            .all(args.session_id);
          if (rows.length === 0) return `No conversation found for session ${args.session_id}.`;
          return `(indexed excerpts — live session unavailable)\n\n${rows.map((r) => r.text).join("\n\n---\n\n")}`.slice(0, 50000);
        },
      }),
    },
  };
};

export default EpisodicMemory;
