import { connectGitHubCredentials } from "@vercel/connect/eve";
import { defaultGitHubAuth, githubChannel } from "eve/channels/github";
import { database } from "../lib/database.js";
import { env } from "../lib/env.js";

const credentials = connectGitHubCredentials(env.githubConnector);

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
        `Conclusion: ${suite.conclusion ?? "unknown"}. Re-evaluate any deferred work for this exact head and report the CI outcome.`,
      ],
    };
  },
});
