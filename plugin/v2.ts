// OpenCode V2 server entrypoint. The V1 tool implementations stay in shared.ts.
import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin";
import { createMemory } from "./shared";
import { EpisodicMemory } from "./episodic-memory";

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
          async execute(input, context) {
            const args = schema.parse(input);
            // Shared V1 executors do not use their tool context. Supply its
            // required shape here while V2 owns the actual call lifecycle.
            const legacyContext: ToolContext = {
              sessionID: context.sessionID,
              messageID: context.messageID,
              agent: context.agent,
              directory: ctx.location.directory,
              worktree: ctx.location.directory,
              abort: context.signal,
              metadata: () => {},
              ask: async () => {},
            };
            const result = await executeTool(definition, args, legacyContext);
            return { content: typeof result === "string" ? result : result.output };
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

// V1 1.18.32 also resolves ./server before main and recognizes server(). V2
// consumes setup(); older V1 hosts use main's function export.
export default Object.assign(v2, { server: EpisodicMemory });

async function executeTool(definition: ToolDefinition, args: Record<string, unknown>, context: ToolContext) {
  return definition.execute(args, context);
}
