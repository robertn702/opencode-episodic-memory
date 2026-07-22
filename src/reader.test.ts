import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { listSessions, getSession, getTranscript } from "./reader";

// A minimal opencode.db mirroring only the columns reader.ts SELECTs. Writable
// here so we can seed rows; the reader functions take a Database and never write.
function makeSource(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE session (
    id TEXT, project_id TEXT, parent_id TEXT, title TEXT, directory TEXT,
    time_created INTEGER, time_updated INTEGER, time_archived INTEGER
  )`);
  db.run(`CREATE TABLE message (
    id TEXT, session_id TEXT, time_created INTEGER, data TEXT
  )`);
  db.run(`CREATE TABLE part (
    id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT
  )`);
  return db;
}

function addSession(db: Database, s: {
  id: string; parent_id?: string | null; title?: string;
  time_created?: number; time_updated?: number; time_archived?: number | null;
}): void {
  db.run(
    `INSERT INTO session (id, project_id, parent_id, title, directory, time_created, time_updated, time_archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [s.id, "proj", s.parent_id ?? null, s.title ?? "Title", "/dir",
     s.time_created ?? 1000, s.time_updated ?? 1000, s.time_archived ?? null]
  );
}
function addMessage(db: Database, id: string, sessionId: string, time: number, data: string): void {
  db.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
    [id, sessionId, time, data]);
}
function addPart(db: Database, id: string, messageId: string, sessionId: string, time: number, data: string): void {
  db.run("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
    [id, messageId, sessionId, time, data]);
}

describe("listSessions / getSession (structural rows)", () => {
  test("lists active sessions ordered by time_created, excludes archived", () => {
    const db = makeSource();
    addSession(db, { id: "ses_b", time_created: 2000 });
    addSession(db, { id: "ses_a", time_created: 1000, parent_id: "ses_b" });
    addSession(db, { id: "ses_arch", time_created: 1500, time_archived: 9999 });
    const sessions = listSessions(db);
    expect(sessions.map((s) => s.id)).toEqual(["ses_a", "ses_b"]);
    expect(sessions[0].parent_id).toBe("ses_b");
    expect(sessions[1].parent_id).toBeNull();
  });

  test("getSession returns a row, or null for an unknown id", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a", title: "Hello" });
    expect(getSession(db, "ses_a")?.title).toBe("Hello");
    expect(getSession(db, "nope")).toBeNull();
  });

  test("throws (does not silently mis-read) when a structural column drifts", () => {
    const db = makeSource();
    // time_created NULL violates z.number() — simulates OpenCode schema drift.
    db.run(
      `INSERT INTO session (id, project_id, parent_id, title, directory, time_created, time_updated, time_archived)
       VALUES ('ses_x', 'p', NULL, 't', '/d', NULL, 1000, NULL)`
    );
    expect(() => listSessions(db)).toThrow();
  });

  test("getSession throws on a drifted session row for an existing id", () => {
    const db = makeSource();
    // title NULL violates z.string() — simulates OpenCode schema drift.
    db.run(
      `INSERT INTO session (id, project_id, parent_id, title, directory, time_created, time_updated, time_archived)
       VALUES ('ses_y', 'p', NULL, NULL, '/d', 1000, 1000, NULL)`
    );
    expect(() => getSession(db, "ses_y")).toThrow();
  });
});

describe("getTranscript (JSON blob degradation)", () => {
  test("parses roles and part fields; degrades malformed blobs per-row", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a" });
    addMessage(db, "m1", "ses_a", 1, `{"role":"user"}`);
    addMessage(db, "m2", "ses_a", 2, `{"role":"assistant"}`);
    addMessage(db, "m3", "ses_a", 3, `{not valid json`);   // role -> "unknown"
    addMessage(db, "m4", "ses_a", 4, `{"noRole":true}`);    // role -> "unknown"

    addPart(db, "p1", "m1", "ses_a", 1, `{"type":"text","text":"hello"}`);
    addPart(db, "p2", "m1", "ses_a", 2, `{"type":"tool","tool":"edit"}`);
    addPart(db, "p3", "m2", "ses_a", 3, `{oops not json`);          // -> {type:"unknown"}
    addPart(db, "p4", "m2", "ses_a", 4, `{"type":123,"text":"keep"}`); // type->unknown, text kept
    addPart(db, "p5", "m4", "ses_a", 5, `42`);                       // non-object -> {type:"unknown"}

    const t = getTranscript(db, "ses_a");
    expect(t.map((m) => m.role)).toEqual(["user", "assistant", "unknown", "unknown"]);

    expect(t[0].parts).toEqual([
      { type: "text", text: "hello" },
      { type: "tool", tool: "edit" },
    ]);
    expect(t[1].parts).toEqual([
      { type: "unknown" },
      { type: "unknown", text: "keep" },
    ]);
    expect(t[3].parts).toEqual([{ type: "unknown" }]);
  });

  test("per-field catch: bad text/tool fields are dropped, type is preserved", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a" });
    addMessage(db, "m1", "ses_a", 1, `{"role":"user"}`);
    addPart(db, "p1", "m1", "ses_a", 1, `{"type":"text","text":123}`); // bad text dropped
    addPart(db, "p2", "m1", "ses_a", 2, `{"type":"tool","tool":123}`); // bad tool dropped

    const t = getTranscript(db, "ses_a");
    expect(t[0].parts).toEqual([{ type: "text" }, { type: "tool" }]);
  });

  test("throws when a part row's data column is non-string (structural drift)", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a" });
    // Valid message first so the message-row parse passes and the throw comes
    // from the part row below.
    addMessage(db, "m1", "ses_a", 1, `{"role":"user"}`);
    db.run("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES ('p1', 'm1', 'ses_a', 1, NULL)");
    expect(() => getTranscript(db, "ses_a")).toThrow();
  });

  test("throws when a message row's data column is non-string (structural drift)", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a" });
    // data NULL violates the row schema's z.string(); structural, so it throws.
    db.run("INSERT INTO message (id, session_id, time_created, data) VALUES ('m1', 'ses_a', 1, NULL)");
    expect(() => getTranscript(db, "ses_a")).toThrow();
  });
});
