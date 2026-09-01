import assert from "node:assert/strict";
import { test } from "node:test";
import { ensurePublished } from "./publish-npm-release.mjs";

const EXPECTED = "sha512-YWJjZA==";
const DIFFERENT = "sha512-ZGlmZmVyZW50";

function result(status, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

function scenario(responses) {
  const calls = [];
  return {
    calls,
    runNpm(args) {
      calls.push(args);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected npm call: ${args.join(" ")}`);
      return next;
    },
  };
}

function publish(options = {}) {
  return ensurePublished({
    packageName: "opencode-episodic-memory",
    packageVersion: "1.2.3",
    tarballPath: "/tmp/opencode-episodic-memory-1.2.3.tgz",
    expectedIntegrity: EXPECTED,
    sleep: async () => {},
    attempts: 2,
    ...options,
  });
}

test("accepts an existing exact integrity without publishing", async () => {
  const npm = scenario([result(0, `${EXPECTED}\n`)]);
  await assert.doesNotReject(publish({ runNpm: npm.runNpm }));
  assert.equal(npm.calls.length, 1);
  assert.equal(npm.calls[0][0], "view");
});

test("rejects an existing different integrity", async () => {
  const npm = scenario([result(0, `${DIFFERENT}\n`)]);
  await assert.rejects(publish({ runNpm: npm.runNpm }), /unexpected integrity/);
  assert.equal(npm.calls.length, 1);
});

test("recovers when publish fails after the exact artifact appears", async () => {
  const npm = scenario([result(1), result(1), result(0, `${EXPECTED}\n`)]);
  await assert.doesNotReject(publish({ runNpm: npm.runNpm }));
  assert.equal(npm.calls[1][0], "publish");
});

test("rejects when publish succeeds but the package never appears", async () => {
  const npm = scenario([result(1), result(0), result(1), result(1)]);
  await assert.rejects(publish({ runNpm: npm.runNpm }), /did not appear/);
});

test("rejects a different integrity during polling", async () => {
  const npm = scenario([result(1), result(0), result(0, `${DIFFERENT}\n`)]);
  await assert.rejects(publish({ runNpm: npm.runNpm }), /unexpected integrity/);
});

test("rejects an empty expected integrity before any npm call", async () => {
  const npm = scenario([]);
  await assert.rejects(
    publish({ expectedIntegrity: "", runNpm: npm.runNpm }),
    /valid sha512/,
  );
  assert.equal(npm.calls.length, 0);
});

test("pins every npm network call to registry.npmjs.org", async () => {
  const npm = scenario([result(1), result(0), result(0, `${EXPECTED}\n`)]);
  await publish({ runNpm: npm.runNpm });
  for (const args of npm.calls) {
    assert.ok(args.includes("--registry=https://registry.npmjs.org"));
  }
});
