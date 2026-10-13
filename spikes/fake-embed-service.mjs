#!/usr/bin/env node
// Test-only stand-in for `node`: runs the real shared embedding service with a
// fake model so socket, lifecycle, and routing logic are exercised without
// loading Transformers.js.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const [servicePath, socketPath] = process.argv.slice(2);
const logPath = process.env.EPISODIC_TEST_SERVICE_LOG;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function log(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...value })}\n`);
}

log({ event: "start" });
process.on("exit", (code) => log({ event: "exit", code }));
const oncePath = process.env.EPISODIC_TEST_SERVICE_ONCE;
function firstTime() {
  if (!oncePath || existsSync(oncePath)) return false;
  writeFileSync(oncePath, String(process.pid));
  return true;
}
const startup = process.env.EPISODIC_TEST_SERVICE_STARTUP;
if (startup === "sigkill") process.kill(process.pid, "SIGKILL");
if (startup === "exit0-once" && firstTime()) process.exit(0);
const { runService } = await import(servicePath);
await runService({
  socketPath,
  load: async (model) => {
    log({ event: "load", model });
    await sleep(Number(process.env.EPISODIC_TEST_SERVICE_LOAD_DELAY_MS ?? 0));
    if (process.env.EPISODIC_TEST_SERVICE_LOAD === "fail") throw new Error("fixture load failed");
    return async (texts) => {
      log({ event: "request", texts });
      if (process.env.EPISODIC_TEST_SERVICE_REQUEST === "hang-once" && firstTime()) await new Promise(() => {});
      await sleep(Number(process.env.EPISODIC_TEST_SERVICE_REQUEST_DELAY_MS ?? 0));
      return texts.map((text, index) => [text.length, index, text.charCodeAt(0)]);
    };
  },
});
