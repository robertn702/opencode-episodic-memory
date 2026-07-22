import { describe, test, expect } from "bun:test";
import { parseTranscript, exchangeText, EXCLUDE_MARKER } from "./parser";
import type { SourceMessage } from "./reader";

const msg = (role: string, timeCreated: number, parts: SourceMessage["parts"]): SourceMessage =>
  ({ id: `${role}-${timeCreated}`, role, timeCreated, parts });

describe("parseTranscript", () => {
  test("builds exchanges from user/assistant pairs with tool names", () => {
    const { exchanges, excluded } = parseTranscript([
      msg("assistant", 1, [{ type: "text", text: "dropped: no user context" }]),
      msg("user", 2, [{ type: "text", text: "how do I fix the redirect?" }]),
      msg("assistant", 3, [
        { type: "reasoning", text: "thinking..." },
        { type: "text", text: "Change the callback URL." },
        { type: "tool", tool: "edit" },
        { type: "tool", tool: "bash" },
      ]),
      msg("user", 4, [{ type: "text", text: "thanks" }]),
      msg("assistant", 5, [{ type: "text", text: "anytime" }]),
    ]);
    expect(excluded).toBe(false);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0].user).toBe("how do I fix the redirect?");
    expect(exchanges[0].assistant).toBe("Change the callback URL.");
    expect(exchanges[0].tools).toEqual(["edit", "bash"]);
    expect(exchanges[1].tools).toEqual([]);
  });

  test("user turns without text are skipped", () => {
    const { exchanges } = parseTranscript([
      msg("user", 1, [{ type: "tool", tool: "read" }]), // pure tool-result turn
      msg("user", 2, [{ type: "text", text: "real question" }]),
    ]);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].user).toBe("real question");
  });

  test("exclusion marker anywhere opts out the whole transcript", () => {
    const { exchanges, excluded } = parseTranscript([
      msg("user", 1, [{ type: "text", text: "hi" }]),
      msg("assistant", 2, [{ type: "text", text: `note: ${EXCLUDE_MARKER}` }]),
    ]);
    expect(excluded).toBe(true);
    expect(exchanges).toHaveLength(0);
  });
});

describe("exchangeText", () => {
  test("includes date, title, participants, deduped tools", () => {
    const text = exchangeText("My session", "2026-07-22", {
      user: "q", assistant: "a", tools: ["bash", "bash", "edit"], time: 0,
    });
    expect(text).toStartWith("2026-07-22 — My session\nUser: q\nAssistant: a");
    expect(text).toContain("Tools used: bash, edit");
  });

  test("caps at 4000 chars", () => {
    const text = exchangeText("t", "2026-07-22", {
      user: "x".repeat(10000), assistant: "", tools: [], time: 0,
    });
    expect(text.length).toBe(4000);
  });
});
