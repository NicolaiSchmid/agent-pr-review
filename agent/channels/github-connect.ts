import { connectGitHubCredentials } from "@vercel/connect/eve";
import { defaultGitHubAuth, githubChannel } from "eve/channels/github";
import { database } from "../lib/database.js";
import { env } from "../lib/env.js";
import { z } from "zod";

const credentials = connectGitHubCredentials(env.githubConnector);

const isAgentBot = (user: { login?: string; type?: string } | undefined) => {
  if (user?.type !== "Bot" || !user.login) return false;
  const login = user.login.toLowerCase();
  return login === env.githubBotLogin || login === env.agentBotName.toLowerCase() ||
    login === `${env.agentBotName.toLowerCase()}[bot]`;
};

const transitionCiTask = async (
  repositoryId: string,
  pullRequestNumber: number,
  headSha: string,
  from: "reviewing" | "publishing",
  state: "completed" | "publishing" | "superseded" | "waiting_for_ci",
  taskId: string,
  leaseToken: string,
) => {
  const rows = await database()<Array<{ id: string }>>`
    update tasks t
    set state = ${state}, updated_at = now()
    from conversations c
    where t.conversation_id = c.id
      and t.repository_id = ${repositoryId}
      and t.head_sha = ${headSha}
      and t.state = ${from}
      and t.kind = 'pr_review'
      and c.pull_request_number = ${pullRequestNumber}
      and t.id = ${taskId}::uuid
      and t.lease_token = ${leaseToken}::uuid
    returning t.id
  `;
  return rows.length === 1;
};

const trustedCiClaim = (ctx: { session: { auth: { initiator: { attributes: Readonly<Record<string, string | readonly string[]>> } | null } } }) => {
  const attributes = ctx.session.auth.initiator?.attributes;
  const taskId = attributes?.ci_task_id;
  const leaseToken = attributes?.ci_lease_id;
  if (
    typeof taskId !== "string" || typeof leaseToken !== "string" ||
    !z.string().uuid().safeParse(taskId).success ||
    !z.string().uuid().safeParse(leaseToken).success
  ) return null;
  return { taskId, leaseToken };
};

const canPublishCiTask = async (
  channel: {
    github: { request<T>(input: { method: "GET"; path: string }): Promise<{ body: T }> };
    repository: { owner: string; name: string };
    state: { headSha: string | null; pullRequestNumber: number | null; repositoryId: number };
  },
  taskId: string,
  leaseToken: string,
) => {
  if (!channel.state.pullRequestNumber || !channel.state.headSha) return false;
  const rows = await database()<Array<{ id: string }>>`
    select t.id from tasks t
    join conversations c on c.id = t.conversation_id
    where t.id = ${taskId}::uuid and t.lease_token = ${leaseToken}::uuid
      and t.state = 'publishing' and t.repository_id = ${String(channel.state.repositoryId)}
      and t.head_sha = ${channel.state.headSha}
      and c.pull_request_number = ${channel.state.pullRequestNumber}
  `;
  if (rows.length !== 1) return false;
  const pull = await channel.github.request<{
    head: { sha: string };
    merged: boolean;
    state: string;
  }>({
    method: "GET",
    path: `/repos/${encodeURIComponent(channel.repository.owner)}/${encodeURIComponent(channel.repository.name)}/pulls/${channel.state.pullRequestNumber}`,
  });
  return pull.body.state === "open" && !pull.body.merged &&
    pull.body.head.sha.toLowerCase() === channel.state.headSha.toLowerCase();
};

