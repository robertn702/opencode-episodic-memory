---
name: remembering-conversations
description: Recall past OpenCode conversations when the user references previous work, past decisions, or earlier sessions — "how did we handle X", "the conversation about Y", "what did we decide", "we tried this before", "last week we...". Use the episodic_search and episodic_read tools to search semantically and read full transcripts.
---

# Remembering Conversations

You have episodic memory: every past OpenCode session is indexed and searchable
via two native tools.

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
   - Narrow with `after`/`before` dates or an exact `text` substring when you know one
     (an error string, a flag name, a file path).
   - `mode: "text"` for exact-phrase lookup only.
2. Skim the returned excerpts (date, session title, score). Similarity scores are
   NOT calibrated probabilities: ≥ ~0.55 is a strong match, 0.4–0.55 is likely
   relevant, < ~0.35 is weak or merely adjacent — judge by the snippet, not the
   number, and say when the corpus doesn't really contain the topic.
3. `episodic_read` with the session ID for the full transcript when an excerpt
   isn't enough.

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
