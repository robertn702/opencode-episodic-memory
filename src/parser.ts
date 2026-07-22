// Turn a raw transcript into condensed exchanges suitable for embedding.
// Keeps user text, assistant text, and tool *names* (not tool output, which is
// bulky and low-signal). Skips reasoning blobs and step markers.
import type { SourceMessage, SourcePart } from "./reader";

export const EXCLUDE_MARKER = "DO NOT INDEX THIS CHAT";

export interface Exchange {
  user: string;
  assistant: string;
  tools: string[];
  time: number;
}

const SKIP_PART_TYPES = new Set(["reasoning", "step-start", "step-finish", "file", "patch", "snapshot"]);

function textOf(parts: SourcePart[]): string {
  return parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!.trim())
    .filter(Boolean)
    .join("\n");
}

function toolNames(parts: SourcePart[]): string[] {
  return parts
    .filter((p) => p.type === "tool" && p.tool && !SKIP_PART_TYPES.has(p.type))
    .map((p) => p.tool!);
}

export function parseTranscript(messages: SourceMessage[]): {
  exchanges: Exchange[];
  excluded: boolean;
} {
  // Honor the opt-out marker anywhere in the conversation.
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.text?.includes(EXCLUDE_MARKER)) return { exchanges: [], excluded: true };
    }
  }

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

// Text that actually gets embedded for one exchange. Capped because MiniLM's
// window is 256 tokens; the head of an exchange carries the most signal.
export function exchangeText(sessionTitle: string, date: string, e: Exchange): string {
  const tools = e.tools.length ? `\nTools used: ${[...new Set(e.tools)].join(", ")}` : "";
  const body = `User: ${e.user}\nAssistant: ${e.assistant}${tools}`;
  return `${date} — ${sessionTitle}\n${body}`.slice(0, 4000);
}
