import { connectGitHubCredentials } from "@vercel/connect/eve";
import { defaultGitHubAuth, githubChannel } from "eve/channels/github";
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
  onComment: async (ctx, comment) => {
    if (!comment.author || comment.author.type === "Bot") return null;
    const repository = await ctx.github.request<{ owner: { id: number } }>({
      method: "GET",
      path: `/repos/${ctx.repository.owner}/${ctx.repository.name}`,
    });
    const auth = defaultGitHubAuth(ctx);
    return {
      auth: {
        ...auth,
        attributes: {
          ...auth.attributes,
          organization_id: String(repository.body.owner.id),
        },
      },
      context: [
        "This is a steerable GitHub conversation. Follow the user's request; do not emit the automated-review JSON contract unless they explicitly request a PR review.",
      ],
    };
  },
  onCheckSuite: (ctx, suite) => {
    if (
      suite.action !== "completed" ||
      !suite.headSha ||
      suite.pullRequests.length === 0
    ) {
      return null;
    }
    return {
      auth: defaultGitHubAuth(ctx),
      context: [
        `CI check suite ${suite.checkSuiteId} reached a terminal state for ${suite.headSha}.`,
        `Conclusion: ${suite.conclusion ?? "unknown"}. Re-evaluate any deferred work for this exact head and report the CI outcome.`,
      ],
    };
  },
});
