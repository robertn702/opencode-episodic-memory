// Turn a raw transcript into condensed exchanges suitable for embedding.
// Keeps user text, assistant text, and tool *names* (not tool output, which is
// bulky and low-signal). Skips reasoning blobs and step markers.
import { EXCLUDE_MARKER, type SourceMessage, type SourcePart } from "./reader";

// Defined in reader.ts (single source of truth); re-exported for existing
// consumers of this module.
export { EXCLUDE_MARKER };

// Fast-path check over PARSED part text. Cheaper than the raw scan, but can
// miss the marker when a part blob fails to parse and degrades to
// text: undefined — the AUTHORITATIVE check is transcriptHasMarker() in
// reader.ts, which substring-matches the raw `data` column. Callers that gate
// privacy-sensitive paths should use the raw check; this remains useful for
// parseTranscript's in-memory flow and tests.
export function hasExcludeMarker(messages: SourceMessage[]): boolean {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.text?.includes(EXCLUDE_MARKER)) return true;
    }
  }
  return false;
}

export interface Exchange {
  user: string;
  assistant: string;
  tools: string[];
  time: number;
}

// reasoning blobs, step markers, and every other non-text/-tool part type are
// excluded implicitly: textOf keeps only type === "text" and toolNames only
// type === "tool", so nothing else can slip through.
function textOf(parts: SourcePart[]): string {
  return parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!.trim())
    .filter(Boolean)
    .join("\n");
}

function toolNames(parts: SourcePart[]): string[] {
  return parts
    .filter((p) => p.type === "tool" && p.tool)
    .map((p) => p.tool!);
}

export function parseTranscript(messages: SourceMessage[]): {
  exchanges: Exchange[];
  excluded: boolean;
} {
  // Honor the opt-out marker anywhere in the conversation.
  if (hasExcludeMarker(messages)) return { exchanges: [], excluded: true };

  const exchanges: Exchange[] = [];
  let current: Exchange | null = null;

  for (const m of messages) {
    if (m.role === "user") {
      const text = textOf(m.parts);
      if (!text) continue; // e.g. pure tool-result turns
      current = { user: text, assistant: "", tools: [], time: m.timeCreated };
      exchanges.push(current);
    } else if (m.role === "assistant" && current) {
      const text = textOf(m.parts);
      if (text) current.assistant = current.assistant ? `${current.assistant}\n${text}` : text;
      current.tools.push(...toolNames(m.parts));
    }
    // assistant messages before the first user message are dropped (no context)
  }

  return { exchanges: exchanges.filter((e) => e.user || e.assistant), excluded: false };
}

// Text stored per chunk (also displayed by episodic_read). Capped at 4000 chars
// to keep storage sane; the embedding step (embed.ts) further truncates to 2000
// chars where retrieval quality peaks. The head of an exchange carries the
// most signal.
export function exchangeText(sessionTitle: string, date: string, e: Exchange): string {
  const tools = e.tools.length ? `\nTools used: ${[...new Set(e.tools)].join(", ")}` : "";
  const body = `User: ${e.user}\nAssistant: ${e.assistant}${tools}`;
  return `${date} — ${sessionTitle}\n${body}`.slice(0, 4000);
}
