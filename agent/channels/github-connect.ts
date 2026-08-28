import { connectGitHubCredentials } from "@vercel/connect/eve";
import { defaultGitHubAuth, githubChannel } from "eve/channels/github";
import { store } from "../lib/database.js";
import { env } from "../lib/env.js";
import { z } from "zod";

const credentials = connectGitHubCredentials(env.githubConnector);

const isAgentBot = (user: { login?: string; type?: string } | undefined) => {
  if (!user?.login) return false;
  const login = user.login.toLowerCase();
  if (env.githubBotLogin && login === env.githubBotLogin) return true;
  return user.type === "Bot" && (login === env.agentBotName.toLowerCase() ||
    login === `${env.agentBotName.toLowerCase()}[bot]`);
};
const sanitizeReservedMarkers = (message: string) => message.replace(
  /<!--\s*eve-(?:ci-result|reply|change-operation):[^>]*-->/gi,
  "",
);

const transitionCiTask = async (
  repositoryId: string,
  pullRequestNumber: number,
  headSha: string,
  from: "reviewing" | "publishing",
  state: "completed" | "publishing" | "superseded" | "waiting_for_ci",
  taskId: string,
  leaseToken: string,
) => {
  return store.transitionTask({
    repositoryId, pullRequestNumber, headSha, from, to: state, taskId, leaseToken,
  });
};

