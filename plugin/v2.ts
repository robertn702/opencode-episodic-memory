// OpenCode v2 server entrypoint.
import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { createMemory } from "./shared";
import { createLogger } from "./log";

type ServerEvent = ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never;

// OpenCode v2 marks a session idle with a terminal execution event. The legacy
// session.idle and session.status events are still declared but never published.
// A superseded run is followed by another execution that settles on its own.
// Shutdown interrupts are left to the next local startup backfill (or CLI sync
// for a remote index).
function settledSessionID(event: ServerEvent): string | undefined {
  if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") return event.data.sessionID;
  if (event.type === "session.execution.interrupted" && event.data.reason !== "shutdown" && event.data.reason !== "superseded") {
    return event.data.sessionID;
  }
  return undefined;
}

const v2 = Plugin.define({
  id: "episodic-memory",
  async setup(ctx) {
    const log = createLogger(ctx.app.channel);
    const { tools, reindex } = createMemory(log);

    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(tools)) {
        const schema = z.object(definition.args);
        editor.add({
          name,
          description: definition.description,
          input: z.toJSONSchema(schema),
          async execute(input) {
            const result = await definition.execute(input);
            return { content: result };
          },
        });
      }
    });

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const sessionID = settledSessionID(event);
          if (sessionID) void reindex(sessionID);
        }
        if (!controller.signal.aborted) await log("warn", "event subscription ended; automatic reindex stopped");
      } catch (error) {
        if (!controller.signal.aborted) await log("warn", `event subscription failed: ${error}`);
      }
    })();

    // Backfill sessions that settled while no plugin was indexing. A local
    // freshness scan is cheap; a remote one reads every transcript and makes a
    // network round trip per session, so remote users sync from the CLI.
    if (process.env.EPISODIC_INDEX_URL) {
      await log("info", "started; remote index, so no startup backfill (run the CLI `sync` command to backfill)");
    } else {
      await log("info", "started; backfilling local index");
      void reindex();
    }
    return () => controller.abort();
  },
});

export default v2;
