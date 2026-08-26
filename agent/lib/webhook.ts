import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "./env.js";
import { TARGET_OWNER, TARGET_REPO, type ReviewScope } from "./scope.js";

const pullRequestSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.union([z.string(), z.number()]) }).optional(),
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
  sender: z.object({ login: z.string(), type: z.string().optional() }),
  pull_request: z.object({
    number: z.number().int().positive(),
    draft: z.boolean().optional().default(false),
    user: z.object({ login: z.string(), type: z.string().optional() }),
    body: z.string().nullable().optional(),
    base: z.object({
      sha: z.string(),
      ref: z.string(),
      repo: z.object({
        name: z.string(),
        owner: z.object({ login: z.string() }),
      }),
    }),
    head: z.object({
      sha: z.string(),
      ref: z.string(),
      repo: z
        .object({ name: z.string(), owner: z.object({ login: z.string() }) })
        .nullable(),
    }),
  }),
});

const acceptedActions = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

export const verifyWebhookSignature = (
  rawBody: Uint8Array,
  signature: string | null,
  secret: string | undefined,
) => {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const supplied = signature.slice(7);
  if (!/^[0-9a-f]{64}$/i.test(supplied)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(supplied, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export type WebhookDecision =
  | { accepted: true; scope: ReviewScope; title: string }
  | { accepted: false; reason: string };

export const isOwnStackedPull = (
  pull: { body?: string | null; user: { login: string } },
  botLogin: string | undefined,
) =>
  Boolean(botLogin) &&
  pull.user.login.toLowerCase() === botLogin?.toLowerCase() &&
  Boolean(pull.body?.includes("<!-- eve-review-stack:"));

export const isBotActor = (event: {
  sender: { login: string; type?: string };
  pull_request: { user: { login: string; type?: string } };
}) =>
  event.sender.type === "Bot" ||
  event.pull_request.user.type === "Bot" ||
  [event.sender.login, event.pull_request.user.login].some((login) =>
    login.toLowerCase().endsWith("[bot]"),
  );

export const evaluatePullRequestEvent = (
  payload: unknown,
  deliveryId: string | null,
): WebhookDecision => {
  const parsed = pullRequestSchema.safeParse(payload);
  if (!parsed.success) return { accepted: false, reason: "malformed_payload" };
  if (!deliveryId) return { accepted: false, reason: "missing_delivery_id" };
  const event = parsed.data;
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  if (
    owner.toLowerCase() !== TARGET_OWNER.toLowerCase() ||
    repo.toLowerCase() !== TARGET_REPO.toLowerCase()
  ) {
    return { accepted: false, reason: "repository_ignored" };
  }
  if (!acceptedActions.has(event.action)) {
    return { accepted: false, reason: "action_ignored" };
  }
  if (event.pull_request.draft && event.action !== "ready_for_review") {
    return { accepted: false, reason: "draft_ignored" };
  }
  const isBot = isBotActor(event);
  if (
    isBot &&
    event.pull_request.body?.includes("<!-- eve-review-stack:") &&
    !env.githubBotLogin
  ) {
    return { accepted: false, reason: "bot_login_required" };
  }
  if (isBot && !isOwnStackedPull(event.pull_request, env.githubBotLogin)) {
    return { accepted: false, reason: "bot_ignored" };
  }

  const headRepo = event.pull_request.head.repo;
  const fork =
    !headRepo ||
    headRepo.owner.login.toLowerCase() !== owner.toLowerCase() ||
    headRepo.name.toLowerCase() !== repo.toLowerCase();
  const scope: ReviewScope = {
    owner,
    repo,
    number: event.pull_request.number,
    baseSha: event.pull_request.base.sha,
    headSha: event.pull_request.head.sha,
    baseRef: event.pull_request.base.ref,
    headRef: event.pull_request.head.ref,
    deliveryId,
    fork: String(fork) as "true" | "false",
    allowExecution: String(!fork || env.allowForkExecution) as "true" | "false",
    ...(event.installation ? { installationId: String(event.installation.id) } : {}),
  };
  return {
    accepted: true,
    scope,
    title: `Review ${owner}/${repo}#${scope.number} at ${scope.headSha.slice(0, 7)}`,
  };
};
