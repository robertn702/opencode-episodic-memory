import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = join(import.meta.dirname, "check-npm-release.mjs");
const WORKFLOW = join(
  import.meta.dirname,
  "../.github/workflows/publish-npm.yml",
);
const REPO_URL =
  "git+https://github.com/robertn702/opencode-episodic-memory.git";
const tmpRepos = [];

function makeRepo(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "episodic-release-check-"));
  tmpRepos.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "opencode-episodic-memory",
      version: "1.2.3",
      repository: { type: "git", url: REPO_URL },
      ...overrides,
    }),
  );
  return dir;
}

function run(tag, repoDir = makeRepo()) {
  return spawnSync(process.execPath, [SCRIPT, tag, repoDir], {
    encoding: "utf8",
  });
}

test("accepts an exact tag and package match", () => {
  const result = run("v1.2.3");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ok:/);
});

for (const tag of [
  "1.2.3",
  "v1.2",
  "v01.2.3",
  "v1.2.3-beta.1",
  "release-v1.2.3",
]) {
  test(`rejects invalid tag ${tag}`, () => {
    assert.notEqual(run(tag).status, 0);
  });
}

test("rejects a tag and package version mismatch", () => {
  const result = run("v1.2.4");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match/);
});

test("rejects an unexpected package name", () => {
  assert.notEqual(run("v1.2.3", makeRepo({ name: "other-package" })).status, 0);
});

test("rejects an unexpected repository URL", () => {
  const repository = {
    type: "git",
    url: "git+https://github.com/evil/fork.git",
  };
  assert.notEqual(run("v1.2.3", makeRepo({ repository })).status, 0);
});

test("rejects private packages", () => {
  assert.notEqual(run("v1.2.3", makeRepo({ private: true })).status, 0);
});

test("rejects a custom registry", () => {
  const publishConfig = { registry: "https://evil.example.com" };
  assert.notEqual(run("v1.2.3", makeRepo({ publishConfig })).status, 0);
});

test("requires a tag argument", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage:/);
});

test("workflow keeps publishing and release permissions separate", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /tags: \["v\*"\]/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /environment: npm-publish/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /npm pack --ignore-scripts --json/);
  assert.match(workflow, /npm pack must return exactly one artifact/);
  assert.match(workflow, /npm pack returned the wrong package identity/);
  assert.match(workflow, /\^sha512-/);
  assert.match(workflow, /EXPECTED_INTEGRITY/);
  assert.match(workflow, /node scripts\/publish-npm-release\.mjs/);
  assert.match(workflow, /needs: publish[\s\S]*contents: write/);
  assert.match(workflow, /object_sha" != "\$EXPECTED_SHA"/);
  assert.match(workflow, /gh release create/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});

process.on("exit", () => {
  for (const dir of tmpRepos) rmSync(dir, { recursive: true, force: true });
});
