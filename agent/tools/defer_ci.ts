import { randomUUID } from "node:crypto";
import { connect } from "@vercel/connect/eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { store } from "../lib/database.js";
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
    const auth = ctx.session.auth.current;
    if (auth?.authenticator !== "github-webhook") {
      throw new Error("CI deferral currently requires a GitHub PR conversation; Slack deferral is not yet supported");
    }
    const attributes = auth.attributes;
    const nativeConversation = auth.principalType === "user" &&
      attributes.conversation_kind === "pull_request" &&
      typeof attributes.repository === "string" &&
      attributes.repository.toLowerCase() === `${input.owner}/${input.repo}`.toLowerCase() &&
      Number(attributes.pull_request_number) === input.pullRequestNumber;
    const legacyWebhook = auth.principalType === "service" &&
      auth.principalId === "github-webhook" &&
      typeof attributes.owner === "string" &&
      typeof attributes.repo === "string" &&
      attributes.owner.toLowerCase() === input.owner.toLowerCase() &&
      attributes.repo.toLowerCase() === input.repo.toLowerCase() &&
      Number(attributes.number) === input.pullRequestNumber &&
      typeof attributes.headSha === "string" &&
      attributes.headSha.toLowerCase() === input.headSha.toLowerCase();
    if (!nativeConversation && !legacyWebhook) {
      throw new Error("CI deferral target must match the authenticated pull request conversation");
    }
    const { token } = await ctx.getToken(githubAuth);
    if (!legacyWebhook) {
      await requireRepositoryPermission(ctx, token, input.owner, input.repo, "read");
    }
    const response = await fetch(
      `${env.githubApiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "eve-engineering-agent" } },
    );
    if (!response.ok) throw new Error(`Could not resolve repository: ${response.status}`);
    const repository = await response.json() as { id: number };
    const repositoryId = String(repository.id);
    const headSha = input.headSha.toLowerCase();
    const pullResponse = await fetch(
      `${env.githubApiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullRequestNumber}`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "eve-engineering-agent" } },
    );
    if (!pullResponse.ok) throw new Error(`Could not resolve pull request: ${pullResponse.status}`);
    const pull = await pullResponse.json() as { head: { sha: string }; state: string };
    if (pull.state !== "open" || pull.head.sha.toLowerCase() !== headSha) {
      throw new Error("CI deferral head must match the current open pull request head");
    }
    const conversationId = randomUUID();
    const taskId = randomUUID();
    const key = `github:${repositoryId}#${input.pullRequestNumber}`;
    const installation = legacyWebhook ? attributes.installationId : attributes.installation_id;
    const durableTaskId = await store.deferCi({
      conversationId, taskId, conversationKey: key, repositoryId,
      repositoryOwner: input.owner, repositoryName: input.repo,
      ...(typeof installation === "string" && installation ? { githubInstallationId: installation } : {}),
      pullRequestNumber: input.pullRequestNumber, headSha,
    });
    return { taskId: durableTaskId, state: "waiting_for_ci", headSha };
  },
});