const hostCiTerminal = async (
  channel: {
    github: { request<T>(input: { method: "GET"; path: string }): Promise<{ body: T }> };
    repository: { owner: string; name: string };
  },
  headSha: string,
) => {
  const root = `/repos/${encodeURIComponent(channel.repository.owner)}/${encodeURIComponent(channel.repository.name)}`;
  const checks: Array<{ status: string; conclusion: string | null }> = [];
  let checkTotal = 0;
  for (let page = 1; page <= 30; page += 1) {
    const response = await channel.github.request<{
      total_count: number;
      check_runs: Array<{ status: string; conclusion: string | null }>;
    }>({ method: "GET", path: `${root}/commits/${headSha}/check-runs?per_page=100&page=${page}` });
    checkTotal = response.body.total_count;
    checks.push(...response.body.check_runs);
    if (checks.length >= checkTotal || response.body.check_runs.length < 100) break;
  }
  if (checks.length < checkTotal) throw new Error("Check Run verification exceeded pagination bound");
  const statuses: Array<{ state: string }> = [];
  let statusTotal = 0;
  for (let page = 1; page <= 30; page += 1) {
    const response = await channel.github.request<{
      total_count: number;
      statuses: Array<{ state: string }>;
    }>({ method: "GET", path: `${root}/commits/${headSha}/status?per_page=100&page=${page}` });
    statusTotal = response.body.total_count;
    statuses.push(...response.body.statuses);
    if (statuses.length >= statusTotal || response.body.statuses.length < 100) break;
  }
  if (statuses.length < statusTotal) throw new Error("Commit status verification exceeded pagination bound");
  return checkTotal + statusTotal > 0 &&
    checks.every((check) => check.status === "completed" && check.conclusion !== null) &&
    statuses.every((status) => status.state !== "pending");
};

const parseCiOutcome = (message: string) => {
  const ids = [...message.matchAll(/^CI_TASK_ID:\s*(\S+)\s*$/gim)];
  const leases = [...message.matchAll(/^CI_LEASE_ID:\s*(\S+)\s*$/gim)];
  const states = [...message.matchAll(/^CI_TASK_STATE:\s*(pending|terminal)\s*$/gim)];
  if (ids.length !== 1 || leases.length !== 1 || states.length !== 1) return null;
  const final = /(?:^|\n)CI_TASK_ID:\s*(\S+)\s*\nCI_LEASE_ID:\s*(\S+)\s*\nCI_TASK_STATE:\s*(pending|terminal)\s*$/i
    .exec(message.trim());
  if (
    !final ||
    !z.string().uuid().safeParse(final[1]).success ||
    !z.string().uuid().safeParse(final[2]).success
  ) return null;
  return {
    taskId: final[1]!,
    leaseToken: final[2]!,
    state: final[3]!.toLowerCase() as "pending" | "terminal",
  };
};

