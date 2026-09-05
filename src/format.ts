// Shared presentation layer for the CLI and the plugin. Both stay thin: date
// parsing, date formatting, transcript→markdown, and search-hit formatting live
// here so the two front-ends can't drift apart.
import type { SourceMessage } from "./reader";
import type { IndexedWindowRow, SearchHit } from "./store";
import { Buffer } from "node:buffer";

const MAX_CONTEXT_BODY_BYTES = 600;
const MAX_CONTEXT_TOOLS_BYTES = 200;
const MAX_CONTEXT_FIELD_BYTES = 100;
const MAX_CONTEXT_SESSION_FIELD_BYTES = 300;

// Discriminated result so callers handle the parse error explicitly (no cast to
// strip the error arm off a union). `ms` is undefined when no date was given.
export type ParsedDate = { ok: true; ms?: number } | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Require strict YYYY-MM-DD, then round-trip to reject impossible calendar dates
// (`new Date("2024-02-31")` silently normalizes to March 2 rather than failing).
export function parseDateArg(s?: string): ParsedDate {
  if (!s) return { ok: true };
  const ms = new Date(s).getTime();
  if (!DATE_RE.test(s) || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== s) {
    return { ok: false, error: `Invalid date "${s}" (expected YYYY-MM-DD).` };
  }
  return { ok: true, ms };
}

export function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Render a full transcript as markdown:
//   # title
//   date — directory — id
//
//   ## role
//   text
//   *(tools: …)*
//
// A blank line follows every rendered message. Callers decide truncation (the
// plugin caps at 50k chars; the CLI prints in full).
export function renderTranscript(
  meta: { title: string; time_created: number; directory: string; id: string },
  messages: SourceMessage[]
): string {
  const lines: string[] = [
    `# ${meta.title}`,
    `${fmtDate(meta.time_created)} — ${meta.directory} — ${meta.id}`,
    "",
  ];
  for (const m of messages) {
    const text = m.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n");
    const tools = m.parts.filter((p) => p.type === "tool" && p.tool).map((p) => p.tool);
    if (!text && tools.length === 0) continue;
    lines.push(`## ${m.role}`);
    if (text) lines.push(text);
    if (tools.length) lines.push(`*(tools: ${tools.join(", ")})*`);
    lines.push("");
  }
  return lines.join("\n");
}

// Render a bounded live-source window around a search-hit anchor. The helper in
// reader.ts has already applied the privacy gate and validated the anchor.
export function renderTranscriptContext(
  meta: { title: string; time_created: number; directory: string; id: string },
  context: { messages: SourceMessage[]; anchorIndex: number; sliceStart: number; total: number }
): string {
  const lines = [
    `# ${truncateContext(meta.title, MAX_CONTEXT_SESSION_FIELD_BYTES)}`,
    `${fmtDate(meta.time_created)} — ${truncateContext(meta.directory, MAX_CONTEXT_SESSION_FIELD_BYTES)} — ${truncateContext(meta.id, MAX_CONTEXT_FIELD_BYTES)}`,
    `Context around message ${context.anchorIndex + 1}/${context.total}`,
    "",
  ];
  for (const [offset, message] of context.messages.entries()) {
    const position = context.sliceStart + offset;
    const text = message.parts.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n");
    const tools = message.parts.filter((part) => part.type === "tool" && part.tool).map((part) => part.tool);
    lines.push(`## ${truncateContext(message.role, MAX_CONTEXT_FIELD_BYTES)} — ${truncateContext(message.id, MAX_CONTEXT_FIELD_BYTES)} — ${position + 1}/${context.total}${position === context.anchorIndex ? " (anchor)" : ""}`);
    if (text) lines.push(truncateContext(text, MAX_CONTEXT_BODY_BYTES));
    if (tools.length) lines.push(truncateContext(`*(tools: ${tools.join(", ")})*`, MAX_CONTEXT_TOOLS_BYTES));
    if (message.contextPartsOmitted) lines.push(`*(${message.contextPartsOmitted} parts omitted from bounded context)*`);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderIndexedContext(sessionId: string, sourceId: string, anchorMessageId: string, rows: IndexedWindowRow[]): string {
  const lines = [
    "# Indexed excerpts (not a live transcript)",
    `source: ${truncateContext(sourceId, MAX_CONTEXT_FIELD_BYTES)}  session: ${truncateContext(sessionId, MAX_CONTEXT_FIELD_BYTES)}`,
    "Window bounds count condensed exchange chunks, not messages. Content may be stale until the source syncs.",
    "",
  ];
  for (const row of rows) {
    lines.push(`## Chunk ${row.seq}${row.anchor_message_id === anchorMessageId ? " (anchor)" : ""}`);
    lines.push(truncateContext(row.text, MAX_CONTEXT_BODY_BYTES), "");
  }
  return lines.join("\n");
}

function truncateContext(value: string, byteLimit: number): string {
  if (Buffer.byteLength(value, "utf8") <= byteLimit) return value;
  const suffix = "... [truncated]";
  const contentBudget = byteLimit - Buffer.byteLength(suffix, "utf8");
  let bytes = 0;
  let result = "";
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > contentBudget) break;
    result += codePoint;
    bytes += codePointBytes;
  }
  return result + suffix;
}

// One search hit as a markdown block. snippetLength defaults to 400 (plugin
// tool output); the CLI passes 220 to keep terminal output brief. scoreLabel
// names the score field: "score" for vector (cosine ~0.4–0.7) and BM25, "rrf"
// for hybrid (fused reciprocal-rank scores ~0.03, a different scale — see
// AGENTS.md) so the number isn't misread against the cosine thresholds.
export function formatHit(h: SearchHit, snippetLength = 400, scoreLabel = "score"): string {
  const snippet = h.text.replace(/\s+/g, " ").slice(0, snippetLength);
  const anchor = h.anchor_message_id ?? "unavailable (refresh/reindex required)";
  const source = h.source_id ? `source: ${h.source_id}\n` : "";
  return `## ${fmtDate(h.time_created)} — ${h.title}\n${source}session: ${h.session_id}  ${scoreLabel}: ${h.score.toFixed(3)}\nanchor: ${anchor}\n${h.directory}\n> ${snippet}`;
}

export function formatHits(hits: SearchHit[], snippetLength = 400, scoreLabel = "score"): string {
  return hits.map((h) => formatHit(h, snippetLength, scoreLabel)).join("\n\n");
}
