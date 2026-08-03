#!/usr/bin/env node
// Test-only NDJSON sidecar. It deliberately performs no model loading.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const logPath = process.env.EPISODIC_TEST_SIDECAR_LOG ?? `/tmp/episodic-fake-sidecar-${process.ppid}.log`;
const exitOncePath = process.env.EPISODIC_TEST_SIDECAR_EXIT_ONCE ?? `/tmp/episodic-fake-sidecar-exit-${process.ppid}`;

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
send({ ready: true });

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
    } else {
      const delay = first === "slow-first" ? 25 : first === "fast-second" ? 1 : 0;
      setTimeout(() => send({ id: request.id, vectors: request.texts.map(vector) }, first === "fragmented"), delay);
    }
  }
});
