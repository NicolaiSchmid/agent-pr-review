import { connectGitHubCredentials } from "@vercel/connect/eve";
import { defaultGitHubAuth, githubChannel } from "eve/channels/github";
import { database } from "../lib/database.js";
import { env } from "../lib/env.js";
import { z } from "zod";

const credentials = connectGitHubCredentials(env.githubConnector);

const finishCiTask = async (
  repositoryId: string,
  pullRequestNumber: number,
  headSha: string,
  state: "completed" | "waiting_for_ci",
  taskId: string,
  leaseToken: string,
) => {
  await database()`
    update tasks t
    set state = ${state}, updated_at = now()
    from conversations c
    where t.conversation_id = c.id
      and t.repository_id = ${repositoryId}
      and t.head_sha = ${headSha}
      and t.state = 'reviewing'
      and t.kind = 'pr_review'
      and c.pull_request_number = ${pullRequestNumber}
      and t.id = ${taskId}::uuid
      and t.lease_token = ${leaseToken}::uuid
  `;
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
    async "message.completed"(data, channel) {
      if (data.finishReason === "tool-calls") return;
      const outcome = data.message ? parseCiOutcome(data.message) : null;
      if (outcome && channel.state.pullRequestNumber && channel.state.headSha) {
        await finishCiTask(
          String(channel.state.repositoryId),
          channel.state.pullRequestNumber,
          channel.state.headSha,
          outcome.state === "terminal" ? "completed" : "waiting_for_ci",
          outcome.taskId,
          outcome.leaseToken,
        );
      }
      if (!data.message) return;
      for (let offset = 0; offset < data.message.length; offset += 60_000) {
        await channel.thread.post(data.message.slice(offset, offset + 60_000));
      }
    },
    async "session.failed"(data, channel) {
      await channel.thread.post(`This session failed and can be retried. Error: ${data.code}`);
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
      const response = await ctx.github.request<{ head: { sha: string } }>({
        method: "GET",
        path: `/repos/${encodeURIComponent(ctx.repository.owner)}/${encodeURIComponent(ctx.repository.name)}/pulls/${number}`,
      });
      if (response.body.head.sha.toLowerCase() === suite.headSha.toLowerCase()) {
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
    return {
      auth: defaultGitHubAuth(ctx),
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
        and t.state in ('queued', 'waiting_for_ci', 'reviewing', 'waiting_for_user', 'publishing')
    `;
    return null;
  },
});
