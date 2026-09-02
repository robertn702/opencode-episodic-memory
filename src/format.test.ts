import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { renderTranscriptContext } from "./format";
import type { SourceMessage } from "./reader";

describe("renderTranscriptContext", () => {
  test("truncates oversized preceding content without losing the anchor or following message", () => {
    const messages: SourceMessage[] = [
      { id: "msg_before", role: "assistant", timeCreated: 1, parts: [{ type: "text", text: "x".repeat(60_000) }] },
      { id: "msg_anchor", role: "user", timeCreated: 2, parts: [{ type: "text", text: "anchored request" }] },
      { id: "msg_after", role: "assistant", timeCreated: 3, parts: [{ type: "text", text: "following answer" }] },
    ];
    const output = renderTranscriptContext(
      { id: "ses_test", title: "Context", directory: "/tmp", time_created: 0 },
      { messages, anchorIndex: 1, sliceStart: 0, total: 3 }
    );

    expect(output).toContain("... [truncated]");
    expect(output).toContain("msg_anchor — 2/3 (anchor)");
    expect(output).toContain("following answer");
    expect(output.length).toBeLessThan(50_000);
  });

  test("stays below 50 KiB for a full multibyte context window with every field oversized", () => {
    const multibyte = "界😀";
    const messageIds = Array.from({ length: 41 }, (_, index) => `msg_${index}_${multibyte.repeat(100)}`);
    const messages: SourceMessage[] = messageIds.map((id, index) => ({
      id,
      role: `${index % 2 ? "assistant" : "user"}-${multibyte.repeat(100)}`,
      timeCreated: index,
      parts: [
        { type: "text", text: `${index === 21 ? "following message" : "message body"} ${multibyte.repeat(1_000)}` },
        { type: "tool", tool: `tool-${multibyte.repeat(100)}` },
      ],
      contextPartsOmitted: 3,
    }));
    const output = renderTranscriptContext(
      { id: `ses_${multibyte.repeat(100)}`, title: multibyte.repeat(1_000), directory: `/${multibyte.repeat(1_000)}`, time_created: 0 },
      { messages, anchorIndex: 20, sliceStart: 0, total: 41 }
    );

    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(50_000);
    expect(output).toContain("21/41 (anchor)");
    expect(output).toContain("following message");
    expect(output).not.toContain("\uFFFD");
  });
});
