#!/usr/bin/env bun
// opencode-episodic <command> [options]
//   sync [--force]                 Index new/changed sessions from opencode.db
//   search <query> [options]       Semantic (vector) search over indexed conversations
//     --text "terms"               Lexical BM25 search for these terms (all AND-matched) instead of vector
//     --hybrid                     Fuse vector + BM25 (RRF); off by default (see AGENTS.md)
//     --after YYYY-MM-DD           Only conversations after this date
//     --before YYYY-MM-DD          Only conversations before this date
//     --limit N                    Max results (default 10)
//   read <session-id> [--indexed]  Print a readable transcript (live DB, or --indexed for index copy)
//   stats                          Index statistics
//   doctor                         Diagnose setup
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { openSource, sourceDbPath, getSession, getTranscriptChecked } from "./reader";
import { openIndex, indexDbPath, search, textSearch, stats, isIndexEmpty } from "./store";
import { syncAll } from "./indexer";
import { embed, embedQuery } from "./embed";
import { parseDateArg, fmtDate, renderTranscript, formatHits } from "./format";

const [, , command, ...rest] = process.argv;
const USAGE = "commands: sync | search | read | stats | doctor";

// parseArgs (node:util, supported in Bun) over the tokens after the command.
// strict:true rejects unknown flags and missing values — we map those throws to
// the same error+usage+exit(1) the hand-rolled parser used. `search` joins the
// positionals with spaces as its query.
function parseCli() {
  try {
    return parseArgs({
      args: rest,
      options: {
        text: { type: "string" },
        after: { type: "string" },
        before: { type: "string" },
        limit: { type: "string" },
        force: { type: "boolean" },
        indexed: { type: "boolean" },
        hybrid: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    console.error(USAGE);
    process.exit(1);
  }
}
const { values, positionals } = parseCli();

// Map the shared parseDateArg union onto CLI semantics: print the error and
// exit non-zero. `values.*` is undefined for an absent flag (→ no date filter).
function dateArg(s: string | undefined): number | undefined {
  const r = parseDateArg(s);
  if (!r.ok) { console.error(`error: ${r.error}`); process.exit(1); }
  return r.ms;
}

// Parse/validate --limit (default 10). Same hard error+exit(1) pattern as an
// invalid date: without this, Number("abc") → NaN silently yields "No results.",
// and a negative limit slices from the end of the ranked list. Must be a
// positive integer; clamped to 1000 (a CLI sanity ceiling — plenty for a human
// debugging session).
function limitArg(s: string | undefined): number {
  if (s === undefined) return 10;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1) {
    console.error(`error: invalid --limit "${s}" (expected a positive integer).`);
    console.error(USAGE);
    process.exit(1);
  }
  return Math.min(n, 1000);
}

async function main() {
  switch (command) {
    case "sync": {
      const source = openSource();
      const index = openIndex();
      const r = await syncAll(source, index, {
        force: values.force,
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
      const query = positionals.join(" ");
      if (!query) { console.error("usage: opencode-episodic search <query> [--text p] [--hybrid] [--after d] [--before d] [--limit n]"); process.exit(1); }
      const index = openIndex();
      const opts = {
        limit: limitArg(values.limit),
        after: dateArg(values.after),
        before: dateArg(values.before),
      };
      const hits = values.text
        ? textSearch(index, values.text, opts)
        : search(
            index,
            (await embedQuery(query))[0],
            values.hybrid ? { ...opts, queryText: query, hybrid: true } : opts
          );
      if (hits.length === 0) {
        console.log(isIndexEmpty(index)
          ? "No results. The index is empty — run: bun run src/cli.ts sync"
          : "No results.");
      } else {
        // Hybrid hits carry RRF scores (~0.03), not cosine — label them "rrf".
        console.log(formatHits(hits, 220, values.hybrid ? "rrf" : "score"));
      }
      break;
    }

    case "read": {
      const id = positionals[0];
      if (!id) { console.error("usage: opencode-episodic read <session-id> [--indexed]"); process.exit(1); }
      if (values.indexed) {
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
