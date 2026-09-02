import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { listSessions, getSession, getTranscriptChecked, getTranscriptContext, transcriptHasMarker, EXCLUDE_MARKER, type SourceMessage } from "./reader";

// getTranscript is module-internal now; exercise its blob-degradation behavior
// through the privacy-gated accessor. These fixtures carry no exclusion marker,
// so the `excluded` arm never fires here.
function readMessages(db: Database, id: string): SourceMessage[] {
  const r = getTranscriptChecked(db, id);
  if (r.excluded) throw new Error(`unexpected exclusion for ${id}`);
  return r.messages;
}

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

describe("getTranscriptChecked (JSON blob degradation)", () => {
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

    const t = readMessages(db, "ses_a");
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

    const t = readMessages(db, "ses_a");
    expect(t[0].parts).toEqual([{ type: "text" }, { type: "tool" }]);
  });

  test("throws when a part row's data column is non-string (structural drift)", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a" });
    // Valid message first so the message-row parse passes and the throw comes
    // from the part row below.
    addMessage(db, "m1", "ses_a", 1, `{"role":"user"}`);
    db.run("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES ('p1', 'm1', 'ses_a', 1, NULL)");
    expect(() => getTranscriptChecked(db, "ses_a")).toThrow();
  });

  test("throws when a message row's data column is non-string (structural drift)", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a" });
    // data NULL violates the row schema's z.string(); structural, so it throws.
    db.run("INSERT INTO message (id, session_id, time_created, data) VALUES ('m1', 'ses_a', 1, NULL)");
    expect(() => getTranscriptChecked(db, "ses_a")).toThrow();
  });
});

describe("transcriptHasMarker (raw blob scan)", () => {
  test("detects the marker in a well-formed text part", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a" });
    addMessage(db, "m1", "ses_a", 1, `{"role":"user"}`);
    addPart(db, "p1", "m1", "ses_a", 1, `{"type":"text","text":"note: ${EXCLUDE_MARKER}"}`);
    expect(transcriptHasMarker(db, "ses_a")).toBe(true);
  });

  // Regression for issue #10: the parsed-text scan degrades this blob to
  // text: undefined, so the marker is invisible to hasExcludeMarker — but the
  // raw scan must still see it. The privacy kill-switch must not depend on
  // blob parseability.
  test("detects the marker inside a malformed/unparseable part blob", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a" });
    addMessage(db, "m1", "ses_a", 1, `{"role":"user"}`);
    addPart(db, "p1", "m1", "ses_a", 1, `{oops not json ${EXCLUDE_MARKER}`);
    // The parsed view would degrade this blob to {type:"unknown"}, losing the
    // marker text (see the degradation suite above) — only the raw scan catches
    // it. That is the whole point of transcriptHasMarker.
    expect(transcriptHasMarker(db, "ses_a")).toBe(true);
  });

  test("detects the marker in a blob whose fields all fail validation", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a" });
    addMessage(db, "m1", "ses_a", 1, `{"role":"user"}`);
    // Valid JSON, but type is non-string → the parsed view degrades to
    // {type:"unknown"} and the marker survives only in an unmodeled field; the
    // raw scan still catches it.
    addPart(db, "p1", "m1", "ses_a", 1, `{"type":123,"note":"${EXCLUDE_MARKER}"}`);
    expect(transcriptHasMarker(db, "ses_a")).toBe(true);
  });

  test("returns false when no part contains the marker", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a" });
    addMessage(db, "m1", "ses_a", 1, `{"role":"user"}`);
    addPart(db, "p1", "m1", "ses_a", 1, `{"type":"text","text":"hello"}`);
    expect(transcriptHasMarker(db, "ses_a")).toBe(false);
  });

  test("is scoped to the requested session", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a" });
    addSession(db, { id: "ses_b" });
    addMessage(db, "m1", "ses_b", 1, `{"role":"user"}`);
    addPart(db, "p1", "m1", "ses_b", 1, `{"type":"text","text":"${EXCLUDE_MARKER}"}`);
    expect(transcriptHasMarker(db, "ses_a")).toBe(false);
    expect(transcriptHasMarker(db, "ses_b")).toBe(true);
  });

  test("does not match case variants or partial markers (exact substring)", () => {
    const db = makeSource();
    addSession(db, { id: "ses_a" });
    addMessage(db, "m1", "ses_a", 1, `{"role":"user"}`);
    addPart(db, "p1", "m1", "ses_a", 1, `{"type":"text","text":"do not index this chat"}`);
    addPart(db, "p2", "m1", "ses_a", 2, `{"type":"text","text":"DO NOT INDEX THIS"}`);
    expect(transcriptHasMarker(db, "ses_a")).toBe(false);
  });
});

