// OpenCode v2 server entrypoint.
import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { createMemory } from "./shared";

const v2 = Plugin.define({
  id: "episodic-memory",
  async setup(ctx) {
    const log = async (level: "info" | "warn" | "error", message: string) => {
      // Logging must never interrupt an indexing run or a tool response.
      try {
        console[level](`[episodic-memory] ${message}`);
      } catch {}
    };
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
          if (event.type === "session.idle") reindex(event.data.sessionID);
        }
      } catch (error) {
        if (!controller.signal.aborted) await log("warn", `event subscription failed: ${error}`);
      }
    })();
    return () => controller.abort();
  },
});

export default v2;
