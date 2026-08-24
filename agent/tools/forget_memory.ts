import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { database } from "../lib/database.js";
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
    const sql = database();
    const rows = await sql`
      update memory_records
      set status = 'superseded', updated_at = now()
      where id = ${id}
        and author_principal_id = ${principalId}
        and scope_key = any(${keys})
        and status <> 'superseded'
      returning id
    `;
    return { superseded: rows.length === 1, id };
  },
});
