import { defineTool } from "eve/tools";
import { z } from "zod";
import { database } from "../lib/database.js";
import { memoryContext } from "../lib/memory-context.js";
import { memoryScopeKey } from "../lib/memory.js";

export default defineTool({
  description:
    "Search confirmed, non-expired long-term memories visible to the authenticated user and current GitHub repository/PR. Returns provenance with every result.",
  inputSchema: z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).default(10) }),
  async execute({ query, limit }, ctx) {
    const { scopes } = memoryContext(ctx);
    const keys = scopes.map(memoryScopeKey);
    const sql = database();
    const rows = await sql`
      select id, scope_kind, scope_key, content, tags, source_url,
             author_principal_id, status, created_at, expires_at
      from memory_records
      where scope_key = any(${keys})
        and status = 'confirmed'
        and (expires_at is null or expires_at > now())
        and content ilike ${`%${query}%`}
      order by updated_at desc
      limit ${limit}
    `;
    return { memories: rows };
  },
});
