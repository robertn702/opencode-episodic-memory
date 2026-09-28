import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EXCLUDE_MARKER, getSession, getTranscriptChecked, getTranscriptContext, listSessions, sourceLayout, transcriptHasMarker } from "./reader";

function makeSource(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE session_v2 (id TEXT, project_id TEXT, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)");
  db.run("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
  db.run("INSERT INTO session_v2 VALUES ('migrated', 'project', NULL, NULL, '/dir', 1, 2, NULL)");
  return db;
}

function add(db: Database, id: string, type: string, seq: number, data: string): void {
  db.run("INSERT INTO session_message VALUES (?, 'migrated', ?, ?, ?, ?)", [id, type, seq, seq, data]);
}

describe("v2-only source", () => {
  test("rejects a v1-only database instead of reading old tables", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE session (id TEXT)");
    db.run("CREATE TABLE message (id TEXT)");
    db.run("CREATE TABLE part (id TEXT)");
    expect(() => sourceLayout(db)).toThrow("session_v2");
  });

  test("reads migrated history from v2 tables even when retained v1 tables are incomplete", () => {
    const db = makeSource();
    db.run("CREATE TABLE part (id TEXT)");
    add(db, "u", "user", 1, JSON.stringify({ text: "migrated prompt" }));
    add(db, "a", "assistant", 2, JSON.stringify({ content: [{ type: "text", text: "migrated answer" }, { type: "tool", name: "read" }] }));
    expect(sourceLayout(db)).toBe("v2");
    expect(listSessions(db).map((s) => [s.id, s.title])).toEqual([["migrated", ""]]);
    expect(getSession(db, "migrated")?.title).toBe("");
    expect(getTranscriptChecked(db, "migrated")).toMatchObject({ excluded: false, messages: [
      { id: "u", parts: [{ type: "text", text: "migrated prompt" }] },
      { id: "a", parts: [{ type: "text", text: "migrated answer" }, { type: "tool", tool: "read" }] },
    ] });
  });

  test("privacy gate catches malformed v2 data before materializing a transcript or window", () => {
    const db = makeSource();
    add(db, "u", "user", 1, JSON.stringify({ text: "safe" }));
    add(db, "a", "assistant", 2, `{broken ${EXCLUDE_MARKER}`);
    expect(transcriptHasMarker(db, "migrated")).toBe(true);
    expect(getTranscriptChecked(db, "migrated")).toEqual({ excluded: true });
    expect(getTranscriptContext(db, "migrated", "u", 0, 0)).toEqual({ ok: false, reason: "excluded" });
  });
});

describe("v2 transcript windows and validation", () => {
  test("orders by sequence, bounds inline content, and rejects non-user anchors", () => {
    const db = makeSource();
    add(db, "first", "user", 10, JSON.stringify({ text: "first" }));
    add(db, "middle", "assistant", 20, JSON.stringify({ content: [
      { type: "text", text: "x".repeat(20_000) },
      ...Array.from({ length: 24 }, (_, i) => ({ type: "text", text: `text ${i}` })),
    ] }));
    add(db, "anchor", "user", 30, JSON.stringify({ text: "anchor" }));
    add(db, "last", "assistant", 40, JSON.stringify({ content: [{ type: "text", text: "last" }] }));
    const context = getTranscriptContext(db, "migrated", "anchor", 1, 1);
    expect(context).toMatchObject({ ok: true, anchorIndex: 2, sliceStart: 1, total: 4 });
    if (!context.ok) throw new Error("expected context");
    expect(context.messages.map((m) => m.id)).toEqual(["middle", "anchor", "last"]);
    expect(context.messages[0].parts).toHaveLength(20);
    expect(context.messages[0].parts[0]).toEqual({ type: "text", text: "text 0" });
    expect(context.messages[0].contextPartsOmitted).toBe(5);
    expect(getTranscriptContext(db, "migrated", "last")).toEqual({ ok: false, reason: "invalid_anchor" });
    expect(getTranscriptContext(db, "migrated", "anchor", 21, 0)).toEqual({ ok: false, reason: "invalid_bounds" });
  });

  test("validates only selected rows after the session-wide marker scan", () => {
    const db = makeSource();
    add(db, "first", "user", 1, JSON.stringify({ text: "one" }));
    add(db, "second", "user", 2, JSON.stringify({ text: "two" }));
    db.run("UPDATE session_message SET data = NULL WHERE id = 'first'");
    expect(getTranscriptContext(db, "migrated", "second", 0, 0)).toMatchObject({ ok: true, messages: [{ id: "second" }] });
    expect(() => getTranscriptChecked(db, "migrated")).toThrow();
    expect(() => getTranscriptContext(db, "migrated", "first", 0, 0)).toThrow();
  });

  test("rejects missing v2 columns and malformed session structure", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE session_v2 (id TEXT)");
    db.run("CREATE TABLE session_message (id TEXT)");
    expect(() => sourceLayout(db)).toThrow("session_v2 missing");
    const good = makeSource();
    good.run("UPDATE session_v2 SET time_updated = NULL WHERE id = 'migrated'");
    expect(() => listSessions(good)).toThrow();
    expect(() => getSession(good, "migrated")).toThrow();
  });

  test("privacy marker is exact and session-scoped", () => {
    const db = makeSource();
    add(db, "u", "user", 1, JSON.stringify({ text: "do not index this chat" }));
    expect(transcriptHasMarker(db, "migrated")).toBe(false);
    db.run("INSERT INTO session_v2 VALUES ('other', 'project', NULL, 'Other', '/dir', 3, 3, NULL)");
    db.run("INSERT INTO session_message VALUES ('p', 'other', 'user', 1, 1, ?)", [`{bad ${EXCLUDE_MARKER}`]);
    expect(transcriptHasMarker(db, "migrated")).toBe(false);
    expect(transcriptHasMarker(db, "other")).toBe(true);
  });
});