describe("getTranscriptContext", () => {
  function seedContext(db: Database, id = "ses_context"): void {
    addSession(db, { id });
    for (let i = 0; i < 5; i++) {
      const messageId = `msg_${i}`;
      addMessage(db, messageId, id, i, JSON.stringify({ role: i % 2 === 0 ? "user" : "assistant" }));
      addPart(db, `part_${i}`, messageId, id, i, JSON.stringify({ type: "text", text: `message ${i}` }));
    }
    addPart(db, "tool_3", "msg_3", id, 3, JSON.stringify({ type: "tool", tool: "read" }));
  }

  test("expands a chronological window around the anchored message", () => {
    const db = makeSource();
    seedContext(db);
    const context = getTranscriptContext(db, "ses_context", "msg_2", 1, 2);
    expect(context).toMatchObject({ ok: true, anchorIndex: 2, sliceStart: 1, total: 5 });
    if (!context.ok) throw new Error("expected context");
    expect(context.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"]);
    expect(context.messages[2].parts).toContainEqual({ type: "tool", tool: "read" });
  });

  test("orders tied timestamps by message ID when locating the anchor", () => {
    const db = makeSource();
    addSession(db, { id: "ses_tied" });
    for (const id of ["msg_c", "msg_a", "msg_b"]) {
      addMessage(db, id, "ses_tied", 10, JSON.stringify({ role: "user" }));
      addPart(db, `part_${id}`, id, "ses_tied", 10, JSON.stringify({ type: "text", text: id }));
    }
    const context = getTranscriptContext(db, "ses_tied", "msg_b", 1, 1);
    if (!context.ok) throw new Error("expected context");
    expect(context).toMatchObject({ anchorIndex: 1, sliceStart: 0, total: 3 });
    expect(context.messages.map((message) => message.id)).toEqual(["msg_a", "msg_b", "msg_c"]);
  });

  test("clamps windows at the beginning and end while retaining the anchor", () => {
    const db = makeSource();
    seedContext(db);
    const start = getTranscriptContext(db, "ses_context", "msg_0", 3, 1);
    const end = getTranscriptContext(db, "ses_context", "msg_4", 1, 3);
    if (!start.ok || !end.ok) throw new Error("expected contexts");
    expect(start.sliceStart).toBe(0);
    expect(start.messages.map((message) => message.id)).toEqual(["msg_0", "msg_1"]);
    expect(end.sliceStart).toBe(3);
    expect(end.messages.map((message) => message.id)).toEqual(["msg_3", "msg_4"]);
  });

  test("accepts the maximum bound and supports an anchor-only window", () => {
    const db = makeSource();
    seedContext(db);
    const maximum = getTranscriptContext(db, "ses_context", "msg_2", 20, 20);
    const anchorOnly = getTranscriptContext(db, "ses_context", "msg_2", 0, 0);
    if (!maximum.ok || !anchorOnly.ok) throw new Error("expected contexts");
    expect(maximum.messages.map((message) => message.id)).toEqual(["msg_0", "msg_1", "msg_2", "msg_3", "msg_4"]);
    expect(anchorOnly.sliceStart).toBe(2);
    expect(anchorOnly.messages.map((message) => message.id)).toEqual(["msg_2"]);
  });

  test("only parses structural rows in the selected context window", () => {
    const db = makeSource();
    seedContext(db);
    db.run("UPDATE message SET data = NULL WHERE id = 'msg_0'");
    const outsideMalformed = getTranscriptContext(db, "ses_context", "msg_4", 0, 0);
    if (!outsideMalformed.ok) throw new Error("expected context");
    expect(outsideMalformed.messages.map((message) => message.id)).toEqual(["msg_4"]);

    db.run("UPDATE message SET data = NULL WHERE id = 'msg_4'");
    expect(() => getTranscriptContext(db, "ses_context", "msg_4", 0, 0)).toThrow();
  });

  test("bounds selected parts and ignores malformed parts outside the window", () => {
    const db = makeSource();
    seedContext(db);
    addPart(db, "huge", "msg_2", "ses_context", 10, JSON.stringify({ type: "text", text: "x".repeat(20_000) }));
    const huge = getTranscriptContext(db, "ses_context", "msg_2", 0, 0);
    if (!huge.ok) throw new Error("expected context");
    expect(huge.messages[0].parts).toEqual([{ type: "text", text: "message 2" }]);
    expect(huge.messages[0].contextPartsOmitted).toBe(1);

    db.run("UPDATE part SET data = NULL WHERE id = 'part_0'");
    const outsideMalformed = getTranscriptContext(db, "ses_context", "msg_4", 0, 0);
    if (!outsideMalformed.ok) throw new Error("expected context");
    expect(outsideMalformed.messages.map((message) => message.id)).toEqual(["msg_4"]);
    db.run("UPDATE part SET data = NULL WHERE id = 'part_4'");
    expect(() => getTranscriptContext(db, "ses_context", "msg_4", 0, 0)).toThrow();
  });

  test("caps retained parts per selected message and reports omissions", () => {
    const db = makeSource();
    seedContext(db);
    for (let i = 0; i < 25; i++) {
      addPart(db, `extra_${i}`, "msg_2", "ses_context", 10 + i, JSON.stringify({ type: "tool", tool: `tool_${i}` }));
    }
    const context = getTranscriptContext(db, "ses_context", "msg_2", 0, 0);
    if (!context.ok) throw new Error("expected context");
    expect(context.messages[0].parts).toHaveLength(20);
    expect(context.messages[0].contextPartsOmitted).toBe(6);
  });

  test("distinguishes invalid bounds, unknown sessions, stale anchors, and private sessions", () => {
    const db = makeSource();
    seedContext(db);
    expect(getTranscriptContext(db, "ses_context", "msg_2", -1, 0)).toEqual({ ok: false, reason: "invalid_bounds" });
    expect(getTranscriptContext(db, "ses_context", "msg_2", 21, 0)).toEqual({ ok: false, reason: "invalid_bounds" });
    expect(getTranscriptContext(db, "ses_context", "msg_2", 1.5, 0)).toEqual({ ok: false, reason: "invalid_bounds" });
    expect(getTranscriptContext(db, "missing", "msg_2")).toEqual({ ok: false, reason: "unknown_session" });
    expect(getTranscriptContext(db, "ses_context", "stale")).toEqual({ ok: false, reason: "invalid_anchor" });
    addPart(db, "private_part", "msg_0", "ses_context", 6, JSON.stringify({ type: "text", text: EXCLUDE_MARKER }));
    // The marker is outside the requested anchor-only window; the privacy gate
    // remains session-wide rather than depending on the selected message rows.
    expect(getTranscriptContext(db, "ses_context", "msg_4", 0, 0)).toEqual({ ok: false, reason: "excluded" });
  });
});
