#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_NAME = "opencode-episodic-memory";
const REPO_URL =
  "git+https://github.com/robertn702/opencode-episodic-memory.git";
const TAG_RE = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const [releaseTag, repoRoot = process.cwd()] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`::error::${message}\n`);
  process.exit(1);
}

if (!releaseTag) fail("usage: check-npm-release.mjs <vX.Y.Z> [repo-root]");

const match = TAG_RE.exec(releaseTag);
if (!match)
  fail(`tag ${JSON.stringify(releaseTag)} is not a valid vX.Y.Z release tag`);
const version = match.slice(1).join(".");

let pkg;
try {
  pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
} catch (error) {
  fail(`cannot read package.json: ${error.message}`);
}

if (pkg.name !== PACKAGE_NAME) {
  fail(
    `package.json name is ${JSON.stringify(pkg.name)}, expected ${PACKAGE_NAME}`,
  );
}
if (pkg.version !== version) {
  fail(
    `tag ${releaseTag} does not match package.json version ${JSON.stringify(pkg.version)}`,
  );
}
if (pkg.repository?.url !== REPO_URL) {
  fail(`package.json repository.url must be ${REPO_URL}`);
}
if (pkg.private === true) fail("package.json must not be private");
if (pkg.publishConfig?.registry) {
  fail(
    "package.json sets publishConfig.registry; releases must publish to registry.npmjs.org",
  );
}

console.log(`ok: ${releaseTag} matches ${PACKAGE_NAME}@${version}`);
