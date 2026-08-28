import { defineSchedule } from "eve/schedules";
import { connectGitHubCredentials } from "@vercel/connect/eve";
import github from "../channels/github-connect.js";
import { store } from "../lib/database.js";
import { env } from "../lib/env.js";

class PermanentTargetError extends Error {}

interface DeferredCiTask {
  id: string;
  head_sha: string;
  repository_id: string;
  repository_owner: string;
  repository_name: string;
  github_installation_id: string | null;
  pull_request_number: number;
  lease_token: string;
}

type TargetCiTask = Omit<DeferredCiTask, "lease_token">;

type CompletedCiTask = TargetCiTask & {
  ci_conclusion: "success" | "failure" | null;
};

type CleanupCiTask = TargetCiTask & {
  result_state: "reopened" | "superseded" | "cancelled";
};

const release = async (taskId: string, leaseToken: string) => {
  await store.settleLease(taskId, leaseToken, "waiting_for_ci");
};

const supersede = async (taskId: string, leaseToken: string) => {
  await store.settleLease(taskId, leaseToken, "superseded");
};

const cancel = async (taskId: string, leaseToken: string) => {
  await store.settleLease(taskId, leaseToken, "cancelled");
};

const githubToken = async (task: TargetCiTask) => {
  const credentials = connectGitHubCredentials(env.githubConnector, {
    ...(task.github_installation_id ? { installationId: task.github_installation_id } : {}),
  });
  const source = credentials.installationToken;
  if (!source) throw new Error("GitHub installation token is unavailable");
  return typeof source === "function" ? await source() : source;
};

