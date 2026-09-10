import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "episodic-embed-test-"));
const logPath = join(directory, "sidecar.log");
const exitOncePath = join(directory, "exit-once");
const startupOncePath = join(directory, "startup-once");
const fixture = fileURLToPath(new URL("../spikes/fake-embed-sidecar.mjs", import.meta.url));
const source = fileURLToPath(new URL("./embed.ts", import.meta.url));
const sidecarSource = fileURLToPath(new URL("./embed-sidecar.mjs", import.meta.url));
const controlledEnvironment = [
  "EPISODIC_NODE_BINARY",
  "EPISODIC_EMBED_MODE",
  "EPISODIC_EMBED_BATCH_SIZE",
  "EPISODIC_EMBED_READY_TIMEOUT_MS",
  "EPISODIC_EMBED_REQUEST_TIMEOUT_MS",
  "EPISODIC_EMBED_IDLE_TIMEOUT_MS",
  "EPISODIC_TEST_SIDECAR_LOG",
  "EPISODIC_TEST_SIDECAR_EXIT_ONCE",
  "EPISODIC_TEST_SIDECAR_STARTUP_ONCE",
  "EPISODIC_TEST_SIDECAR_STARTUP_MODE",
  "EPISODIC_TEST_SIDECAR_REQUEST_MODE",
  "EPISODIC_TEST_SIDECAR_DELAY_EXIT_MS",
  "EPISODIC_TEST_SIDECAR_READY_DELAY_MS",
  "EPISODIC_TEST_SIDECAR_IGNORE_SIGTERM",
  "EPISODIC_TEST_SIDECAR_IGNORE_SIGTERM_ONCE",
] as const;
const originalEnvironment = new Map(controlledEnvironment.map((name) => [name, process.env[name]]));

process.env.EPISODIC_NODE_BINARY = fixture;
process.env.EPISODIC_EMBED_MODE = "sidecar";
process.env.EPISODIC_EMBED_BATCH_SIZE = "32";
process.env.EPISODIC_EMBED_READY_TIMEOUT_MS = "2000";
process.env.EPISODIC_EMBED_REQUEST_TIMEOUT_MS = "2000";
process.env.EPISODIC_EMBED_IDLE_TIMEOUT_MS = "300000";
process.env.EPISODIC_TEST_SIDECAR_LOG = logPath;
process.env.EPISODIC_TEST_SIDECAR_EXIT_ONCE = exitOncePath;
process.env.EPISODIC_TEST_SIDECAR_STARTUP_ONCE = startupOncePath;
delete process.env.EPISODIC_TEST_SIDECAR_STARTUP_MODE;
delete process.env.EPISODIC_TEST_SIDECAR_REQUEST_MODE;
delete process.env.EPISODIC_TEST_SIDECAR_DELAY_EXIT_MS;
delete process.env.EPISODIC_TEST_SIDECAR_READY_DELAY_MS;
delete process.env.EPISODIC_TEST_SIDECAR_IGNORE_SIGTERM;
delete process.env.EPISODIC_TEST_SIDECAR_IGNORE_SIGTERM_ONCE;

