// OpenCode V1 entrypoint; keep the function export for releases before 1.18.29.
import type { Plugin } from "@opencode-ai/plugin";
import { createMemory } from "./shared";

export const EpisodicMemory: Plugin = async ({ client }) => {
  const { tools, reindex } = createMemory(async (level, message) => {
    await client.app.log({ body: { service: "episodic-memory", level, message } }).catch(() => {});
  });

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        reindex(event.properties.sessionID); // fire-and-forget; never block the session
      }
    },
    tool: tools,
  };
};

export default EpisodicMemory;
