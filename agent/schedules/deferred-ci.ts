import { defineSchedule } from "eve/schedules";
import { connectGitHubCredentials } from "@vercel/connect/eve";
import github from "../channels/github-connect.js";
import { database } from "../lib/database.js";
import { extractCompletedAssistantText } from "../lib/message-text.js";
import { env } from "../lib/env.js";

const credentials = connectGitHubCredentials(env.githubConnector);

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

const complete = async (taskId: string, leaseToken: string) => {
  await database()`
    update tasks
    set state = 'completed', updated_at = now()
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

const currentPullRequestHead = async (task: DeferredCiTask) => {
  const source = credentials.installationToken;
  if (!source) throw new Error("GitHub installation token is unavailable");
  const token = typeof source === "function" ? await source() : source;
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(task.repository_owner)}/${encodeURIComponent(task.repository_name)}/pulls/${task.pull_request_number}`,
    { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "eve-engineering-agent" } },
  );
  if (!response.ok) throw new Error(`Could not revalidate PR head: ${response.status}`);
  const pull = await response.json() as {
    head: { sha: string };
    merged: boolean;
    state: string;
  };
  return { headSha: pull.head.sha.toLowerCase(), open: pull.state === "open" && !pull.merged };
};

const reportedTerminalCi = async (
  stream: ReadableStream<unknown>,
  taskId: string,
  leaseToken: string,
): Promise<boolean> => {
  let response = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value: event } = await reader.read();
    if (done) break;
    if (
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "message.completed"
    ) {
      response += extractCompletedAssistantText(event as Parameters<typeof extractCompletedAssistantText>[0]);
    }
  }
  const ids = [...response.matchAll(/^CI_TASK_ID:\s*(\S+)\s*$/gim)];
  const leases = [...response.matchAll(/^CI_LEASE_ID:\s*(\S+)\s*$/gim)];
  const states = [...response.matchAll(/^CI_TASK_STATE:\s*(pending|terminal)\s*$/gim)];
  if (ids.length !== 1 || leases.length !== 1 || states.length !== 1) return false;
  return new RegExp(
    `(?:^|\\n)CI_TASK_ID:\\s*${taskId}\\s*\\nCI_LEASE_ID:\\s*${leaseToken}\\s*\\nCI_TASK_STATE:\\s*terminal\\s*$`,
    "i",
  ).test(response.trim());
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
              const pull = await currentPullRequestHead(task);
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
                  owner: task.repository_owner,
                  repo: task.repository_name,
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
                    repository: `${task.repository_owner}/${task.repository_name}`,
                  },
                },
              });
              const terminal = await reportedTerminalCi(
                await session.getEventStream(), task.id, task.lease_token,
              );
              if (terminal) await complete(task.id, task.lease_token);
              else await release(task.id, task.lease_token);
            } catch (error) {
              await release(task.id, task.lease_token).catch(() => undefined);
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