const { embed, embedQuery, DEFAULT_MODEL, MAX_CHARS, QUERY_PREFIX } = await import("./embed.ts");

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("condition not met before the timeout");
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function events(): Array<{ event: string; id?: number; texts?: string[]; pid?: number }> {
  try {
    return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

type IsolatedResult = { ok: boolean; vectors?: number[][]; error?: string };

async function isolatedEmbeds(texts: string[], environment: Record<string, string> = {}) {
  const hostDirectory = mkdtempSync(join(directory, "host-"));
  const hostLogPath = join(hostDirectory, "sidecar.log");
  const hostExitOncePath = join(hostDirectory, "exit-once");
  const hostStartupOncePath = join(hostDirectory, "startup-once");
  const script = `
    const { embed } = await import(${JSON.stringify(source)});
    const results = await Promise.all(${JSON.stringify(texts)}.map((text) => embed([text]).then(
      (vectors) => ({ ok: true, vectors: vectors.map((vector) => Array.from(vector)) }),
      (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    )));
    console.log(JSON.stringify(results));
  `;
  const host = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      EPISODIC_NODE_BINARY: fixture,
      EPISODIC_TEST_SIDECAR_LOG: hostLogPath,
      EPISODIC_TEST_SIDECAR_EXIT_ONCE: hostExitOncePath,
      EPISODIC_TEST_SIDECAR_STARTUP_ONCE: hostStartupOncePath,
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const watchdog = setTimeout(() => host.kill(), 5_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(host.stdout).text(),
    new Response(host.stderr).text(),
    host.exited,
  ]).finally(() => clearTimeout(watchdog));
  if (exitCode !== 0) throw new Error(`isolated embedding host failed (${exitCode}): ${stderr}`);
  const hostEvents = (() => {
    try {
      return readFileSync(hostLogPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  })();
  return { results: JSON.parse(stdout.trim()) as IsolatedResult[], events: hostEvents };
}

async function isolatedEmbed(text: string, environment: Record<string, string> = {}) {
  const { results, events: hostEvents } = await isolatedEmbeds([text], environment);
  const result = results[0];
  if (!result) throw new Error("isolated embedding host returned no result");
  return { result, events: hostEvents };
}

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
  for (const name of controlledEnvironment) {
    const value = originalEnvironment.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

  test("keeps the host and sidecar default model synchronized", () => {
    expect(readFileSync(sidecarSource, "utf8")).toContain(`?? ${JSON.stringify(DEFAULT_MODEL)}`);
  });

  test("splits large embedding inputs into bounded sidecar requests without reordering", async () => {
    const texts = Array.from({ length: 33 }, (_, index) => "x".repeat(index + 1));
    const vectors = await embed(texts);
    expect(vectors.map((vector) => vector[0])).toEqual(texts.map((text) => text.length));
    const requests = events().filter(({ event }) => event === "request").slice(-2);
    expect(requests.map(({ texts: requestTexts }) => requestTexts?.length)).toEqual([32, 1]);
  });

  test("evicts an idle sidecar and starts one replacement for concurrent fresh work", async () => {
    const hostDirectory = mkdtempSync(join(directory, "idle-host-"));
    const hostLogPath = join(hostDirectory, "sidecar.log");
    const script = `
      const { embed } = await import(${JSON.stringify(source)});
      await embed(["before-idle"]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const results = await Promise.all([embed(["after-idle-one"]), embed(["after-idle-two"])]);
      console.log(JSON.stringify(results.map((vectors) => vectors.map((vector) => Array.from(vector)))));
    `;
    const host = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        EPISODIC_NODE_BINARY: fixture,
        EPISODIC_TEST_SIDECAR_LOG: hostLogPath,
        EPISODIC_EMBED_IDLE_TIMEOUT_MS: "20",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const watchdog = setTimeout(() => host.kill(), 5_000);
    const [stdout, stderr, code] = await Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited]).finally(() => clearTimeout(watchdog));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout.trim())).toEqual([[[14, 0, 1]], [[14, 0, 1]]]);
    const hostEvents = readFileSync(hostLogPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const starts = hostEvents.filter(({ event }: { event: string }) => event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[0].pid).not.toBe(starts[1].pid);
  });

  test("accepts disabled idle eviction and rejects invalid values before spawning", async () => {
    const hostDirectory = mkdtempSync(join(directory, "disabled-idle-host-"));
    const hostLogPath = join(hostDirectory, "sidecar.log");
    const script = `
      const { embed } = await import(${JSON.stringify(source)});
      await embed(["disabled-one"]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await embed(["disabled-two"]);
      console.log("ok");
    `;
    const host = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, EPISODIC_NODE_BINARY: fixture, EPISODIC_TEST_SIDECAR_LOG: hostLogPath, EPISODIC_EMBED_IDLE_TIMEOUT_MS: "0" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("ok");
    const disabledEvents = readFileSync(hostLogPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(disabledEvents.filter(({ event }: { event: string }) => event === "start")).toHaveLength(1);

    const invalid = await isolatedEmbed("never-spawned", { EPISODIC_EMBED_IDLE_TIMEOUT_MS: "-1" });
    expect(invalid.result.ok).toBe(false);
    expect(invalid.result.error).toContain("Invalid EPISODIC_EMBED_IDLE_TIMEOUT_MS");
    expect(invalid.events).toEqual([]);
  });

  test("waits for a deliberately slow idle shutdown before sharing one replacement", async () => {
    const hostDirectory = mkdtempSync(join(directory, "idle-race-host-"));
    const hostLogPath = join(hostDirectory, "sidecar.log");
    const script = `
      import { existsSync, readFileSync } from "node:fs";
      const { embed } = await import(${JSON.stringify(source)});
      const log = ${JSON.stringify(hostLogPath)};
      const waitForStopping = async () => {
        const until = Date.now() + 2000;
        while (Date.now() < until) {
          if (existsSync(log) && readFileSync(log, "utf8").includes('"event":"stopping"')) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("idle shutdown did not start");
      };
      await embed(["race-before"]);
      await waitForStopping();
      const results = await Promise.all([embed(["race-after-one"]), embed(["race-after-two"])]);
      console.log(JSON.stringify(results.map((vectors) => vectors.map((vector) => Array.from(vector)))));
    `;
    const host = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        EPISODIC_NODE_BINARY: fixture,
        EPISODIC_TEST_SIDECAR_LOG: hostLogPath,
        EPISODIC_EMBED_IDLE_TIMEOUT_MS: "15",
        EPISODIC_TEST_SIDECAR_DELAY_EXIT_MS: "75",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const watchdog = setTimeout(() => host.kill(), 5_000);
    const [stdout, stderr, code] = await Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited]).finally(() => clearTimeout(watchdog));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout.trim())).toEqual([[[14, 0, 1]], [[14, 0, 1]]]);
    const hostEvents = readFileSync(hostLogPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const starts = hostEvents.filter(({ event }: { event: string }) => event === "start");
    expect(starts).toHaveLength(2);
    const firstExit = hostEvents.findIndex(({ event }: { event: string }) => event === "exit");
    const replacementStart = hostEvents.findIndex(({ event, pid }: { event: string; pid?: number }) => event === "start" && pid === starts[1].pid);
    expect(firstExit).toBeGreaterThanOrEqual(0);
    expect(replacementStart).toBeGreaterThan(firstExit);
  });

  test("never idles a sidecar while readiness or concurrent work is active", async () => {
    const readiness = await isolatedEmbed("slow-first", {
      EPISODIC_EMBED_IDLE_TIMEOUT_MS: "10",
      EPISODIC_TEST_SIDECAR_READY_DELAY_MS: "40",
    });
    expect(readiness.result).toEqual({ ok: true, vectors: [[10, 0, 1]] });
    expect(readiness.events.filter(({ event }: { event: string }) => event === "start")).toHaveLength(1);

    const work = await isolatedEmbeds(Array.from({ length: 33 }, (_, index) => index === 0 ? "slow-first" : `batch-${index}`), {
      EPISODIC_EMBED_IDLE_TIMEOUT_MS: "10",
      EPISODIC_EMBED_BATCH_SIZE: "32",
    });
    expect(work.results.every(({ ok }) => ok)).toBe(true);
    expect(work.events.filter(({ event }: { event: string }) => event === "start")).toHaveLength(1);
  });

  test("keeps one lease across delayed sequential batches of a logical embed", async () => {
    const hostDirectory = mkdtempSync(join(directory, "batch-lease-host-"));
    const hostLogPath = join(hostDirectory, "sidecar.log");
    const script = `
      const { embed } = await import(${JSON.stringify(source)});
      const texts = Array.from({ length: 33 }, (_, index) => index === 0 ? "slow-first" : "batch-" + index);
      console.log((await embed(texts)).length);
    `;
    const host = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, EPISODIC_NODE_BINARY: fixture, EPISODIC_TEST_SIDECAR_LOG: hostLogPath, EPISODIC_EMBED_IDLE_TIMEOUT_MS: "10", EPISODIC_EMBED_BATCH_SIZE: "32" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("33");
    const batchEvents = readFileSync(hostLogPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(batchEvents.filter(({ event }: { event: string }) => event === "start")).toHaveLength(1);
    expect(batchEvents.filter(({ event }: { event: string }) => event === "request").map(({ texts }: { texts: string[] }) => texts.length)).toEqual([32, 1]);
  });

  test("resets idle time after fresh work and recoverable request errors", async () => {
    const hostDirectory = mkdtempSync(join(directory, "idle-reset-host-"));
    const hostLogPath = join(hostDirectory, "sidecar.log");
    const script = `
      const { embed } = await import(${JSON.stringify(source)});
      const wait = () => new Promise((resolve) => setTimeout(resolve, 35));
      await embed(["reset-first"]);
      await wait();
      await embed(["request-error"]).catch(() => {});
      await wait();
      await embed(["reset-last"]);
      console.log("ok");
    `;
    const host = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, EPISODIC_NODE_BINARY: fixture, EPISODIC_TEST_SIDECAR_LOG: hostLogPath, EPISODIC_EMBED_IDLE_TIMEOUT_MS: "60" }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("ok");
    const resetEvents = readFileSync(hostLogPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(resetEvents.filter(({ event }: { event: string }) => event === "start")).toHaveLength(1);
    expect(resetEvents.filter(({ event }: { event: string }) => event === "request").map(({ texts }: { texts: string[] }) => texts[0])).toEqual(["reset-first", "request-error", "reset-last"]);
  });

  test("force-kills an uncooperative idle child before concurrent callers share a replacement", async () => {
    const hostDirectory = mkdtempSync(join(directory, "force-kill-host-"));
    const hostLogPath = join(hostDirectory, "sidecar.log");
    const ignoredOncePath = join(hostDirectory, "ignored-once");
    const script = `
      import { existsSync, readFileSync } from "node:fs";
      const { embed } = await import(${JSON.stringify(source)});
      const log = ${JSON.stringify(hostLogPath)};
      await embed(["force-before"]);
      while (!existsSync(log) || !readFileSync(log, "utf8").includes('"event":"ignored-sigterm"')) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await Promise.all([embed(["force-after-one"]), embed(["force-after-two"])]);
      await new Promise((resolve) => setTimeout(resolve, 40));
      console.log("ok");
    `;
    const host = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, EPISODIC_NODE_BINARY: fixture, EPISODIC_TEST_SIDECAR_LOG: hostLogPath, EPISODIC_EMBED_IDLE_TIMEOUT_MS: "15", EPISODIC_TEST_SIDECAR_IGNORE_SIGTERM_ONCE: ignoredOncePath }, stdout: "pipe", stderr: "pipe" });
    const watchdog = setTimeout(() => host.kill(), 5_000);
    const [stdout, stderr, code] = await Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited]).finally(() => clearTimeout(watchdog));
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("ok");
    const forceEvents = readFileSync(hostLogPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const starts = forceEvents.filter(({ event }: { event: string }) => event === "start");
    expect(starts).toHaveLength(2);
    expect(processIsGone(starts[0].pid)).toBe(true);
    expect(forceEvents.filter(({ event }: { event: string }) => event === "request").map(({ texts }: { texts: string[] }) => texts[0])).toEqual(["force-before", "force-after-one", "force-after-two"]);
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
    await expect(embed(["bad-count"])).rejects.toThrow("expected 1 vectors");
    expect(await embed(["after-bad-count"])).toEqual([new Float32Array([15, 0, 1])]);

    await expect(embed(["bad-dimensions"])).rejects.toThrow("expected 3 dimensions");
    expect(await embed(["after-bad-dimensions"])).toEqual([new Float32Array([20, 0, 1])]);
  });

  test("retries once after an unexpected exit and uses a replacement process", async () => {
    const startsBefore = events().filter(({ event }) => event === "start").length;
    expect(await embed(["exit-once"])).toEqual([new Float32Array([9, 0, 1])]);
    await waitFor(() => events().filter(({ event }) => event === "start").length > startsBefore);
    expect(events().filter(({ event }) => event === "start").length).toBeGreaterThan(startsBefore);
  });

  test("retries a ready:false startup with a fresh sidecar", async () => {
    const { result, events: hostEvents } = await isolatedEmbed("ready-after-retry", {
      EPISODIC_TEST_SIDECAR_STARTUP_MODE: "ready-error-once",
    });
    expect(result).toEqual({ ok: true, vectors: [[17, 0, 1]] });
    expect(hostEvents.filter(({ event }: { event: string }) => event === "start")).toHaveLength(2);
  });

  test("settles and retries when the sidecar exits immediately after readiness", async () => {
    const { result, events: hostEvents } = await isolatedEmbed("post-ready-retry", {
      EPISODIC_TEST_SIDECAR_STARTUP_MODE: "exit-after-ready-once",
    });
    expect(result).toEqual({ ok: true, vectors: [[16, 0, 1]] });
    expect(hostEvents.filter(({ event }: { event: string }) => event === "start")).toHaveLength(2);
  });

  test("does not send or hang a request when ready output is immediately followed by a protocol fault", async () => {
    const { result, events: hostEvents } = await isolatedEmbed("after-invalid-ready", {
      EPISODIC_TEST_SIDECAR_STARTUP_MODE: "ready-then-invalid",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("stdout contained invalid JSON");
    expect(hostEvents.filter(({ event }: { event: string }) => event === "request")).toHaveLength(0);
    expect(hostEvents.filter(({ event }: { event: string }) => event === "start")).toHaveLength(1);
  });

  test("bounds readiness and request waits and tears down stalled sidecars", async () => {
    const readiness = await isolatedEmbed("never-sent", {
      EPISODIC_TEST_SIDECAR_STARTUP_MODE: "never-ready",
      EPISODIC_EMBED_READY_TIMEOUT_MS: "200",
    });
    expect(readiness.result.ok).toBe(false);
    expect(readiness.result.error).toContain("did not become ready within 200ms");
    expect(readiness.events.filter(({ event }: { event: string }) => event === "start")).toHaveLength(2);

    const request = await isolatedEmbed("hang-always", {
      EPISODIC_EMBED_REQUEST_TIMEOUT_MS: "25",
    });
    expect(request.result.ok).toBe(false);
    expect(request.result.error).toContain("request timed out after 25ms");
    expect(request.events.filter(({ event }: { event: string }) => event === "start")).toHaveLength(2);
    const pids = request.events.flatMap(({ event, pid }: { event: string; pid?: number }) => event === "start" && pid ? [pid] : []);
    await waitFor(() => pids.every(processIsGone));
  });

  test("settles concurrent pending requests when a timeout replaces the sidecar", async () => {
    const { results, events: hostEvents } = await isolatedEmbeds(["pending-one", "pending-two"], {
      EPISODIC_TEST_SIDECAR_REQUEST_MODE: "hang-all",
      EPISODIC_EMBED_REQUEST_TIMEOUT_MS: "25",
    });
    expect(results).toHaveLength(2);
    expect(results.every(({ ok }) => !ok)).toBe(true);
    expect(results.every(({ error }) => error?.includes("request timed out after 25ms"))).toBe(true);
    expect(hostEvents.filter(({ event }: { event: string }) => event === "start")).toHaveLength(2);
    const pids = hostEvents.flatMap(({ event, pid }: { event: string; pid?: number }) => event === "start" && pid ? [pid] : []);
    await waitFor(() => pids.every(processIsGone));
  });

  test("rejects invalid sidecar limits before starting a process", async () => {
    const invalidSettings = [
      ["EPISODIC_EMBED_BATCH_SIZE", "0"],
      ["EPISODIC_EMBED_BATCH_SIZE", "65"],
      ["EPISODIC_EMBED_BATCH_SIZE", "1e2"],
      ["EPISODIC_EMBED_READY_TIMEOUT_MS", ""],
      ["EPISODIC_EMBED_REQUEST_TIMEOUT_MS", "1.5"],
    ] as const;
    for (const [name, value] of invalidSettings) {
      const { result, events: hostEvents } = await isolatedEmbed("invalid-setting", { [name]: value });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(`Invalid ${name}`);
      expect(hostEvents).toEqual([]);
    }
  });

  test("rejects a missing Node binary and invalid embedding mode without starting a process", async () => {
    // Leave no live sidecar to ensure the configured binary is consulted.
    await expect(embed(["exit-always"])).rejects.toThrow("Embedding sidecar exited unexpectedly");
    process.env.EPISODIC_NODE_BINARY = join(directory, "missing-node");
    try {
      await expect(embed(["missing-node"])).rejects.toThrow(/Could not start embedding sidecar|exited unexpectedly/);
    } finally {
      process.env.EPISODIC_NODE_BINARY = fixture;
    }

    process.env.EPISODIC_EMBED_MODE = "not-a-mode";
    try {
      await expect(embed(["invalid-mode"])).rejects.toThrow('Invalid EPISODIC_EMBED_MODE "not-a-mode"');
    } finally {
      process.env.EPISODIC_EMBED_MODE = "sidecar";
    }
  });

  test("keeps inline mode lazy for an empty batch (no Transformers.js/model load)", async () => {
    const startsBefore = events().filter(({ event }) => event === "start").length;
    process.env.EPISODIC_EMBED_MODE = "inline";
    try {
      expect(await embed([])).toEqual([]);
    } finally {
      process.env.EPISODIC_EMBED_MODE = "sidecar";
    }
    expect(events().filter(({ event }) => event === "start").length).toBe(startsBefore);
  });

  test("ends the detached sidecar when a short-lived Bun host exits", async () => {
    const hostLogPath = join(directory, "short-lived-host.log");
    const hostExitOncePath = join(directory, "short-lived-host-exit-once");
    const script = `
      const { embed } = await import(${JSON.stringify(source)});
      await embed(["short-lived-host"]);
      const { readFileSync } = await import("node:fs");
      const events = readFileSync(${JSON.stringify(hostLogPath)}, "utf8")
        .trim().split("\\n").map(JSON.parse);
      console.log(events.find((event) => event.event === "start").pid);
    `;
    const host = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        EPISODIC_NODE_BINARY: fixture,
        EPISODIC_TEST_SIDECAR_LOG: hostLogPath,
        EPISODIC_TEST_SIDECAR_EXIT_ONCE: hostExitOncePath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(host.stdout).text();
    await host.exited;
    const pid = Number(output.trim());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    await waitFor(() => processIsGone(pid));
  });
});
