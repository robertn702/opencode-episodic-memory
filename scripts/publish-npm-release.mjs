#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REGISTRY = "https://registry.npmjs.org";
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

function defaultRunNpm(args) {
  return spawnSync("npm", args, { encoding: "utf8" });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function npmIntegrity(runNpm, packageSpec) {
  const result = runNpm([
    "view",
    packageSpec,
    "dist.integrity",
    `--registry=${REGISTRY}`,
  ]);
  return result.status === 0 ? result.stdout.trim() : "";
}

export async function ensurePublished({
  packageName,
  packageVersion,
  tarballPath,
  expectedIntegrity,
  runNpm = defaultRunNpm,
  sleep = defaultSleep,
  attempts = 12,
  delayMs = 5_000,
}) {
  if (!INTEGRITY_RE.test(expectedIntegrity)) {
    throw new Error("release artifact has no valid sha512 integrity");
  }

  const packageSpec = `${packageName}@${packageVersion}`;
  const existingIntegrity = npmIntegrity(runNpm, packageSpec);
  if (existingIntegrity) {
    if (existingIntegrity === expectedIntegrity) {
      return `${packageSpec} is already published with the expected integrity`;
    }
    throw new Error(
      `${packageSpec} is already published with unexpected integrity ${existingIntegrity}`,
    );
  }

  const publish = runNpm([
    "publish",
    tarballPath,
    "--access=public",
    `--registry=${REGISTRY}`,
  ]);
  if (publish.stdout) process.stdout.write(publish.stdout);
  if (publish.stderr) process.stderr.write(publish.stderr);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const publishedIntegrity = npmIntegrity(runNpm, packageSpec);
    if (publishedIntegrity) {
      if (publishedIntegrity === expectedIntegrity) {
        return `${packageSpec} is published with the expected integrity`;
      }
      throw new Error(
        `${packageSpec} was published with unexpected integrity ${publishedIntegrity}`,
      );
    }
    if (attempt + 1 < attempts) await sleep(delayMs);
  }

  throw new Error(
    `${packageSpec} did not appear on registry.npmjs.org after npm publish exited ${publish.status ?? "without a status"}`,
  );
}

async function main() {
  const [tarballPath, expectedIntegrity] = process.argv.slice(2);
  if (!tarballPath || !expectedIntegrity) {
    throw new Error(
      "usage: publish-npm-release.mjs <tarball-path> <sha512-integrity>",
    );
  }
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const message = await ensurePublished({
    packageName: pkg.name,
    packageVersion: pkg.version,
    tarballPath,
    expectedIntegrity,
  });
  console.log(message);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `::error::${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
