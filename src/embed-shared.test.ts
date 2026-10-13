import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "episodic-shared-test-"));
const fixture = fileURLToPath(new URL("../spikes/fake-embed-service.mjs", import.meta.url));
const embedSource = fileURLToPath(new URL("./embed.ts", import.meta.url));
const serviceSource = fileURLToPath(new URL("./embed-service.mjs", import.meta.url));
const sharedSource = fileURLToPath(new URL("./embed-shared.ts", import.meta.url));
const uid = process.getuid?.() ?? 0;
const runtimes: string[] = [];

type Result = { ok: boolean; vectors?: number[][]; error?: string };
type ServiceEvent = { pid: number; event: string; model?: string; texts?: string[]; code?: number };

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate: () => boolean, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error("condition not met before the timeout");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runtime(): string {
  const directory = mkdtempSync(join(root, "run-"));
  runtimes.push(directory);
  return directory;
}

function serviceDirectory(runtimeDirectory: string): string {
  return join(runtimeDirectory, `episodic-memory-${uid}`);
}

function sockets(runtimeDirectory: string): string[] {
  try {
    return readdirSync(serviceDirectory(runtimeDirectory)).filter((name) => name.endsWith(".sock")).map((name) => join(serviceDirectory(runtimeDirectory), name));
  } catch {
    return [];
  }
}