const completedCiTask = async (
  repositoryId: string,
  pullRequestNumber: number,
  headSha: string,
  taskId: string,
  leaseToken: string,
) => {
  return store.taskMatches({
    repositoryId, pullRequestNumber, headSha, state: "completed", taskId, leaseToken,
  });
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
  if (!await store.taskMatches({
    repositoryId: String(channel.state.repositoryId),
    pullRequestNumber: channel.state.pullRequestNumber,
    headSha: channel.state.headSha, state: "publishing", taskId, leaseToken,
  })) return false;
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

const hostCiStatus = async (
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
  const terminal = checkTotal + statusTotal > 0 &&
    checks.every((check) => check.status === "completed" && check.conclusion !== null) &&
    statuses.every((status) => status.state !== "pending");
  const failed = checks.some((check) =>
    check.conclusion !== null && !["success", "neutral", "skipped"].includes(check.conclusion)
  ) || statuses.some((status) => status.state !== "pending" && status.state !== "success");
  return { terminal, conclusion: failed ? "failure" as const : "success" as const };
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
    async "turn.failed"(_data, channel, ctx) {
      const claim = trustedCiClaim(ctx);
      if (!claim || !channel.state.pullRequestNumber || !channel.state.headSha) return;
      const repositoryId = String(channel.state.repositoryId);
      const releasedReview = await transitionCiTask(
        repositoryId, channel.state.pullRequestNumber, channel.state.headSha,
        "reviewing", "waiting_for_ci", claim.taskId, claim.leaseToken,
      );
      if (!releasedReview) {
        await transitionCiTask(
          repositoryId, channel.state.pullRequestNumber, channel.state.headSha,
          "publishing", "waiting_for_ci", claim.taskId, claim.leaseToken,
        );
      }
    },
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason === "tool-calls") return;
      const outcome = data.message ? parseCiOutcome(data.message) : null;
      const claim = trustedCiClaim(ctx);
      if (!claim) {
        if (!data.message) return;
        const safeMessage = sanitizeReservedMarkers(data.message);
        const marker = `<!-- eve-reply:${ctx.session.id}:${ctx.session.turn.id} -->`;
        const truncated = safeMessage.length + marker.length + 2 > 60_000;
        const suffix = `${truncated ? "\n\n_Output truncated to fit one GitHub comment._" : ""}\n\n${marker}`;
        const body = `${safeMessage.slice(0, 60_000 - suffix.length)}${suffix}`;
        if (channel.thread.kind === "review_thread") {
          let existingCommentId: number | undefined;
          if (channel.state.pullRequestNumber) {
            for (let page = 1; !existingCommentId && page <= 30; page += 1) {
              const comments = await channel.github.request<Array<{
                id: number; body?: string; user?: { login?: string; type?: string };
              }>>({
                method: "GET",
                path: `/repos/${encodeURIComponent(channel.repository.owner)}/${encodeURIComponent(channel.repository.name)}/pulls/${channel.state.pullRequestNumber}/comments?per_page=100&page=${page}`,
              });
              existingCommentId = comments.body.find(
                (comment) => isAgentBot(comment.user) && comment.body?.includes(marker),
              )?.id;
              if (comments.body.length < 100) break;
            }
          }
          if (existingCommentId) {
            await channel.github.request({
              method: "PATCH",
              path: `/repos/${encodeURIComponent(channel.repository.owner)}/${encodeURIComponent(channel.repository.name)}/pulls/comments/${existingCommentId}`,
              body: { body },
            });
          } else {
            await channel.thread.post(body);
          }
          return;
        }
        let existingCommentId: number | undefined;
        for (let page = 1; !existingCommentId && page <= 30; page += 1) {
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
      let initialCi: Awaited<ReturnType<typeof hostCiStatus>>;
      try {
        initialCi = await hostCiStatus(channel, channel.state.headSha);
      } catch (error) {
        await transitionCiTask(
          String(channel.state.repositoryId), channel.state.pullRequestNumber,
          channel.state.headSha, "reviewing", "waiting_for_ci",
          claim.taskId, claim.leaseToken,
        ).catch(() => undefined);
        throw error;
      }
      if (outcome.state !== "terminal" || !initialCi.terminal) {
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
      const marker = `<!-- eve-ci-result:${claim.taskId} -->`;
      const compensatePublishedComment = async (reason: string) => {
        for (let page = 1; ; page += 1) {
          const comments = await channel.github.request<Array<{
            id: number; body?: string; user?: { login?: string; type?: string };
          }>>({
            method: "GET",
            path: `/repos/${encodeURIComponent(channel.repository.owner)}/${encodeURIComponent(channel.repository.name)}/issues/${channel.state.pullRequestNumber}/comments?per_page=100&page=${page}`,
          });
          const published = comments.body.find(
            (comment) => isAgentBot(comment.user) && comment.body?.includes(marker),
          );
          if (published) {
            await channel.github.request({
              method: "PATCH",
              path: `/repos/${encodeURIComponent(channel.repository.owner)}/${encodeURIComponent(channel.repository.name)}/issues/comments/${published.id}`,
              body: { body: `${reason}\n\n${marker}` },
            });
            return;
          }
          if (comments.body.length < 100) return;
        }
      };
      try {
        if (!await canPublishCiTask(channel, claim.taskId, claim.leaseToken)) {
          await transitionCiTask(
            String(channel.state.repositoryId), channel.state.pullRequestNumber,
            channel.state.headSha, "publishing", "waiting_for_ci",
            claim.taskId, claim.leaseToken,
          );
          return;
        }
        const publicationCi = await hostCiStatus(channel, channel.state.headSha);
        if (!publicationCi.terminal) {
          await transitionCiTask(
            String(channel.state.repositoryId), channel.state.pullRequestNumber,
            channel.state.headSha, "publishing", "waiting_for_ci",
            claim.taskId, claim.leaseToken,
          );
          return;
        }
        const continuation = sanitizeReservedMarkers(data.message.replace(
          /(?:^|\n)CI_TASK_ID:\s*\S+\s*\nCI_LEASE_ID:\s*\S+\s*\nCI_TASK_STATE:\s*(?:pending|terminal)\s*$/i,
          "",
        )).trim();
        const prefix = `Host-verified CI outcome: ${publicationCi.conclusion.toUpperCase()}.`;
        const continuationLabel = continuation
          ? "\n\nContinuation output (the host verdict above is authoritative):\n\n"
          : "";
        const suffix = `\n\n${marker}`;
        const available = 60_000 - prefix.length - continuationLabel.length - suffix.length;
        const body = `${prefix}${continuationLabel}${continuation.slice(0, Math.max(0, available))}${suffix}`;
        const immediateCi = await hostCiStatus(channel, channel.state.headSha);
        if (
          !await canPublishCiTask(channel, claim.taskId, claim.leaseToken) ||
          !immediateCi.terminal || immediateCi.conclusion !== publicationCi.conclusion
        ) {
          await transitionCiTask(
            String(channel.state.repositoryId), channel.state.pullRequestNumber,
            channel.state.headSha, "publishing", "waiting_for_ci",
            claim.taskId, claim.leaseToken,
          );
          return;
        }
        const postClaim = await store.claimResultPost<{
          claimed: boolean; comment_id: number | null;
        }>(claim.taskId, claim.leaseToken);
        if (!postClaim.claimed) return;
        let existingCommentId: number | undefined = postClaim.comment_id ?? undefined;
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
        if (existingCommentId) {
          try {
            await channel.github.request({
              method: "PATCH",
              path: `/repos/${encodeURIComponent(channel.repository.owner)}/${encodeURIComponent(channel.repository.name)}/issues/comments/${existingCommentId}`,
              body: { body },
            });
            await store.recordResultComment(claim.taskId, claim.leaseToken, existingCommentId, body);
          } catch (error) {
            if ((error as { status?: number }).status !== 404 ||
              !await store.replaceMissingResultComment(
                claim.taskId, claim.leaseToken, existingCommentId,
              )) throw error;
            const posted = await channel.thread.post(body);
            await store.recordResultComment(claim.taskId, claim.leaseToken, posted.id, body);
          }
        } else {
          const posted = await channel.thread.post(body);
          await store.recordResultComment(claim.taskId, claim.leaseToken, posted.id, body);
        }
        const stillCurrent = await canPublishCiTask(channel, claim.taskId, claim.leaseToken);
        const finalCi = await hostCiStatus(channel, channel.state.headSha);
        const stillTerminal = finalCi.terminal && finalCi.conclusion === publicationCi.conclusion;
        const completed = stillCurrent && stillTerminal && await store.completeCiTask({
          repositoryId: String(channel.state.repositoryId),
          pullRequestNumber: channel.state.pullRequestNumber,
          headSha: channel.state.headSha,
          taskId: claim.taskId,
          leaseToken: claim.leaseToken,
          conclusion: finalCi.conclusion,
        });
        if (!completed) {
          await compensatePublishedComment(
            `${stillCurrent && !stillTerminal ? "CI returned to a pending state" : "CI result superseded"} before publication completed.`,
          );
          await transitionCiTask(
            String(channel.state.repositoryId), channel.state.pullRequestNumber,
            channel.state.headSha, "publishing", stillCurrent ? "waiting_for_ci" : "superseded",
            claim.taskId, claim.leaseToken,
          );
        }
      } catch (error) {
        if (await completedCiTask(
          String(channel.state.repositoryId), channel.state.pullRequestNumber,
          channel.state.headSha, claim.taskId, claim.leaseToken,
        )) return;
        await compensatePublishedComment(
          "CI result could not be revalidated after publication; it will be retried.",
        ).catch(() => undefined);
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
    if (!comment.author || isAgentBot(comment.author)) return null;
    return {
      auth: defaultGitHubAuth(ctx),
      context: [
        "This is a steerable GitHub conversation. Follow the user's request; do not emit the automated-review JSON contract unless they explicitly request a PR review.",
      ],
    };
  },
  onCheckSuite: async (ctx, suite) => {
    if ((suite.action === "requested" || suite.action === "rerequested") && suite.headSha) {
      const repositoryId = String(ctx.repository.id);
      const headSha = suite.headSha.toLowerCase();
      const pullRequestNumbers = await store.holdRerun<number[]>(repositoryId, headSha);
      const completed: Array<{
        id: string; pull_request_number: number;
        result_state: "reopened" | "superseded" | "cancelled";
      }> = [];
      for (const pullRequestNumber of pullRequestNumbers) {
        const pull = await ctx.github.request<{
          head: { sha: string }; merged: boolean; state: string;
        }>({
          method: "GET",
          path: `/repos/${encodeURIComponent(ctx.repository.owner)}/${encodeURIComponent(ctx.repository.name)}/pulls/${pullRequestNumber}`,
        });
        const disposition = pull.body.state !== "open" || pull.body.merged
          ? "cancelled" as const
          : pull.body.head.sha.toLowerCase() !== headSha
            ? "superseded" as const
            : "valid" as const;
        completed.push(...await store.resolveRerunPull<typeof completed>(
          repositoryId, pullRequestNumber, headSha, disposition,
        ));
      }
      for (let cleanupIndex = 0; cleanupIndex < completed.length; cleanupIndex += 1) {
        const task = completed[cleanupIndex]!;
        const marker = `<!-- eve-ci-result:${task.id} -->`;
        let commentId: number | undefined;
        for (let page = 1; !commentId; page += 1) {
          const comments = await ctx.github.request<Array<{
            id: number; body?: string; user?: { login?: string; type?: string };
          }>>({
            method: "GET",
            path: `/repos/${encodeURIComponent(ctx.repository.owner)}/${encodeURIComponent(ctx.repository.name)}/issues/${task.pull_request_number}/comments?per_page=100&page=${page}`,
          });
          commentId = comments.body.find(
            (comment) => isAgentBot(comment.user) && comment.body?.includes(marker),
          )?.id;
          if (comments.body.length < 100) break;
        }
        if (commentId) {
          await ctx.github.request({
            method: "PATCH",
            path: `/repos/${encodeURIComponent(ctx.repository.owner)}/${encodeURIComponent(ctx.repository.name)}/issues/comments/${commentId}`,
            body: { body: `${task.result_state === "cancelled"
              ? "CI result finalized because the pull request is no longer open."
              : task.result_state === "superseded"
                ? "CI result superseded because the pull request or active task changed."
                : "CI was rerun for this commit; the result is pending revalidation."}\n\n${marker}` },
          });
        }
        const acknowledged = await store.acknowledgeRerunCleanup(
          task.id, task.result_state,
        );
        if (!acknowledged) {
          const pull = await ctx.github.request<{
            head: { sha: string }; merged: boolean; state: string;
          }>({
            method: "GET",
            path: `/repos/${encodeURIComponent(ctx.repository.owner)}/${encodeURIComponent(ctx.repository.name)}/pulls/${task.pull_request_number}`,
          });
          const disposition = pull.body.state !== "open" || pull.body.merged
            ? "cancelled" as const
            : pull.body.head.sha.toLowerCase() !== headSha
              ? "superseded" as const
              : "valid" as const;
          completed.push(...await store.resolveRerunPull<typeof completed>(
            repositoryId, task.pull_request_number, headSha, disposition,
          ));
        }
      }
      return null;
    }
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
        await store.cancelPullTasks(String(ctx.repository.id), number);
      } else if (response.body.head.sha.toLowerCase() === suite.headSha.toLowerCase()) {
        currentPullRequests.push(number);
      }
    }
    if (currentPullRequests.length === 0) return null;
    const claimed = await store.claimWaiting<{ id: string; lease_token: string } | null>(
      String(ctx.repository.id), suite.headSha.toLowerCase(), currentPullRequests,
    );
    if (!claimed) return null;
    const auth = defaultGitHubAuth(ctx);
    return {
      auth: {
        ...auth,
        attributes: {
          ...auth.attributes,
          ci_task_id: claimed.id,
          ci_lease_id: claimed.lease_token,
          repository: ctx.repository.fullName,
        },
      },
      context: [
        `CI check suite ${suite.checkSuiteId} reached a terminal state for ${suite.headSha}.`,
        `The claimed durable CI task is ${claimed.id}.`,
        `Its lease is ${claimed.lease_token}.`,
        `Conclusion: ${suite.conclusion ?? "unknown"}. Re-evaluate any deferred work for this exact head and report the CI outcome.`,
        `Read all Check Runs and legacy commit statuses. End with CI_TASK_ID: ${claimed.id}, CI_LEASE_ID: ${claimed.lease_token}, and then exactly CI_TASK_STATE: pending or CI_TASK_STATE: terminal on separate lines.`,
      ],
    };
  },
  onPullRequest: async (ctx, pullRequest) => {
    if (!pullRequest.headSha || pullRequest.action !== "synchronize") return null;
    const completed = await store.supersedeOldHeads<Array<{ id: string; head_sha: string }>>(
      String(ctx.repository.id), pullRequest.pullRequestNumber, pullRequest.headSha.toLowerCase(),
    );
    for (const task of completed) {
      const marker = `<!-- eve-ci-result:${task.id} -->`;
      let commentId: number | undefined;
      for (let page = 1; !commentId; page += 1) {
        const comments = await ctx.github.request<Array<{
          id: number; body?: string; user?: { login?: string; type?: string };
        }>>({
          method: "GET",
          path: `/repos/${encodeURIComponent(ctx.repository.owner)}/${encodeURIComponent(ctx.repository.name)}/issues/${pullRequest.pullRequestNumber}/comments?per_page=100&page=${page}`,
        });
        commentId = comments.body.find(
          (comment) => isAgentBot(comment.user) && comment.body?.includes(marker),
        )?.id;
        if (comments.body.length < 100) break;
      }
      if (commentId) {
        await ctx.github.request({
          method: "PATCH",
          path: `/repos/${encodeURIComponent(ctx.repository.owner)}/${encodeURIComponent(ctx.repository.name)}/issues/comments/${commentId}`,
          body: { body: `Historical CI result for superseded head ${task.head_sha}.\n\n${marker}` },
        });
      }
      await store.supersedeCompleted(task.id);
    }
    return null;
  },
});