const resolveRepository = async (task: TargetCiTask) => {
  const token = await githubToken(task);
  const response = await fetch(`${env.githubApiUrl.replace(/\/+$/, "")}/repositories/${task.repository_id}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "eve-engineering-agent" },
  });
  const rateBody = response.status === 403 ? await response.clone().text() : "";
  const rateLimited = response.status === 429 || response.headers.get("retry-after") !== null ||
    response.headers.get("x-ratelimit-remaining") === "0";
  const secondaryLimited = response.status === 403 && /rate limit|abuse detection|temporarily blocked/i.test(rateBody);
  if ((response.status === 403 && !rateLimited && !secondaryLimited) || response.status === 404) {
    throw new PermanentTargetError(`Repository is permanently unavailable: ${response.status}`);
  }
  if (!response.ok) throw new Error(`Could not resolve repository identity: ${response.status}`);
  const repository = await response.json() as { id: number; name: string; owner: { login: string } };
  if (String(repository.id) !== task.repository_id) throw new Error("Repository identity mismatch");
  return { owner: repository.owner.login, repo: repository.name };
};

const cleanupStaleResult = async (
  task: TargetCiTask,
  repository: { owner: string; repo: string },
  reason = "CI result superseded by a newer pull-request head.",
) => {
  const token = await githubToken(task);
  const marker = `<!-- eve-ci-result:${task.id} -->`;
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `${env.githubApiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/issues/${task.pull_request_number}/comments?per_page=100&page=${page}`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "eve-engineering-agent" } },
    );
    if (!response.ok) throw new Error(`Could not find stale CI result: ${response.status}`);
    const comments = await response.json() as Array<{
      id: number; body?: string; user?: { login?: string; type?: string };
    }>;
    const existing = comments.find((comment) => {
      const login = comment.user?.login?.toLowerCase();
      const owned = !!login && (
        (!!env.githubBotLogin && login === env.githubBotLogin) ||
        (comment.user?.type === "Bot" &&
          (login === env.agentBotName.toLowerCase() ||
            login === `${env.agentBotName.toLowerCase()}[bot]`))
      );
      return owned && comment.body?.includes(marker);
    });
    if (existing) {
      const update = await fetch(
        `${env.githubApiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/issues/comments/${existing.id}`,
        {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "eve-engineering-agent" },
          body: JSON.stringify({ body: `${reason}\n\n${marker}` }),
        },
      );
      if (!update.ok) throw new Error(`Could not supersede stale CI result: ${update.status}`);
      return;
    }
    if (comments.length < 100) return;
  }
};

const currentPullRequestHead = async (
  task: TargetCiTask,
  repository: { owner: string; repo: string },
) => {
  const token = await githubToken(task);
  const response = await fetch(
    `${env.githubApiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls/${task.pull_request_number}`,
    { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "eve-engineering-agent" } },
  );
  if (response.status === 404) throw new PermanentTargetError("Pull request is permanently unavailable: 404");
  if (!response.ok) throw new Error(`Could not revalidate PR head: ${response.status}`);
  const pull = await response.json() as {
    head: { sha: string };
    merged: boolean;
    state: string;
  };
  return { headSha: pull.head.sha.toLowerCase(), open: pull.state === "open" && !pull.merged };
};

const currentCiIsTerminal = async (
  task: CompletedCiTask,
  repository: { owner: string; repo: string },
) => {
  const token = await githubToken(task);
  const root = `${env.githubApiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/commits/${task.head_sha}`;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "eve-engineering-agent" };
  const checks: Array<{ status: string; conclusion: string | null }> = [];
  const statuses: Array<{ state: string }> = [];
  let checkTotal = 0;
  let statusTotal = 0;
  for (let page = 1; page <= 30; page += 1) {
    const response = await fetch(`${root}/check-runs?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`Could not revalidate completed Check Runs: ${response.status}`);
    const body = await response.json() as { total_count: number; check_runs: typeof checks };
    checkTotal = body.total_count;
    checks.push(...body.check_runs);
    if (checks.length >= checkTotal || body.check_runs.length < 100) break;
  }
  for (let page = 1; page <= 30; page += 1) {
    const response = await fetch(`${root}/status?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`Could not revalidate completed commit statuses: ${response.status}`);
    const body = await response.json() as { total_count: number; statuses: typeof statuses };
    statusTotal = body.total_count;
    statuses.push(...body.statuses);
    if (statuses.length >= statusTotal || body.statuses.length < 100) break;
  }
  if (checks.length < checkTotal || statuses.length < statusTotal) {
    throw new Error("Completed CI revalidation exceeded its 3000-context bound");
  }
  const terminal = checkTotal + statusTotal > 0 &&
    checks.every((check) => check.status === "completed" && check.conclusion !== null) &&
    statuses.every((status) => status.state !== "pending");
  const failed = checks.some((check) => check.conclusion !== null &&
    !["success", "neutral", "skipped"].includes(check.conclusion)) ||
    statuses.some((status) => status.state !== "pending" && status.state !== "success");
  return { terminal, conclusion: failed ? "failure" as const : "success" as const };
};

const drainSession = async (stream: ReadableStream<unknown>): Promise<void> => {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
};

export default defineSchedule({
  cron: "*/5 * * * *",
  run({ receive, waitUntil, appAuth }) {
    waitUntil(
      (async () => {
        const pendingCleanup = await store.claimRerunCleanup<CleanupCiTask[]>(25);
        await Promise.allSettled(pendingCleanup.map(async (task) => {
          const repository = await resolveRepository(task);
          await cleanupStaleResult(
            task, repository,
            task.result_state === "cancelled"
              ? "CI result finalized because the pull request is no longer open."
              : task.result_state === "superseded"
                ? "CI result superseded because the pull request or active task changed."
                : "CI was rerun for this commit; the result is pending revalidation.",
          );
          await store.acknowledgeRerunCleanup(task.id, task.result_state);
        }));

        const completed = await store.claimCompletedForRevalidation<CompletedCiTask[]>(25);
        await Promise.allSettled(completed.map(async (task) => {
          const repository = await resolveRepository(task);
          const pull = await currentPullRequestHead(task, repository);
          const disposition = !pull.open
            ? "cancelled" as const
            : pull.headSha !== task.head_sha.toLowerCase()
              ? "superseded" as const
              : "valid" as const;
          const ci = disposition === "valid"
            ? await currentCiIsTerminal(task, repository)
            : null;
          if (ci?.terminal && task.ci_conclusion === ci.conclusion) return;
          await store.holdRerun(task.repository_id, task.head_sha);
          const cleanup = await store.resolveRerunPull<Array<{
            id: string; pull_request_number: number;
            result_state: "reopened" | "superseded" | "cancelled";
          }>>(task.repository_id, task.pull_request_number, task.head_sha, disposition);
          for (const item of cleanup) {
            await cleanupStaleResult(
              {
                ...task,
                id: item.id,
                pull_request_number: item.pull_request_number,
              },
              repository,
              item.result_state === "cancelled"
                ? "CI result finalized because the pull request is no longer open."
                : item.result_state === "superseded"
                  ? "CI result superseded because the pull request head changed."
                  : "CI returned to a pending state and is awaiting revalidation.",
            );
            await store.acknowledgeRerunCleanup(item.id, item.result_state);
          }
        }));

        const tasks = await store.claimDeferred<DeferredCiTask[]>(25, Date.now() - 15 * 60_000);

        await Promise.allSettled(
          tasks.map(async (task) => {
            try {
              const repository = await resolveRepository(task);
              const pull = await currentPullRequestHead(task, repository);
              if (!pull.open) {
                await cleanupStaleResult(
                  task, repository,
                  "CI result cancelled because the pull request is no longer open.",
                );
                await cancel(task.id, task.lease_token);
                return;
              }
              if (pull.headSha !== task.head_sha.toLowerCase()) {
                await cleanupStaleResult(task, repository);
                await supersede(task.id, task.lease_token);
                return;
              }
              await cleanupStaleResult(
                task, repository,
                "CI result publication was interrupted and will be revalidated.",
              );
              const session = await receive(github, {
                message: [
                  `Re-evaluate deferred CI task ${task.id} for exact head ${task.head_sha}.`,
                  "This task is already durable: do not call defer_ci again.",
                  "Read both Check Runs and legacy commit statuses with github_repository.",
                  "If any required context is pending, report that it remains deferred. Otherwise report the terminal CI outcome and continue the requested work.",
                  `End with CI_TASK_ID: ${task.id}, CI_LEASE_ID: ${task.lease_token}, and then exactly CI_TASK_STATE: pending or CI_TASK_STATE: terminal on separate lines.`,
                ].join("\n"),
                target: {
                  owner: repository.owner,
                  repo: repository.repo,
                  pullRequestNumber: task.pull_request_number,
                  repositoryId: Number(task.repository_id),
                  ...(task.github_installation_id
                    ? { installationId: Number(task.github_installation_id) }
                    : {}),
                },
                auth: {
                  ...appAuth,
                  attributes: {
                    ...appAuth.attributes,
                    ci_task_id: task.id,
                    ci_lease_id: task.lease_token,
                    repository: `${repository.owner}/${repository.repo}`,
                  },
                },
              });
              await drainSession(await session.getEventStream());
              await release(task.id, task.lease_token);
            } catch (error) {
              if (error instanceof PermanentTargetError) {
                await cancel(task.id, task.lease_token).catch(() => undefined);
              } else {
                await release(task.id, task.lease_token).catch(() => undefined);
              }
              throw error;
            }
          }),
        ).then(async (results) => {
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length) throw new AggregateError(failures.map((result) => result.reason));
        });
      })(),
    );
  },
});
