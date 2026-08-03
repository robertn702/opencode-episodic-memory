import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "episodic-embed-test-"));
const logPath = join(tmpdir(), `episodic-fake-sidecar-${process.pid}.log`);
const exitOncePath = join(tmpdir(), `episodic-fake-sidecar-exit-${process.pid}`);
const fixture = new URL("../spikes/fake-embed-sidecar.mjs", import.meta.url).pathname;

chmodSync(fixture, 0o755);
process.env.EPISODIC_NODE_BINARY = fixture;

const { embed, embedQuery, MAX_CHARS, QUERY_PREFIX } = await import("./embed.ts");

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function events(): Array<{ event: string; id?: number; texts?: string[]; pid?: number }> {
  try {
    return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
  rmSync(logPath, { force: true });
  rmSync(exitOncePath, { force: true });
  delete process.env.EPISODIC_NODE_BINARY;
});

describe("embedding sidecar protocol", () => {
  test("is lazy, reuses one process, batches in order, and handles fragmented output", async () => {
    expect(events()).toEqual([]);

    expect(await embed([])).toEqual([]);
    expect(events()).toEqual([]);

    expect(await embed(["first", "second"])).toEqual([
      new Float32Array([5, 0, 1]), new Float32Array([6, 1, 1]),
    ]);
    expect(await embed(["fragmented"])).toEqual([new Float32Array([10, 0, 1])]);

    const started = events().filter(({ event }) => event === "start");
    expect(started).toHaveLength(1);
    const requests = events().filter(({ event }) => event === "request");
    expect(requests.map(({ texts }) => texts)).toEqual([["first", "second"], ["fragmented"]]);
  });

  test("applies document truncation and query prefix before sending", async () => {
    await embed(["x".repeat(MAX_CHARS + 10)]);
    await embedQuery("needle");
    await embedQuery(`${QUERY_PREFIX}already prefixed`);

    const requests = events().filter(({ event }) => event === "request");
    expect(requests.at(-3)?.texts?.[0]).toHaveLength(MAX_CHARS);
    expect(requests.at(-2)?.texts).toEqual([`${QUERY_PREFIX}needle`]);
    expect(requests.at(-1)?.texts).toEqual([`${QUERY_PREFIX}already prefixed`]);
  });

  test("matches concurrent replies by request ID even when replies arrive out of order", async () => {
    const [slow, fast] = await Promise.all([embed(["slow-first"]), embed(["fast-second"])]);
    expect(slow).toEqual([new Float32Array([10, 0, 1])]);
    expect(fast).toEqual([new Float32Array([11, 0, 1])]);

    const requests = events().filter(({ event }) => event === "request").slice(-2);
    expect(requests[0]?.id).not.toBe(requests[1]?.id);
  });

  test("surfaces request errors and replaces a sidecar after malformed counts or dimensions", async () => {
    await expect(embed(["request-error"])).rejects.toThrow("fixture request failed");
    // A malformed response kills the protocol process. Do not await its pending
    // request here: the client currently rejects the other pending work and
    // starts fresh; this smoke test verifies that lifecycle boundary offline.
    void embed(["bad-count"]).catch(() => {});
    await sleep(10);
    expect(await embed(["after-bad-count"])).toEqual([new Float32Array([15, 0, 1])]);

    void embed(["bad-dimensions"]).catch(() => {});
    await sleep(10);
    expect(await embed(["after-bad-dimensions"])).toEqual([new Float32Array([20, 0, 1])]);
  });

  test("retries once after an unexpected exit and uses a replacement process", async () => {
    const startsBefore = events().filter(({ event }) => event === "start").length;
    expect(await embed(["exit-once"])).toEqual([new Float32Array([9, 0, 1])]);
    // The exit can be observed after the retry result is returned; wait for the
    // replacement process's startup marker rather than relying on scheduling.
    await sleep(20);
    expect(events().filter(({ event }) => event === "start").length).toBeGreaterThan(startsBefore);
  });

  test("rejects a missing Node binary and invalid embedding mode without starting a process", async () => {
    // Leave no live sidecar to ensure the configured binary is consulted.
    await expect(embed(["exit-always"])).rejects.toThrow("Embedding sidecar exited unexpectedly");
    process.env.EPISODIC_NODE_BINARY = join(directory, "missing-node");
    await expect(embed(["missing-node"])).rejects.toThrow(/Could not start embedding sidecar|exited unexpectedly/);
    process.env.EPISODIC_NODE_BINARY = fixture;

    process.env.EPISODIC_EMBED_MODE = "not-a-mode";
    await expect(embed(["invalid-mode"])).rejects.toThrow('Invalid EPISODIC_EMBED_MODE "not-a-mode"');
    delete process.env.EPISODIC_EMBED_MODE;
  });

  test("keeps inline mode lazy for an empty batch (no Transformers.js/model load)", async () => {
    const startsBefore = events().filter(({ event }) => event === "start").length;
    process.env.EPISODIC_EMBED_MODE = "inline";
    expect(await embed([])).toEqual([]);
    delete process.env.EPISODIC_EMBED_MODE;
    expect(events().filter(({ event }) => event === "start").length).toBe(startsBefore);
  });

  test("ends the detached sidecar when a short-lived Bun host exits", async () => {
    const source = new URL("./embed.ts", import.meta.url).pathname;
    const script = `
      process.env.EPISODIC_NODE_BINARY = ${JSON.stringify(fixture)};
      const { embed } = await import(${JSON.stringify(source)});
      await embed(["short-lived-host"]);
      const { readFileSync } = await import("node:fs");
      const events = readFileSync(${JSON.stringify(join(tmpdir(), "episodic-fake-sidecar-"))} + process.pid + ".log", "utf8")
        .trim().split("\\n").map(JSON.parse);
      console.log(events.find((event) => event.event === "start").pid);
    `;
    const host = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(host.stdout).text();
    await host.exited;
    const pid = Number(output.trim());
    expect(Number.isSafeInteger(pid)).toBe(true);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await sleep(10);
    }
    throw new Error(`sidecar ${pid} remained after its Bun host exited`);
  });
});
