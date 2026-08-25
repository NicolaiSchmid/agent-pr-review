import { defineTool } from "eve/tools";
import { z } from "zod";
import { store } from "../lib/database.js";
import { memoryContext } from "../lib/memory-context.js";
import { memoryScopeKey } from "../lib/memory.js";

export default defineTool({
  description:
    "Search confirmed, non-expired long-term memories visible to the authenticated user and current GitHub repository/PR. Returns provenance with every result.",
  inputSchema: z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).default(10) }),
  async execute({ query, limit }, ctx) {
    const { scopes } = memoryContext(ctx);
    const keys = scopes.map(memoryScopeKey);
    const rows = await store.searchMemories<unknown[]>({ scopeKeys: keys, query, limit });
    return { memories: rows };
  },
});
