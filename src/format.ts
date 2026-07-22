// Shared presentation layer for the CLI and the plugin. Both stay thin: date
// parsing, date formatting, transcript→markdown, and search-hit formatting live
// here so the two front-ends can't drift apart.
import type { SourceMessage } from "./reader";
import type { SearchHit } from "./store";

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

// One search hit as a markdown block. snippetLength defaults to 400 (plugin
// tool output); the CLI passes 220 to keep terminal output brief. scoreLabel
// names the score field: "score" for vector (cosine ~0.4–0.7) and BM25, "rrf"
// for hybrid (fused reciprocal-rank scores ~0.03, a different scale — see
// AGENTS.md) so the number isn't misread against the cosine thresholds.
export function formatHit(h: SearchHit, snippetLength = 400, scoreLabel = "score"): string {
  const snippet = h.text.replace(/\s+/g, " ").slice(0, snippetLength);
  return `## ${fmtDate(h.time_created)} — ${h.title}\nsession: ${h.session_id}  ${scoreLabel}: ${h.score.toFixed(3)}\n${h.directory}\n> ${snippet}`;
}

export function formatHits(hits: SearchHit[], snippetLength = 400, scoreLabel = "score"): string {
  return hits.map((h) => formatHit(h, snippetLength, scoreLabel)).join("\n\n");
}