export default githubChannel({
  botName: env.agentBotName,
  credentials,
  pullRequestContext: {
    excludedFiles: [
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lock",
    ],
  },
  events: {
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason === "tool-calls") return;
      const outcome = data.message ? parseCiOutcome(data.message) : null;
      const claim = trustedCiClaim(ctx);
      if (!claim) {
        if (!data.message) return;
        const marker = `<!-- eve-reply:${ctx.session.id}:${ctx.session.turn.id} -->`;
        const truncated = data.message.length + marker.length + 2 > 60_000;
        const suffix = `${truncated ? "\n\n_Output truncated to fit one GitHub comment._" : ""}\n\n${marker}`;
        const body = `${data.message.slice(0, 60_000 - suffix.length)}${suffix}`;
        if (channel.thread.kind === "review_thread") {
          await channel.thread.post(body);
          return;
        }
        let existingCommentId: number | undefined;
        for (let page = 1; !existingCommentId; page += 1) {
          const comments = await channel.github.request<Array<{
            id: number; body?: string; user?: { login?: string; type?: string };
          }>>({
            method: "GET",
            path: `/repos/${encodeURIComponent(channel.repository.owner)}/${encodeURIComponent(channel.repository.name)}/issues/${channel.state.issueNumber}/comments?per_page=100&page=${page}`,
          });
          existingCommentId = comments.body.find(
            (comment) => isAgentBot(comment.user) && comment.body?.includes(marker),
          )?.id;
          if (comments.body.length < 100) break;
        }
        if (existingCommentId) {
          await channel.github.request({
            method: "PATCH",
            path: `/repos/${encodeURIComponent(channel.repository.owner)}/${encodeURIComponent(channel.repository.name)}/issues/comments/${existingCommentId}`,
            body: { body },
          });
        } else {
          await channel.thread.post(body);
        }
        return;
      }
      if (!channel.state.pullRequestNumber || !channel.state.headSha) return;
      if (
        !outcome || outcome.taskId !== claim.taskId ||
        outcome.leaseToken !== claim.leaseToken || !data.message
      ) {
        await transitionCiTask(
          String(channel.state.repositoryId),
          channel.state.pullRequestNumber,
          channel.state.headSha,
          "reviewing", "waiting_for_ci", claim.taskId, claim.leaseToken,
        );
        return;
      }
      if (outcome.state !== "terminal" || !await hostCiTerminal(channel, channel.state.headSha)) {
        await transitionCiTask(
          String(channel.state.repositoryId), channel.state.pullRequestNumber,
          channel.state.headSha, "reviewing", "waiting_for_ci",
          claim.taskId, claim.leaseToken,
        );
        return;
      }
      const claimed = await transitionCiTask(
        String(channel.state.repositoryId), channel.state.pullRequestNumber,
        channel.state.headSha, "reviewing", "publishing", claim.taskId, claim.leaseToken,
      );
      if (!claimed) return;
      try {
        if (
          !await canPublishCiTask(channel, claim.taskId, claim.leaseToken) ||
          !await hostCiTerminal(channel, channel.state.headSha)
        ) {
          await transitionCiTask(
            String(channel.state.repositoryId), channel.state.pullRequestNumber,
            channel.state.headSha, "publishing", "waiting_for_ci",
            claim.taskId, claim.leaseToken,
          );
          return;
        }
        const marker = `<!-- eve-ci-result:${claim.taskId} -->`;
        const truncated = data.message.length + marker.length + 2 > 60_000;
        const suffix = `${truncated ? "\n\n_Output truncated to fit one GitHub comment._" : ""}\n\n${marker}`;
        const body = `${data.message.slice(0, 60_000 - suffix.length)}${suffix}`;
        let existingCommentId: number | undefined;
        for (let page = 1; !existingCommentId; page += 1) {
          const comments = await channel.github.request<Array<{
            id: number; body?: string; user?: { login?: string; type?: string };
          }>>({
            method: "GET",
            path: `/repos/${encodeURIComponent(channel.repository.owner)}/${encodeURIComponent(channel.repository.name)}/issues/${channel.state.pullRequestNumber}/comments?per_page=100&page=${page}`,
          });
          existingCommentId = comments.body.find(
            (comment) => isAgentBot(comment.user) && comment.body?.includes(marker),
          )?.id;
          if (comments.body.length < 100) break;
        }
        if (
          !await canPublishCiTask(channel, claim.taskId, claim.leaseToken) ||
          !await hostCiTerminal(channel, channel.state.headSha)
        ) {
          await transitionCiTask(
            String(channel.state.repositoryId), channel.state.pullRequestNumber,
            channel.state.headSha, "publishing", "waiting_for_ci",
            claim.taskId, claim.leaseToken,
          );
          return;
        }
        let publishedCommentId: number;
        if (existingCommentId) {
          await channel.github.request({
            method: "PATCH",
            path: `/repos/${encodeURIComponent(channel.repository.owner)}/${encodeURIComponent(channel.repository.name)}/issues/comments/${existingCommentId}`,
            body: { body },
          });
          publishedCommentId = existingCommentId;
        } else {
          publishedCommentId = (await channel.thread.post(body)).id;
        }
        const stillCurrent = await canPublishCiTask(channel, claim.taskId, claim.leaseToken);
        const stillTerminal = await hostCiTerminal(channel, channel.state.headSha);
        const completed = stillCurrent && stillTerminal && await transitionCiTask(
          String(channel.state.repositoryId), channel.state.pullRequestNumber,
          channel.state.headSha, "publishing",
          "completed",
          claim.taskId, claim.leaseToken,
        );
        if (!completed) {
          await channel.github.request({
            method: "PATCH",
            path: `/repos/${encodeURIComponent(channel.repository.owner)}/${encodeURIComponent(channel.repository.name)}/issues/comments/${publishedCommentId}`,
            body: { body: `${stillCurrent && !stillTerminal ? "CI returned to a pending state" : "CI result superseded"} before publication completed.\n\n${marker}` },
          });
          await transitionCiTask(
            String(channel.state.repositoryId), channel.state.pullRequestNumber,
            channel.state.headSha, "publishing", stillCurrent ? "waiting_for_ci" : "superseded",
            claim.taskId, claim.leaseToken,
          );
        }
      } catch (error) {
        await transitionCiTask(
          String(channel.state.repositoryId), channel.state.pullRequestNumber,
          channel.state.headSha, "publishing", "waiting_for_ci",
          claim.taskId, claim.leaseToken,
        ).catch(() => undefined);
        throw error;
      }
    },
  },
  onComment: (ctx, comment) => {
    if (!comment.author || comment.author.type === "Bot") return null;
    return {
      auth: defaultGitHubAuth(ctx),
      context: [
        "This is a steerable GitHub conversation. Follow the user's request; do not emit the automated-review JSON contract unless they explicitly request a PR review.",
      ],
    };
  },
  onCheckSuite: async (ctx, suite) => {
    if (
      suite.action !== "completed" ||
      !suite.headSha ||
      suite.pullRequests.length === 0
    ) {
      return null;
    }
    const currentPullRequests: number[] = [];
    for (const number of suite.pullRequests) {
      const response = await ctx.github.request<{
        head: { sha: string };
        merged: boolean;
        state: string;
      }>({
        method: "GET",
        path: `/repos/${encodeURIComponent(ctx.repository.owner)}/${encodeURIComponent(ctx.repository.name)}/pulls/${number}`,
      });
      if (response.body.state !== "open" || response.body.merged) {
        await database()`
          update tasks t
          set state = 'cancelled', updated_at = now()
          from conversations c
          where t.conversation_id = c.id
            and t.repository_id = ${String(ctx.repository.id)}
            and c.pull_request_number = ${number}
            and t.kind = 'pr_review'
            and t.state in ('queued', 'waiting_for_ci', 'reviewing', 'waiting_for_user', 'publishing')
        `;
      } else if (response.body.head.sha.toLowerCase() === suite.headSha.toLowerCase()) {
        currentPullRequests.push(number);
      }
    }
    if (currentPullRequests.length === 0) return null;
    const claimed = await database()<Array<{ id: string; lease_token: string }>>`
      with candidate as (
        select t.id
        from tasks t
        join conversations c on c.id = t.conversation_id
        where t.repository_id = ${String(ctx.repository.id)}
          and t.head_sha = ${suite.headSha.toLowerCase()}
          and t.state = 'waiting_for_ci'
          and c.pull_request_number = any(${currentPullRequests})
        order by t.created_at
        for update of t skip locked
        limit 1
      )
      update tasks t
      set state = 'reviewing', lease_token = gen_random_uuid(), updated_at = now()
      from candidate
      where t.id = candidate.id and t.state = 'waiting_for_ci'
      returning t.id, t.lease_token
    `;
    if (claimed.length === 0) return null;
    const auth = defaultGitHubAuth(ctx);
    return {
      auth: {
        ...auth,
        attributes: {
          ...auth.attributes,
          ci_task_id: claimed[0]!.id,
          ci_lease_id: claimed[0]!.lease_token,
          repository: ctx.repository.fullName,
        },
      },
      context: [
        `CI check suite ${suite.checkSuiteId} reached a terminal state for ${suite.headSha}.`,
        `The claimed durable CI task is ${claimed[0]!.id}.`,
        `Its lease is ${claimed[0]!.lease_token}.`,
        `Conclusion: ${suite.conclusion ?? "unknown"}. Re-evaluate any deferred work for this exact head and report the CI outcome.`,
        `Read all Check Runs and legacy commit statuses. End with CI_TASK_ID: ${claimed[0]!.id}, CI_LEASE_ID: ${claimed[0]!.lease_token}, and then exactly CI_TASK_STATE: pending or CI_TASK_STATE: terminal on separate lines.`,
      ],
    };
  },
  onPullRequest: async (ctx, pullRequest) => {
    if (!pullRequest.headSha || pullRequest.action !== "synchronize") return null;
    await database()`
      update tasks t
      set state = 'superseded', updated_at = now()
      from conversations c
      where t.conversation_id = c.id
        and t.repository_id = ${String(ctx.repository.id)}
        and c.pull_request_number = ${pullRequest.pullRequestNumber}
        and t.kind = 'pr_review'
        and t.head_sha <> ${pullRequest.headSha.toLowerCase()}
        and t.state in ('queued', 'waiting_for_ci', 'reviewing', 'waiting_for_user')
    `;
    return null;
  },
});
