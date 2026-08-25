import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { store } from "../lib/database.js";
import { memoryContext } from "../lib/memory-context.js";
import { memoryScopeKey } from "../lib/memory.js";

export default defineTool({
  description:
    "Supersede one long-term memory authored by the authenticated user and visible in the current user/repository/organization/PR context.",
  inputSchema: z.object({ id: z.string().uuid() }),
  approval: always(),
  async execute({ id }, ctx) {
    const { principalId, scopes } = memoryContext(ctx);
    const keys = scopes.map(memoryScopeKey);
    const superseded = await store.supersedeMemory({ id, principalId, scopeKeys: keys });
    return { superseded, id };
  },
});
