// Plugin logging for OpenCode v2. The v2 plugin context has no logger, and the
// CLI and background service discard server stderr unless OPENCODE_PRINT_LOGS=1,
// so console output is lost. Append to OpenCode's own log file instead: every
// OpenCode process appends to it (O_APPEND), and it is trimmed in place.
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export function openCodeLogFile(channel: string, env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME || join(homedir(), ".local/share");
  return join(data, "opencode", "log", channel === "local" ? "opencode-local.log" : "opencode.log");
}

// Matches OpenCode's key=value line format so lines are greppable alongside its own.
export function formatLogLine(level: LogLevel, message: string, now = new Date()): string {
  const text = `[episodic-memory] ${message}`;
  const value = /^[^\s="\\]+$/.test(text) ? text : JSON.stringify(text);
  return `timestamp=${now.toISOString()} level=${level.toUpperCase()} service=episodic-memory message=${value}\n`;
}

export function createLogger(channel: string) {
  const file = openCodeLogFile(channel);
  return async (level: LogLevel, message: string): Promise<void> => {
    // Logging must never interrupt an indexing run or a tool response.
    const line = formatLogLine(level, message);
    try {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, line);
    } catch {}
    if (process.env.OPENCODE_PRINT_LOGS === "1") {
      try {
        process.stderr.write(line);
      } catch {}
    }
  };
}
