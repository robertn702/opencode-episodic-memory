// Phase 0 spike: verify the three risky assumptions before building.
// 1. sqlite-vec loads under bun:sqlite and round-trips vectors
// 2. opencode.db session/message/part -> readable transcript
// 3. @huggingface/transformers embeds locally under Bun
import { Database } from "bun:sqlite";

console.log("=== Spike 1: vector store (brute-force cosine; bun:sqlite cannot load extensions) ===");
{
  const db = new Database(":memory:");
  db.run("CREATE TABLE chunks (id INTEGER PRIMARY KEY, embedding BLOB)");
  const ins = db.prepare("INSERT INTO chunks(embedding) VALUES (?)");
  ins.run(new Float32Array([1, 0, 0, 0]));
  ins.run(new Float32Array([0.9, 0.1, 0, 0]).map((x) => x / Math.hypot(0.9, 0.1)));
  ins.run(new Float32Array([0, 0, 1, 0]));
  const rows = db
    .prepare<{ id: number; embedding: Uint8Array }, []>("SELECT id, embedding FROM chunks")
    .all();
  const q = new Float32Array([1, 0, 0, 0]);
  const scored = rows
    .map((r) => {
      const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, 4);
      let dot = 0;
      for (let i = 0; i < 4; i++) dot += q[i] * v[i];
      return { id: r.id, score: dot };
    })
    .sort((a, b) => b.score - a.score);
  console.log("ranking:", scored.map((s) => `${s.id}:${s.score.toFixed(3)}`).join(" "));
  if (scored[0].id !== 1 || scored[1].id !== 2) throw new Error("cosine ranking wrong");
  console.log("OK: brute-force cosine over blobs works\n");
}

console.log("=== Spike 2: transcript reconstruction from opencode.db ===");
{
  const path = `${process.env.HOME}/.local/share/opencode/opencode.db`;
  const db = new Database(path, { readonly: true });
  const session = db
    .prepare<{ id: string; title: string; directory: string; time_created: number }, []>(
      `SELECT s.id, s.title, s.directory, s.time_created
       FROM session s ORDER BY s.time_created DESC LIMIT 1`
    )
    .get();
  if (!session) throw new Error("no sessions in opencode.db");
  console.log("latest session:", session.title, `(${session.id})`);

  const messages = db
    .prepare<{ id: string; time_created: number; data: string }, [string]>(
      `SELECT m.id, m.time_created, m.data FROM message m
       WHERE m.session_id = ? ORDER BY m.time_created, m.id`
    )
    .all(session.id);

  const parts = db
    .prepare<{ message_id: string; data: string }, [string]>(
      `SELECT p.message_id, p.data FROM part p
       WHERE p.session_id = ? ORDER BY p.time_created, p.id`
    )
    .all(session.id);

  const partsByMsg = new Map<string, { type: string; text?: string; tool?: string }[]>();
  for (const p of parts) {
    const d = JSON.parse(p.data);
    if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, []);
    partsByMsg.get(p.message_id)!.push(d);
  }

  let exchanges = 0;
  for (const m of messages.slice(0, 6)) {
    let md: unknown;
    try {
      md = JSON.parse(m.data);
    } catch {
      md = undefined; // corrupt blob degrades to unknown role
    }
    const role =
      md && typeof md === "object" && "role" in md && typeof md.role === "string" ? md.role : "unknown";
    const ps = partsByMsg.get(m.id) ?? [];
    const text = ps
      .filter((p) => p.type === "text")
      .map((p) => (p.text ?? "").slice(0, 80))
      .join(" ");
    const tools = ps.filter((p) => p.type === "tool").map((p) => p.tool);
    if (text || tools.length) exchanges++;
    console.log(`  [${role}] ${text.slice(0, 100)}${tools.length ? ` (tools: ${tools.join(",")})` : ""}`);
  }
  console.log(`OK: ${messages.length} messages, ${parts.length} parts, ${exchanges} renderable exchanges\n`);
  db.close();
}

console.log("=== Spike 3: transformers.js local embedding ===");
{
  const { pipeline } = await import("@huggingface/transformers");
  const embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    dtype: "fp32",
  });
  const out = await embedder("semantic search over past conversations", {
    pooling: "mean",
    normalize: true,
  });
  // out.data is a DataArray union; mean-pooled + normalized output is a
  // Float32Array at runtime.
  const vec = new Float32Array(out.data as Float32Array);
  console.log(`OK: embedded, dims=${vec.length}, first=${vec[0].toFixed(4)}`);
}

console.log("\nAll spikes passed.");
