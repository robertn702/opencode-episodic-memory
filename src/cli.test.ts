import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("cli", () => {
  test("remote indexed reads require --source before opening the index", () => {
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "cli.ts"),
      "read",
      "ses_test",
      "--indexed",
    ], {
      env: {
        ...process.env,
        EPISODIC_INDEX_URL: "libsql://unreachable.invalid",
        EPISODIC_INDEX_AUTH_TOKEN: "test-token",
        EPISODIC_SOURCE_ID: "test-source",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("error: --source is required for remote indexed reads.\n");
  });
});
