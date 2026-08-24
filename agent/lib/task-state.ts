import { z } from "zod";

export const taskStateSchema = z.enum([
  "queued",
  "waiting_for_ci",
  "reviewing",
  "waiting_for_user",
  "publishing",
  "completed",
  "superseded",
  "failed",
  "cancelled",
]);

export type TaskState = z.infer<typeof taskStateSchema>;

const transitions: Record<TaskState, ReadonlySet<TaskState>> = {
  queued: new Set(["waiting_for_ci", "reviewing", "cancelled", "failed"]),
  waiting_for_ci: new Set(["reviewing", "superseded", "cancelled", "failed"]),
  reviewing: new Set(["waiting_for_user", "publishing", "superseded", "cancelled", "failed"]),
  waiting_for_user: new Set(["reviewing", "cancelled", "failed"]),
  publishing: new Set(["completed", "superseded", "failed"]),
  completed: new Set(),
  superseded: new Set(),
  failed: new Set(["queued", "cancelled"]),
  cancelled: new Set(),
};

export const canTransitionTask = (from: TaskState, to: TaskState) =>
  transitions[from].has(to);

export const transitionTask = (from: TaskState, to: TaskState) => {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
  return to;
};

export const reviewConversationKey = (input: {
  installationId: string;
  owner: string;
  repo: string;
  pullRequest: number;
}) =>
  `github:${input.installationId}:${input.owner.toLowerCase()}/${input.repo.toLowerCase()}#${input.pullRequest}`;

export const reviewPassKey = (conversationKey: string, headSha: string) =>
  `${conversationKey}@${headSha.toLowerCase()}`;
