---
name: remembering-conversations
description: Recall past OpenCode conversations when the user references previous work, past decisions, or earlier sessions — "how did we handle X", "the conversation about Y", "what did we decide", "we tried this before", "last week we...". Use episodic_search, then episodic_read_window for a bounded window, and episodic_read_session only when the full session is needed.
---

# Remembering Conversations

You have episodic memory: every past OpenCode session is indexed and searchable
via three native tools.

## When to search

Search proactively when:

- The user references prior work: "like we did with X", "the conversation about Y",
  "what did we decide about Z", "we tried that before"
- You're about to propose an approach the user may have already evaluated or rejected
- A bug or error message feels familiar ("didn't we see this before?")
- The user asks about their own history: "when did we set up X", "which repo was Y in"

Do NOT search for questions answerable from the current codebase or the current
conversation — the index is for cross-session recall, not code search.

## How

1. `episodic_search` with a natural-language query describing the *topic and intent*,
   not exact keywords ("migrating from Claude Code to OpenCode", not "claude opencode").
   - Narrow with `after`/`before` dates. Local indexes also support an exact `text`
     substring (an error string, a flag name, a file path).
   - On local indexes, use `mode: "text"` for lexical BM25 search: every query word must appear (token-based
     AND, BM25-ranked) — not phrase/adjacency or substring matching.
   - Remote indexes support only vector search, without `text` filtering. Include
     relevant terms in `query`; do not retry unsupported text/hybrid modes.
2. Skim the returned excerpts (date, session title, score, and anchor). Vector
   similarity scores are NOT calibrated probabilities: ≥ ~0.55 is a strong
   match, 0.4–0.55 is likely relevant, and < ~0.35 is weak or merely adjacent.
   These thresholds apply only to vector results. For hybrid results, use the
   snippet and the `rrf` label instead; RRF scores are on a different scale.
   Say when the corpus doesn't really contain the topic.
3. `episodic_read_window` with the result's session ID, anchor message ID, and
   `source_id` (required for remote indexes) to inspect a small window first.
   Current-source windows read privacy-gated live messages. Foreign-source windows
   read labeled indexed exchanges: `before`/`after` count chunks, not messages,
   and content may be stale until that source syncs. Missing or stale anchors
   cannot expand. Stop on privacy denials rather than trying indexed reads.
4. `episodic_read_session` with the session ID and the same `source_id` when the
   window is insufficient or unavailable. Use `indexed: true` for indexed excerpts,
   including legacy unanchored hits. Do not present these as a full live transcript.

## Answering

- Cite what you found with its date and session title ("on 2026-07-19, in
  'Fix login User-Agent to get past the bot wall', we concluded...").
- Distinguish "we decided X" from "we tried X and abandoned it" — the transcript
  usually records the verdict; report it accurately.
- If search returns nothing relevant, say "I don't have a past conversation about
  that" rather than confabulating.

## Limits

- Only OpenCode sessions are indexed (anything before the OpenCode switch is not,
  unless it lives in `opencode.db`).
- Conversations containing the marker `DO NOT INDEX THIS CHAT` are excluded — that
  includes conversations *about* this tool itself that quote the marker.
- Excerpts embed user/assistant text and tool names, not tool output.
