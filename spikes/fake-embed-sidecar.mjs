#!/usr/bin/env node
// Test-only NDJSON sidecar. It deliberately performs no model loading.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logPath = process.env.EPISODIC_TEST_SIDECAR_LOG ?? join(tmpdir(), `episodic-fake-sidecar-${process.ppid}.log`);
const exitOncePath = process.env.EPISODIC_TEST_SIDECAR_EXIT_ONCE ?? join(tmpdir(), `episodic-fake-sidecar-exit-${process.ppid}`);
const startupOncePath = process.env.EPISODIC_TEST_SIDECAR_STARTUP_ONCE ?? join(tmpdir(), `episodic-fake-sidecar-startup-${process.ppid}`);

function log(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

function send(response, fragmented = false) {
  const line = `${JSON.stringify(response)}\n`;
  if (!fragmented) return process.stdout.write(line);
  process.stdout.write(line.slice(0, 7));
  setTimeout(() => process.stdout.write(line.slice(7)), 1);
}

function vector(text, index) {
  return [text.length, index, 1];
}

log({ event: "start", pid: process.pid });
const startupMode = process.env.EPISODIC_TEST_SIDECAR_STARTUP_MODE;
let ignoreRequests = false;
if (startupMode === "never-ready") {
  // Stay alive until the host's readiness timeout tears us down.
} else if (startupMode === "ready-error-once" && !existsSync(startupOncePath)) {
  writeFileSync(startupOncePath, "failed");
  send({ ready: false, error: "fixture startup failed" });
} else if (startupMode === "exit-after-ready-once" && !existsSync(startupOncePath)) {
  writeFileSync(startupOncePath, "exited");
  ignoreRequests = true;
  send({ ready: true });
  setTimeout(() => process.exit(7), 5);
} else {
  send({ ready: true });
}

let remainder = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  let newline;
  while ((newline = remainder.indexOf("\n")) >= 0) {
    const line = remainder.slice(0, newline);
    remainder = remainder.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    log({ event: "request", id: request.id, texts: request.texts });
    if (ignoreRequests || process.env.EPISODIC_TEST_SIDECAR_REQUEST_MODE === "hang-all") continue;
    const first = request.texts[0];
    if (first === "request-error") {
      send({ id: request.id, error: "fixture request failed" });
    } else if (first === "exit-always") {
      process.exit(7);
    } else if (first === "exit-once" && exitOncePath && !existsSync(exitOncePath)) {
      writeFileSync(exitOncePath, "exited");
      process.exit(7);
    } else if (first === "bad-count") {
      send({ id: request.id, vectors: [] });
    } else if (first === "bad-dimensions") {
      send({ id: request.id, vectors: [[1, 2]] });
    } else if (first === "hang-always") {
      // Stay silent until the host's request timeout tears us down.
    } else {
      const delay = first === "slow-first" ? 25 : first === "fast-second" ? 1 : 0;
      setTimeout(() => send({ id: request.id, vectors: request.texts.map(vector) }, first === "fragmented"), delay);
    }
  }
});
