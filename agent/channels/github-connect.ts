import { connectGitHubCredentials } from "@vercel/connect/eve";
import { defaultGitHubAuth, githubChannel } from "eve/channels/github";
import { database } from "../lib/database.js";
import { env } from "../lib/env.js";

const credentials = connectGitHubCredentials(env.githubConnector);

const finishCiTask = async (
  repositoryId: string,
  pullRequestNumber: number,
  headSha: string,
  state: "completed" | "waiting_for_ci",
  taskId?: string,
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
      and (${taskId ?? null}::uuid is null or t.id = ${taskId ?? null}::uuid)
  `;
};

const ciTaskId = (message: string) =>
  /(?:^|\n)CI_TASK_ID:\s*([0-9a-f-]{36})\s*$/im.exec(message)?.[1];

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
      const match = data.message
        ? /(?:^|\n)CI_TASK_STATE:\s*(pending|terminal)\s*$/im.exec(data.message.trim())
        : null;
      if (channel.state.pullRequestNumber && channel.state.headSha) {
        await finishCiTask(
          String(channel.state.repositoryId),
          channel.state.pullRequestNumber,
          channel.state.headSha,
          match?.[1]?.toLowerCase() === "terminal" ? "completed" : "waiting_for_ci",
          data.message ? ciTaskId(data.message) : undefined,
        );
      }
      if (!data.message) return;
      for (let offset = 0; offset < data.message.length; offset += 60_000) {
        await channel.thread.post(data.message.slice(offset, offset + 60_000));
      }
    },
    async "turn.failed"(_data, channel) {
      if (channel.state.pullRequestNumber && channel.state.headSha) {
        await finishCiTask(
          String(channel.state.repositoryId),
          channel.state.pullRequestNumber,
          channel.state.headSha,
          "waiting_for_ci",
        );
      }
    },
    async "session.failed"(data, channel) {
      if (channel.state.pullRequestNumber && channel.state.headSha) {
        await finishCiTask(
          String(channel.state.repositoryId),
          channel.state.pullRequestNumber,
          channel.state.headSha,
          "waiting_for_ci",
        );
      }
      await channel.thread.post(`CI continuation failed and was deferred for retry. Error: ${data.code}`);
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
    const claimed = await database()<Array<{ id: string }>>`
      with candidate as (
        select t.id
        from tasks t
        join conversations c on c.id = t.conversation_id
        where t.repository_id = ${String(ctx.repository.id)}
          and t.head_sha = ${suite.headSha}
          and t.state = 'waiting_for_ci'
          and c.pull_request_number = any(${suite.pullRequests})
        order by t.created_at
        for update of t skip locked
        limit 1
      )
      update tasks t
      set state = 'reviewing', updated_at = now()
      from candidate
      where t.id = candidate.id and t.state = 'waiting_for_ci'
      returning t.id
    `;
    if (claimed.length === 0) return null;
    return {
      auth: defaultGitHubAuth(ctx),
      context: [
        `CI check suite ${suite.checkSuiteId} reached a terminal state for ${suite.headSha}.`,
        `The claimed durable CI task is ${claimed[0]!.id}.`,
        `Conclusion: ${suite.conclusion ?? "unknown"}. Re-evaluate any deferred work for this exact head and report the CI outcome.`,
        `Read all Check Runs and legacy commit statuses. End with CI_TASK_ID: ${claimed[0]!.id} and then exactly CI_TASK_STATE: pending or CI_TASK_STATE: terminal on separate lines.`,
      ],
    };
  },
});
