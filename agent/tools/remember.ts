import { randomUUID } from "node:crypto";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { database } from "../lib/database.js";
import { memoryContext } from "../lib/memory-context.js";
import { memoryScopeKey } from "../lib/memory.js";

export default defineTool({
  description:
    "Save an explicitly requested durable fact or preference for the authenticated user or current GitHub repository/PR. Repository and PR writes are approval-gated and retain provenance.",
  inputSchema: z.object({
    scope: z.enum(["user", "repository", "pull_request"]),
    content: z.string().min(1).max(8_000),
    tags: z.array(z.string().min(1).max(80)).max(20).default([]),
    sourceUrl: z.string().url().optional(),
    expiresAt: z.string().datetime().optional(),
  }),
  approval: always(),
  async execute(input, ctx) {
    const { principalId, scopes } = memoryContext(ctx);
    const scope = scopes.find((candidate) => candidate.kind === input.scope);
    if (!scope) throw new Error(`${input.scope} memory is unavailable in this channel context`);
    const sql = database();
    await sql`
      insert into principals (id) values (${principalId})
      on conflict (id) do nothing
    `;
    const id = randomUUID();
    const key = memoryScopeKey(scope);
    await sql`
      insert into memory_records
        (id, scope_kind, scope_key, content, tags, source_url,
         author_principal_id, status, expires_at)
      values
        (${id}, ${scope.kind}, ${key}, ${input.content}, ${input.tags},
         ${input.sourceUrl ?? null}, ${principalId}, 'confirmed',
         ${input.expiresAt ?? null})
    `;
    return { saved: true, id, scope: key };
  },
});
