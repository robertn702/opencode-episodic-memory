#!/usr/bin/env bun
// opencode-episodic <command> [options]
//   sync [--force]                 Index new/changed sessions from opencode.db
//   search <query> [options]       Semantic (vector) search over indexed conversations
//     --text "terms"               Lexical BM25 search for these terms (all AND-matched) instead of vector
//     --hybrid                     Fuse vector + BM25 (RRF); off by default (see AGENTS.md)
//     --after YYYY-MM-DD           Only conversations after this date
//     --before YYYY-MM-DD          Only conversations before this date
//     --limit N                    Max results (default 10)
//   read <session-id> [--indexed --source source-id]  Print a readable transcript
//   stats                          Index statistics
//   doctor                         Diagnose setup
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { openSource, sourceDbPath, getSession, getTranscriptChecked } from "./reader";
import { openConfiguredIndex, indexDbPath, type IndexStore } from "./store";
import { syncAll } from "./indexer";
import { embed, embedQuery, getEmbedMode } from "./embed";
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
        source: { type: "string" },
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

async function withConfiguredIndex<T>(fn: (index: IndexStore) => Promise<T>): Promise<T> {
  const index = await openConfiguredIndex();
  try { return await fn(index); }
  finally { index.close(); }
}

async function main() {
  switch (command) {
    case "sync": {
      const source = openSource();
      const r = await withConfiguredIndex((index) => syncAll(source, index, {
        force: values.force,
        onProgress: (done, total, title) =>
          process.stderr.write(`\r[${done}/${total}] ${title.slice(0, 60)}                    `),
      }));
      process.stderr.write("\n");
      console.log(
        `scanned=${r.scanned} indexed=${r.indexed} fresh=${r.skippedFresh} excluded=${r.excluded} empty=${r.empty} pruned=${r.pruned}`
      );
      break;
    }

    case "search": {
      const query = positionals.join(" ");
      if (!query) { console.error("usage: opencode-episodic search <query> [--text p] [--hybrid] [--after d] [--before d] [--limit n]"); process.exit(1); }
      const opts = {
        limit: limitArg(values.limit),
        after: dateArg(values.after),
        before: dateArg(values.before),
      };
      const { hits, empty } = await withConfiguredIndex(async (index) => {
        const hits = values.text
          ? await index.textSearch(values.text, opts)
          : await index.search(
            (await embedQuery(query))[0],
            values.hybrid ? { ...opts, queryText: query, hybrid: true } : opts
          );
        return { hits, empty: hits.length === 0 && await index.isEmpty() };
      });
      if (hits.length === 0) {
        console.log(empty
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
      if (!id) { console.error("usage: opencode-episodic read <session-id> [--indexed --source source-id]"); process.exit(1); }
      if (values.indexed) {
        const rows = await withConfiguredIndex(async (index) => {
          if (index.remote && !values.source) throw new Error("--source is required for remote indexed reads.");
          return index.readIndexed(id, values.source);
        });
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
      const s = await withConfiguredIndex((index) => index.stats());
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
      let mode: "sidecar" | "inline";
      try {
        mode = getEmbedMode();
        console.log(`✓ embedding mode: ${mode}`);
      } catch (e) {
        console.error(`✗ embedding mode: ${e}`);
        process.exit(1);
      }
      if (mode === "sidecar") {
        const nodeBinary = process.env.EPISODIC_NODE_BINARY ?? "node";
        try {
          const node = Bun.spawnSync([nodeBinary, "--version"], { stdout: "pipe", stderr: "pipe" });
          const version = new TextDecoder().decode(node.stdout).trim();
          const match = /^v(\d+)\./.exec(version);
          if (!node.success || !match || Number(match[1]) < 20) {
            const detail = new TextDecoder().decode(node.stderr).trim();
            console.error(`✗ Node 20+ required for sidecar mode (${JSON.stringify(nodeBinary)} ${version || detail || "not found"}). Set EPISODIC_NODE_BINARY to a Node 20+ executable.`);
            ok = false;
          } else {
            console.log(`✓ sidecar Node: ${nodeBinary} ${version}`);
          }
        } catch (e) {
          console.error(`✗ Node 20+ required for sidecar mode (${JSON.stringify(nodeBinary)} could not start: ${e}). Set EPISODIC_NODE_BINARY to a Node 20+ executable.`);
          ok = false;
        }
      } else {
        console.warn("! inline embedding mode loads native ML addons into Bun; it is unsafe on affected OpenCode/Bun versions. Prefer sidecar mode.");
      }
      const src = sourceDbPath();
      if (existsSync(src)) console.log(`✓ source DB: ${src}`);
      else { console.error(`✗ source DB missing: ${src}`); ok = false; }
      try {
        const source = openSource();
        const n = source.prepare<{ n: number }, []>("SELECT COUNT(*) n FROM session").get()?.n ?? 0;
        console.log(`✓ source readable: ${n} sessions`);
      } catch (e) { console.error(`✗ source unreadable: ${e}`); ok = false; }
      try {
        const idx = await openConfiguredIndex();
        console.log(`✓ index writable: ${idx.remote ? "remote index" : indexDbPath()}`);
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
