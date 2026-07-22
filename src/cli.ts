#!/usr/bin/env bun
// opencode-episodic <command> [options]
//   sync [--force]                 Index new/changed sessions from opencode.db
//   search <query> [options]       Semantic search over indexed conversations
//     --text "phrase"              Exact substring match instead of vector
//     --after YYYY-MM-DD           Only conversations after this date
//     --before YYYY-MM-DD          Only conversations before this date
//     --limit N                    Max results (default 10)
//   read <session-id> [--indexed]  Print a readable transcript (live DB, or --indexed for index copy)
//   stats                          Index statistics
//   doctor                         Diagnose setup
import { existsSync } from "node:fs";
import { openSource, sourceDbPath, getSession, getTranscript, transcriptHasMarker } from "./reader";
import { openIndex, indexDbPath, search, textSearch, stats, type SearchHit } from "./store";
import { syncAll } from "./indexer";
import { embed, embedQuery } from "./embed";

const [, , command, ...rest] = process.argv;

function flag(name: string): string | null {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] ?? null : null;
}
function hasFlag(name: string): boolean {
  return rest.includes(`--${name}`);
}
const VALUE_FLAGS = new Set(["--text", "--after", "--before", "--limit"]);
function positional(): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t.startsWith("--")) {
      if (VALUE_FLAGS.has(t)) {
        const next = rest[i + 1];
        if (next === undefined || next.startsWith("--")) {
          console.error(`error: ${t} requires a value`);
          process.exit(1);
        }
        i++; // only value flags consume the next token
      }
      continue;
    }
    out.push(t);
  }
  return out;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Require strict YYYY-MM-DD, then round-trip to reject impossible calendar dates
// (`new Date("2024-02-31")` silently normalizes to March 2 rather than failing).
const dateMs = (s: string | null): number | undefined => {
  if (!s) return undefined;
  const ms = new Date(s).getTime();
  if (!DATE_RE.test(s) || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== s) {
    console.error(`error: invalid date "${s}" (expected YYYY-MM-DD)`);
    process.exit(1);
  }
  return ms;
};

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function printHits(hits: SearchHit[]): void {
  if (hits.length === 0) { console.log("No results."); return; }
  for (const h of hits) {
    const snippet = h.text.replace(/\s+/g, " ").slice(0, 220);
    console.log(`## ${fmtDate(h.time_created)} — ${h.title}`);
    console.log(`session: ${h.session_id}  score: ${h.score.toFixed(3)}`);
    console.log(`${h.directory}`);
    console.log(`> ${snippet}\n`);
  }
}

async function main() {
  switch (command) {
    case "sync": {
      const source = openSource();
      const index = openIndex();
      const r = await syncAll(source, index, {
        force: hasFlag("force"),
        onProgress: (done, total, title) =>
          process.stderr.write(`\r[${done}/${total}] ${title.slice(0, 60)}                    `),
      });
      process.stderr.write("\n");
      console.log(
        `scanned=${r.scanned} indexed=${r.indexed} fresh=${r.skippedFresh} excluded=${r.excluded} empty=${r.empty} pruned=${r.pruned}`
      );
      break;
    }

    case "search": {
      const query = positional().join(" ");
      if (!query) { console.error("usage: opencode-episodic search <query> [--text p] [--after d] [--before d] [--limit n]"); process.exit(1); }
      const index = openIndex();
      const opts = {
        limit: Number(flag("limit") ?? 10),
        after: dateMs(flag("after")),
        before: dateMs(flag("before")),
      };
      const textFlag = flag("text");
      const hits = textFlag
        ? textSearch(index, textFlag, opts)
        : search(index, (await embedQuery(query))[0], opts);
      if (hits.length === 0 && stats(index).chunks === 0) {
        console.log("No results. The index is empty — run: bun run src/cli.ts sync");
      } else {
        printHits(hits);
      }
      break;
    }

    case "read": {
      const id = positional()[0];
      if (!id) { console.error("usage: opencode-episodic read <session-id> [--indexed]"); process.exit(1); }
      if (hasFlag("indexed")) {
        const index = openIndex();
        const rows = index
          .prepare<{ seq: number; text: string }, [string]>("SELECT seq, text FROM chunks WHERE session_id = ? ORDER BY seq")
          .all(id);
        if (rows.length === 0) { console.error("no indexed content for", id); process.exit(1); }
        for (const r of rows) console.log(r.text, "\n---");
        break;
      }
      const source = openSource();
      const s = getSession(source, id);
      if (!s) { console.error("session not found:", id); process.exit(1); }
      // Authoritative gate: raw part blobs (a marker in an unparseable blob
      // would be invisible to the parsed-text scan).
      if (transcriptHasMarker(source, id)) {
        console.error("session is marked private (exclusion marker present); transcript withheld");
        process.exit(1);
      }
      const transcript = getTranscript(source, id);
      console.log(`# ${s.title}\n${fmtDate(s.time_created)} — ${s.directory} — ${s.id}\n`);
      for (const m of transcript) {
        const text = m.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n");
        const tools = m.parts.filter((p) => p.type === "tool" && p.tool).map((p) => p.tool);
        if (!text && tools.length === 0) continue;
        console.log(`## ${m.role}`);
        if (text) console.log(text);
        if (tools.length) console.log(`*(tools: ${tools.join(", ")})*`);
        console.log();
      }
      break;
    }

    case "stats": {
      const index = openIndex();
      const s = stats(index);
      console.log(`sessions: ${s.sessions} (${s.excluded} excluded/empty), chunks: ${s.chunks}`);
      if (s.oldest) console.log(`range: ${fmtDate(Number(s.oldest))} → ${fmtDate(Number(s.newest))}`);
      console.log("\nTop directories:");
      for (const row of s.byDirectory) {
        console.log(`  ${row.n}\t${row.directory}`);
      }
      break;
    }

    case "doctor": {
      let ok = true;
      const src = sourceDbPath();
      if (existsSync(src)) console.log(`✓ source DB: ${src}`);
      else { console.error(`✗ source DB missing: ${src}`); ok = false; }
      try {
        const source = openSource();
        const n = source.prepare<{ n: number }, []>("SELECT COUNT(*) n FROM session").get()?.n ?? 0;
        console.log(`✓ source readable: ${n} sessions`);
      } catch (e) { console.error(`✗ source unreadable: ${e}`); ok = false; }
      try {
        const idx = openIndex();
        console.log(`✓ index writable: ${indexDbPath()}`);
        idx.close();
      } catch (e) { console.error(`✗ index not writable: ${e}`); ok = false; }
      try {
        const v = await embed(["doctor check"]);
        console.log(`✓ embedder: ${v[0].length} dims`);
      } catch (e) { console.error(`✗ embedder failed: ${e}`); ok = false; }
      process.exit(ok ? 0 : 1);
    }

    default:
      console.log("commands: sync | search | read | stats | doctor");
      process.exit(command ? 1 : 0);
  }
}

await main();