function events(runtimeDirectory: string): ServiceEvent[] {
  try {
    return readFileSync(join(runtimeDirectory, "events.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const loads = (runtimeDirectory: string) => events(runtimeDirectory).filter(({ event }) => event === "load");

function environment(runtimeDirectory: string, overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    EPISODIC_EMBED_MODE: "shared",
    EPISODIC_NODE_BINARY: fixture,
    EPISODIC_EMBED_READY_TIMEOUT_MS: "3000",
    EPISODIC_EMBED_REQUEST_TIMEOUT_MS: "3000",
    EPISODIC_EMBED_IDLE_TIMEOUT_MS: "300000",
    EPISODIC_TEST_SERVICE_LOG: join(runtimeDirectory, "events.log"),
    XDG_RUNTIME_DIR: runtimeDirectory,
    ...overrides,
  };
}

/** Runs embeddings in an independent Bun process, like a separate OpenCode instance. */
async function client(runtimeDirectory: string, texts: string[], overrides: Record<string, string> = {}): Promise<Result[]> {
  const script = `
    const { embed } = await import(${JSON.stringify(embedSource)});
    const results = await Promise.all(${JSON.stringify(texts)}.map((text) => embed([text]).then(
      (vectors) => ({ ok: true, vectors: vectors.map((vector) => Array.from(vector)) }),
      (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    )));
    console.log(JSON.stringify(results));
  `;
  const host = Bun.spawn([process.execPath, "-e", script], { env: environment(runtimeDirectory, overrides), stdout: "pipe", stderr: "pipe" });
  const watchdog = setTimeout(() => host.kill(), 10_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(host.stdout).text(),
    new Response(host.stderr).text(),
    host.exited,
  ]).finally(() => clearTimeout(watchdog));
  if (exitCode !== 0) throw new Error(`client failed (${exitCode}): ${stderr}`);
  return JSON.parse(stdout.trim());
}

function vector(text: string): number[][] {
  return [[text.length, 0, text.charCodeAt(0)]];
}

afterEach(async () => {
  for (const directory of runtimes) {
    for (const { pid } of events(directory)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
  runtimes.length = 0;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("shared embedding service", () => {
  test("keeps the client and service protocol versions synchronized", () => {
    const service = /export const PROTOCOL = (\d+);/.exec(readFileSync(serviceSource, "utf8"))?.[1];
    const shared = /export const SHARED_PROTOCOL = (\d+);/.exec(readFileSync(sharedSource, "utf8"))?.[1];
    expect(service).toBeDefined();
    expect(service).toBe(shared);
  });

  test("concurrent cold-start clients share one loaded model and receive their own vectors", async () => {
    const run = runtime();
    const overrides = { EPISODIC_TEST_SERVICE_LOAD_DELAY_MS: "150", EPISODIC_TEST_SERVICE_REQUEST_DELAY_MS: "5" };
    const [first, second] = await Promise.all([
      client(run, ["a", "bbbb", "eeeee"], overrides),
      client(run, ["cc", "ddd", "ffffff"], overrides),
    ]);
    expect(first).toEqual(["a", "bbbb", "eeeee"].map((text) => ({ ok: true, vectors: vector(text) })));
    expect(second).toEqual(["cc", "ddd", "ffffff"].map((text) => ({ ok: true, vectors: vector(text) })));
    expect(loads(run)).toHaveLength(1);
    expect(events(run).filter(({ event }) => event === "request")).toHaveLength(6);
  }, 20_000);

  test("simultaneous service starts publish exactly one socket", async () => {
    const run = runtime();
    const directory = serviceDirectory(run);
    mkdirSync(directory, { mode: 0o700 });
    const socketPath = join(directory, "race.sock");
    const starters = Array.from({ length: 4 }, () => Bun.spawn([fixture, serviceSource, socketPath], { env: environment(run), stdout: "ignore", stderr: "ignore" }));
    await waitFor(() => loads(run).length >= 1);
    await Promise.race([Promise.all(starters.slice(1).map((starter) => starter.exited)), sleep(1_500)]);
    await sleep(200);
    expect(loads(run)).toHaveLength(1);
    expect(starters.filter((starter) => starter.exitCode === null)).toHaveLength(1);
    expect(sockets(run)).toEqual([socketPath]);
  }, 20_000);

  test("one client exiting does not stop the service for later clients", async () => {
    const run = runtime();
    expect(await client(run, ["first"])).toEqual([{ ok: true, vectors: vector("first") }]);
    const [service] = loads(run);
    expect(service && alive(service.pid)).toBe(true);
    expect(await client(run, ["second"])).toEqual([{ ok: true, vectors: vector("second") }]);
    expect(loads(run)).toHaveLength(1);
  }, 20_000);

  test("replaces a crashed service and its stale socket", async () => {
    const run = runtime();
    await client(run, ["first"]);
    const [crashed] = loads(run);
    if (!crashed) throw new Error("service never loaded");
    process.kill(crashed.pid, "SIGKILL");
    await waitFor(() => !alive(crashed.pid));
    expect(sockets(run)).toHaveLength(1);

    expect(await client(run, ["second"])).toEqual([{ ok: true, vectors: vector("second") }]);
    const replacement = loads(run)[1];
    expect(replacement?.pid).not.toBe(crashed.pid);
    expect(sockets(run)).toHaveLength(1);
  }, 20_000);

  test("retries an in-flight request when the service crashes", async () => {
    const run = runtime();
    const pending = client(run, ["survivor"], { EPISODIC_TEST_SERVICE_REQUEST_DELAY_MS: "400" });
    await waitFor(() => events(run).some(({ event }) => event === "request"));
    const [crashed] = loads(run);
    if (!crashed) throw new Error("service never loaded");
    process.kill(crashed.pid, "SIGKILL");
    expect(await pending).toEqual([{ ok: true, vectors: vector("survivor") }]);
    expect(loads(run)).toHaveLength(2);
  }, 20_000);

  test("isolates different models and rejects an incompatible handshake", async () => {
    const run = runtime();
    await client(run, ["default"]);
    await client(run, ["other"], { EPISODIC_EMBED_MODEL: "example/other-model" });
    expect(loads(run).map(({ model }) => model).sort()).toEqual(["Snowflake/snowflake-arctic-embed-m-v1.5", "example/other-model"]);
    expect(sockets(run)).toHaveLength(2);

    const socketPath = sockets(run)[0];
    if (!socketPath) throw new Error("no socket");
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect({ path: socketPath });
      let data = "";
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ hello: { protocol: 1, version: "0.0.0", model: "x" } })}\n`));
      socket.on("data", (chunk: string) => { data += chunk; });
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
    });
    expect(JSON.parse(reply.trim())).toMatchObject({ ready: false });
    expect(reply).toContain("incompatible shared embedding service");
  }, 20_000);

  test("stops after the idle timeout and removes its socket", async () => {
    const run = runtime();
    await client(run, ["idle"], { EPISODIC_EMBED_IDLE_TIMEOUT_MS: "100" });
    const [service] = loads(run);
    if (!service) throw new Error("service never loaded");
    await waitFor(() => !alive(service.pid));
    expect(sockets(run)).toEqual([]);
  }, 20_000);

  test("keeps its directory and socket private to the user", async () => {
    const run = runtime();
    await client(run, ["private"]);
    expect(lstatSync(serviceDirectory(run)).mode & 0o777).toBe(0o700);
    const [socketPath] = sockets(run);
    if (!socketPath) throw new Error("no socket");
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
  }, 20_000);

  test("refuses a directory other users can access", async () => {
    const run = runtime();
    mkdirSync(serviceDirectory(run), { mode: 0o755 });
    const [result] = await client(run, ["unsafe"]);
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("Refusing to use shared embedding directory");
    expect(events(run)).toEqual([]);
  }, 20_000);

  test("surfaces model load failures quickly without falling back to a private sidecar", async () => {
    const run = runtime();
    const started = Date.now();
    const [result] = await client(run, ["broken"], { EPISODIC_TEST_SERVICE_LOAD: "fail", EPISODIC_EMBED_READY_TIMEOUT_MS: "5000" });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("fixture load failed");
    // A private-sidecar fallback would also launch the configured Node binary
    // (this fixture) but never reach the service's model load.
    const starts = events(run).filter(({ event }) => event === "start");
    expect(starts.length).toBeGreaterThan(0);
    expect(loads(run).map(({ pid }) => pid)).toEqual(starts.map(({ pid }) => pid));
  }, 20_000);

  test("fails fast when the service is killed during startup", async () => {
    const run = runtime();
    const started = Date.now();
    const [result] = await client(run, ["killed"], { EPISODIC_TEST_SERVICE_STARTUP: "sigkill", EPISODIC_EMBED_READY_TIMEOUT_MS: "5000" });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("SIGKILL");
  }, 20_000);

  test("starts again when its starter exits cleanly without a service", async () => {
    const run = runtime();
    const started = Date.now();
    const result = await client(run, ["again"], { EPISODIC_TEST_SERVICE_STARTUP: "exit0-once", EPISODIC_TEST_SERVICE_ONCE: join(run, "once"), EPISODIC_EMBED_READY_TIMEOUT_MS: "5000" });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(result).toEqual([{ ok: true, vectors: vector("again") }]);
    expect(loads(run)).toHaveLength(1);
  }, 20_000);

  test("recycles a service whose inference hangs", async () => {
    const run = runtime();
    const result = await client(run, ["wedged"], { EPISODIC_TEST_SERVICE_REQUEST: "hang-once", EPISODIC_TEST_SERVICE_ONCE: join(run, "once"), EPISODIC_EMBED_REQUEST_TIMEOUT_MS: "600" });
    expect(result).toEqual([{ ok: true, vectors: vector("wedged") }]);
    const [hung, replacement] = loads(run);
    expect(replacement).toBeDefined();
    await waitFor(() => !alive(hung!.pid));
  }, 20_000);

  test("a long-lived client reconnects across idle shutdowns", async () => {
    const run = runtime();
    const script = `
      const { embed } = await import(${JSON.stringify(embedSource)});
      const results = [];
      for (let index = 0; index < 4; index++) {
        results.push(Array.from((await embed(["tick" + index]))[0]));
        await Bun.sleep(250);
      }
      console.log(JSON.stringify(results));
    `;
    const host = Bun.spawn([process.execPath, "-e", script], { env: environment(run, { EPISODIC_EMBED_IDLE_TIMEOUT_MS: "100" }), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text(), host.exited]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual([0, 1, 2, 3].map((index) => vector(`tick${index}`)[0]));
    expect(loads(run).length).toBeGreaterThanOrEqual(2);
  }, 20_000);
});
