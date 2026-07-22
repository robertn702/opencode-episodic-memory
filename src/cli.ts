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
import { openSource, sourceDbPath, getSession, getTranscriptChecked } from "./reader";
import { openIndex, indexDbPath, search, textSearch, stats, isIndexEmpty } from "./store";
import { syncAll } from "./indexer";
import { embed, embedQuery } from "./embed";
import { parseDateArg, fmtDate, renderTranscript, formatHits } from "./format";

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
// Map the shared parseDateArg union onto CLI semantics: print the error and
// exit non-zero. `flag()` yields null for an absent flag (→ no date filter).
function dateArg(s: string | null): number | undefined {
  const r = parseDateArg(s ?? undefined);
  if (!r.ok) { console.error(`error: ${r.error}`); process.exit(1); }
  return r.ms;
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
        after: dateArg(flag("after")),
        before: dateArg(flag("before")),
      };
      const textFlag = flag("text");
      const hits = textFlag
        ? textSearch(index, textFlag, opts)
        : search(index, (await embedQuery(query))[0], opts);
      if (hits.length === 0) {
        console.log(isIndexEmpty(index)
          ? "No results. The index is empty — run: bun run src/cli.ts sync"
          : "No results.");
      } else {
        console.log(formatHits(hits, 220));
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
      // Privacy gate lives inside getTranscriptChecked (authoritative raw-blob
      // scan before any read).
      const checked = getTranscriptChecked(source, id);
      if (checked.excluded) {
        console.error("session is marked private (exclusion marker present); transcript withheld");
        process.exit(1);
      }
      console.log(renderTranscript(s, checked.messages));
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
