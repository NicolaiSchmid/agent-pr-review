import { defineSchedule } from "eve/schedules";
import { connectGitHubCredentials } from "@vercel/connect/eve";
import github from "../channels/github-connect.js";
import { database } from "../lib/database.js";
import { env } from "../lib/env.js";

const credentials = connectGitHubCredentials(env.githubConnector);

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

const release = async (taskId: string, leaseToken: string) => {
  await database()`
    update tasks
    set state = 'waiting_for_ci', updated_at = now()
    where id = ${taskId} and state = 'reviewing' and lease_token = ${leaseToken}::uuid
  `;
};

const supersede = async (taskId: string, leaseToken: string) => {
  await database()`
    update tasks set state = 'superseded', updated_at = now()
    where id = ${taskId} and state = 'reviewing' and lease_token = ${leaseToken}::uuid
  `;
};

const cancel = async (taskId: string, leaseToken: string) => {
  await database()`
    update tasks set state = 'cancelled', updated_at = now()
    where id = ${taskId} and state = 'reviewing' and lease_token = ${leaseToken}::uuid
  `;
};

const githubToken = async () => {
  const source = credentials.installationToken;
  if (!source) throw new Error("GitHub installation token is unavailable");
  return typeof source === "function" ? await source() : source;
};

const resolveRepository = async (task: DeferredCiTask) => {
  const token = await githubToken();
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
  task: DeferredCiTask,
  repository: { owner: string; repo: string },
  reason = "CI result superseded by a newer pull-request head.",
) => {
  const token = await githubToken();
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
      const owned = comment.user?.type === "Bot" && !!login &&
        (login === env.githubBotLogin || login === env.agentBotName.toLowerCase() ||
          login === `${env.agentBotName.toLowerCase()}[bot]`);
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
  task: DeferredCiTask,
  repository: { owner: string; repo: string },
) => {
  const token = await githubToken();
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
        const tasks = await database()<DeferredCiTask[]>`
          with candidates as (
            select t.id
            from tasks t
            join conversations c on c.id = t.conversation_id
            where (t.state = 'waiting_for_ci' or (t.state in ('reviewing', 'publishing') and t.updated_at < now() - interval '15 minutes'))
              and t.head_sha is not null
              and c.repository_id is not null
              and c.repository_owner is not null
              and c.repository_name is not null
              and c.pull_request_number is not null
            order by t.updated_at, t.created_at
            for update of t skip locked
            limit 25
          )
          update tasks t
          set state = 'reviewing', lease_token = gen_random_uuid(), updated_at = now()
          from candidates x, conversations c
          where t.id = x.id and t.conversation_id = c.id
            and (t.state = 'waiting_for_ci' or (t.state in ('reviewing', 'publishing') and t.updated_at < now() - interval '15 minutes'))
          returning t.id, t.head_sha, t.lease_token, c.repository_id,
            c.repository_owner, c.repository_name, c.github_installation_id,
            c.pull_request_number
        `;

        await Promise.allSettled(
          tasks.map(async (task) => {
            try {
              const repository = await resolveRepository(task);
              await cleanupStaleResult(
                task, repository,
                "CI result publication was interrupted and will be revalidated.",
              );
              const pull = await currentPullRequestHead(task, repository);
              if (!pull.open) {
                await cancel(task.id, task.lease_token);
                return;
              }
              if (pull.headSha !== task.head_sha.toLowerCase()) {
                await supersede(task.id, task.lease_token);
                return;
              }
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
