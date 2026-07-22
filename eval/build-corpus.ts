// Build the eval corpus ONCE from the live opencode.db, using the exact same
// chunking pipeline as src/indexer.ts, so every candidate model is scored on
// identical chunks. Output: eval/private/corpus.json (gitignored — private).
import { openSource, listSessions, getTranscript } from "../src/reader";
import { parseTranscript, exchangeText } from "../src/parser";

interface CorpusChunk {
  session_id: string;
  seq: number;
  time_created: number;
  title: string;
  directory: string;
  text: string;
}

const source = openSource();
const sessions = listSessions(source);
const chunks: CorpusChunk[] = [];
let excluded = 0, empty = 0;
for (const s of sessions) {
  const { exchanges, excluded: ex } = parseTranscript(getTranscript(source, s.id));
  if (ex) { excluded++; continue; }
  if (exchanges.length === 0) { empty++; continue; }
  const date = new Date(s.time_created).toISOString().slice(0, 10);
  exchanges.forEach((e, i) => {
    chunks.push({
      session_id: s.id,
      seq: i,
      time_created: e.time,
      title: s.title,
      directory: s.directory,
      text: exchangeText(s.title, date, e),
    });
  });
}
await Bun.write(new URL("./private/corpus.json", import.meta.url).pathname, JSON.stringify(chunks));
console.log(`sessions=${sessions.length} excluded=${excluded} empty=${empty} chunks=${chunks.length}`);
