import { defineSchedule } from "eve/schedules";
import github from "../channels/github-connect.js";
import { database } from "../lib/database.js";

interface DeferredCiTask {
  id: string;
  head_sha: string;
  repository_id: string;
  repository_owner: string;
  repository_name: string;
  github_installation_id: string | null;
  pull_request_number: number;
}

const release = async (taskId: string) => {
  await database()`
    update tasks
    set state = 'waiting_for_ci', updated_at = now()
    where id = ${taskId} and state = 'reviewing'
  `;
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
            where t.state = 'waiting_for_ci'
              and t.head_sha is not null
              and c.repository_id is not null
              and c.repository_owner is not null
              and c.repository_name is not null
              and c.pull_request_number is not null
            order by t.created_at
            for update of t skip locked
            limit 25
          )
          update tasks t
          set state = 'reviewing', updated_at = now()
          from candidates x, conversations c
          where t.id = x.id and t.conversation_id = c.id
          returning t.id, t.head_sha, c.repository_id,
            c.repository_owner, c.repository_name, c.github_installation_id,
            c.pull_request_number
        `;

        await Promise.all(
          tasks.map(async (task) => {
            try {
              await receive(github, {
                message: [
                  `Re-evaluate deferred CI task ${task.id} for exact head ${task.head_sha}.`,
                  "Read both Check Runs and legacy commit statuses with github_repository.",
                  "If any required context is pending, defer this task again. Otherwise report the terminal CI outcome and continue the requested work.",
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
                auth: appAuth,
              });
            } catch (error) {
              await release(task.id).catch(() => undefined);
              throw error;
            }
          }),
        );
      })(),
    );
  },
});
