import { randomUUID } from "node:crypto";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { database } from "../lib/database.js";
import { memoryContext } from "../lib/memory-context.js";
import { memoryScopeKey } from "../lib/memory.js";
import { connect } from "@vercel/connect/eve";
import { env } from "../lib/env.js";
import { requireRepositoryPermission } from "../lib/repository-authorization.js";

const githubAuth = connect({ connector: env.githubConnector, principalType: "app" });

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
    if (scope.kind === "repository" || scope.kind === "pull_request") {
      const repository = ctx.session.auth.current?.attributes.repository;
      if (typeof repository !== "string" || !repository.includes("/")) {
        throw new Error("Trusted GitHub repository context is required");
      }
      const [owner, repo] = repository.split("/", 2) as [string, string];
      const { token } = await ctx.getToken(githubAuth);
      await requireRepositoryPermission(ctx, token, owner, repo, "write");
    }
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
