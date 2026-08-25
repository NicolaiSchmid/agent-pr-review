import { randomUUID } from "node:crypto";
import { connect } from "@vercel/connect/eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { database } from "../lib/database.js";
import { env } from "../lib/env.js";
import { requireRepositoryPermission } from "../lib/repository-authorization.js";

const githubAuth = connect({ connector: env.githubConnector, principalType: "app" });

export default defineTool({
  description:
    "Durably defer a pull-request review until CI for its exact head completes. Call this whenever required Check Runs or commit statuses are still pending.",
  inputSchema: z.object({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    pullRequestNumber: z.number().int().positive(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  }),
  async execute(input, ctx) {
    if (ctx.session.auth.current?.authenticator !== "github-webhook") {
      throw new Error("CI deferral currently requires a GitHub PR conversation; Slack deferral is not yet supported");
    }
    if (ctx.session.auth.current.attributes.conversation_kind !== "pull_request") {
      throw new Error("CI deferral must be requested from the PR timeline; proactive inline review-thread continuation is not supported");
    }
    const { token } = await ctx.getToken(githubAuth);
    await requireRepositoryPermission(ctx, token, input.owner, input.repo, "read");
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "eve-engineering-agent" } },
    );
    if (!response.ok) throw new Error(`Could not resolve repository: ${response.status}`);
    const repository = await response.json() as { id: number };
    const repositoryId = String(repository.id);
    const headSha = input.headSha.toLowerCase();
    const conversationId = randomUUID();
    const taskId = randomUUID();
    const key = `github:${repositoryId}#${input.pullRequestNumber}`;
    const installation = ctx.session.auth.current?.attributes.installation_id;
    const rows = await database()<Array<{ id: string }>>`
      with conversation as (
        insert into conversations (
          id, conversation_key, source, repository_id, repository_owner,
          repository_name, github_installation_id, pull_request_number
        ) values (
          ${conversationId}, ${key}, 'github', ${repositoryId}, ${input.owner},
          ${input.repo}, ${typeof installation === "string" && installation ? installation : null},
          ${input.pullRequestNumber}
        )
        on conflict (conversation_key) do update set
          repository_id = excluded.repository_id,
          repository_owner = excluded.repository_owner,
          repository_name = excluded.repository_name,
          github_installation_id = coalesce(excluded.github_installation_id, conversations.github_installation_id),
          pull_request_number = excluded.pull_request_number,
          updated_at = now()
        returning id
      )
      insert into tasks (id, conversation_id, kind, state, repository_id, head_sha)
      select ${taskId}, conversation.id, 'pr_review', 'waiting_for_ci', ${repositoryId}, ${headSha}
      from conversation
      on conflict (conversation_id, head_sha)
        where kind = 'pr_review' and state not in ('completed', 'superseded', 'failed', 'cancelled')
      do update set updated_at = case
        when tasks.state = 'waiting_for_ci' then now()
        else tasks.updated_at
      end
      returning id
    `;
    return { taskId: rows[0]!.id, state: "waiting_for_ci", headSha };
  },
});
