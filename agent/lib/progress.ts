import { GitHubError, type GitHubClient, type IssueComment } from "./github.js";
import type { ReviewScope } from "./scope.js";

export const progressMarker = (
  scope: Pick<ReviewScope, "owner" | "repo" | "number">,
) =>
  `<!-- eve-pr-review:${scope.owner.toLowerCase()}/${scope.repo.toLowerCase()}#${scope.number} -->`;

export const progressHeadMarker = (headSha: string) =>
  `<!-- eve-review-head:${headSha} -->`;

export const progressDeliveryMarker = (deliveryId: string) =>
  `<!-- eve-review-delivery:${deliveryId} -->`;

export type ProgressState = "reviewing" | "completed" | "failed";

const stateFromBody = (body: string): ProgressState | null => {
  const match = /^### Eve PR review: (reviewing|completed|failed)$/m.exec(body);
  return (match?.[1] as ProgressState | undefined) ?? null;
};

const hasOwnLogin = (comment: IssueComment, login: string) =>
  comment.user?.login.toLowerCase() === login;

export const renderProgress = (
  scope: ReviewScope,
  state: ProgressState,
  options: {
    phase?: string;
    summary?: string;
    tests?: string[];
    findings?: Record<string, number>;
    error?: string;
  } = {},
) => {
  const phase = options.phase ?? "intake";
  const phases = ["intake", "context", "checks", "verification", "synthesis"];
  const checklist = phases
    .map(
      (item) =>
        `${phases.indexOf(item) <= phases.indexOf(phase) ? "- [x]" : "- [ ]"} ${item}`,
    )
    .join("\n");
  const details =
    state === "completed"
      ? [
          options.summary ?? "Review completed.",
          "",
          `Findings: ${Object.entries(options.findings ?? {})
            .map(([severity, count]) => `${severity} ${count}`)
            .join(", ") || "none"}`,
          `Tests: ${options.tests?.join("; ") || "none reported"}`,
        ]
      : state === "failed"
        ? [`Review failed: ${options.error ?? "unknown error"}`]
        : [`Reviewing \`${scope.headSha.slice(0, 7)}\``, "", checklist];
  return [
    progressMarker(scope),
    progressHeadMarker(scope.headSha),
    progressDeliveryMarker(scope.deliveryId),
    `### Eve PR review: ${state}`,
    "",
    ...details,
    "",
    `Reviewed SHA: \`${scope.headSha}\``,
  ].join("\n");
};

const currentHead = async (client: GitHubClient, scope: ReviewScope) =>
  (await client.getPull(scope)).head.sha === scope.headSha;

const ownProgressComments = async (
  client: GitHubClient,
  scope: ReviewScope,
  login: string,
) => {
  const marker = progressMarker(scope);
  return (await client.listIssueComments(scope))
    .filter(
      (comment) =>
        hasOwnLogin(comment, login) && comment.body.includes(marker),
    )
    .sort((a, b) => a.id - b.id);
};

const updateChecked = async (
  client: GitHubClient,
  scope: ReviewScope,
  login: string,
  id: number,
  body: string,
  allowHeadReplacement: boolean,
) => {
  const current = await client.getIssueComment(scope, id);
  if (
    !hasOwnLogin(current, login) ||
    !current.body.includes(progressMarker(scope)) ||
    (!allowHeadReplacement &&
      !current.body.includes(progressHeadMarker(scope.headSha)))
  ) {
    return false;
  }
  if (
    current.body.includes(progressHeadMarker(scope.headSha)) &&
    stateFromBody(current.body) === "completed" &&
    stateFromBody(body) !== "completed"
  ) {
    return false;
  }
  if (!(await currentHead(client, scope))) return false;
  await client.updateIssueComment(scope, id, body);
  return true;
};

const deleteChecked = async (
  client: GitHubClient,
  scope: ReviewScope,
  login: string,
  comment: IssueComment,
) => {
  try {
    const current = await client.getIssueComment(scope, comment.id);
    if (
      !hasOwnLogin(current, login) ||
      !current.body.includes(progressMarker(scope))
    ) {
      return false;
    }
    if (!(await currentHead(client, scope))) return false;
    await client.deleteIssueComment(scope, current.id);
    return true;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return false;
    throw error;
  }
};

const cleanupDuplicates = async (
  client: GitHubClient,
  scope: ReviewScope,
  login: string,
  comments: IssueComment[],
  canonicalId: number,
) => {
  for (const comment of comments) {
    if (comment.id !== canonicalId) {
      await deleteChecked(client, scope, login, comment);
    }
  }
};

export const beginProgress = async (
  client: GitHubClient,
  scope: ReviewScope,
) => {
  if (!(await currentHead(client, scope))) {
    return { started: false, reason: "stale_head" } as const;
  }
  const login = await client.getAuthenticatedLogin();
  const [reviews, initialComments] = await Promise.all([
    client.listReviews(scope),
    ownProgressComments(client, scope, login),
  ]);
  const reviewMarker = `<!-- eve-review:${scope.headSha} -->`;
  if (
    reviews.some(
      (review) =>
        review.user?.login.toLowerCase() === login &&
        review.state !== "PENDING" &&
        review.commit_id === scope.headSha &&
        review.body?.includes(reviewMarker) &&
        !review.body.includes(`<!-- eve-review-superseded:${scope.headSha} -->`),
    )
  ) {
    return { started: false, reason: "already_completed" } as const;
  }

  const sameHead = initialComments.find((comment) =>
    comment.body.includes(progressHeadMarker(scope.headSha)),
  );
  const sameHeadState = sameHead ? stateFromBody(sameHead.body) : null;
  if (sameHeadState === "completed") {
    return { started: false, reason: "already_completed" } as const;
  }
  if (sameHeadState === "reviewing") {
    return { started: false, reason: "already_reviewing" } as const;
  }

  const body = renderProgress(scope, "reviewing", { phase: "intake" });
  let created: IssueComment | undefined;
  if (initialComments.length === 0) {
    if (!(await currentHead(client, scope))) {
      return { started: false, reason: "stale_head" } as const;
    }
    created = await client.createIssueComment(scope, body);
  }

  const comments = await ownProgressComments(client, scope, login);
  const canonical = comments[0];
  if (!canonical) throw new Error("Unable to claim progress comment");

  if (
    canonical.body.includes(progressHeadMarker(scope.headSha)) &&
    stateFromBody(canonical.body) === "reviewing"
  ) {
    await cleanupDuplicates(client, scope, login, comments, canonical.id);
    return created?.id === canonical.id
      ? ({ started: true, commentId: canonical.id } as const)
      : ({ started: false, reason: "already_reviewing" } as const);
  }

  const updated = await updateChecked(
    client,
    scope,
    login,
    canonical.id,
    body,
    true,
  );
  if (!updated) return { started: false, reason: "claim_lost" } as const;

  const claimed = await client.getIssueComment(scope, canonical.id);
  if (
    !hasOwnLogin(claimed, login) ||
    !claimed.body.includes(progressHeadMarker(scope.headSha)) ||
    !claimed.body.includes(progressDeliveryMarker(scope.deliveryId)) ||
    stateFromBody(claimed.body) !== "reviewing"
  ) {
    return { started: false, reason: "claim_lost" } as const;
  }
  await cleanupDuplicates(client, scope, login, comments, canonical.id);
  return { started: true, commentId: canonical.id } as const;
};

export const updateProgress = async (
  client: GitHubClient,
  scope: ReviewScope,
  body: string,
) => {
  if (!(await currentHead(client, scope))) {
    return { updated: false, reason: "stale_head" } as const;
  }
  const login = await client.getAuthenticatedLogin();
  const comments = await ownProgressComments(client, scope, login);
  const matching = comments.filter((comment) =>
    comment.body.includes(progressHeadMarker(scope.headSha)),
  );
  const canonical = matching[0];
  if (!canonical) {
    return { updated: false, reason: "stale_comment" } as const;
  }
  if (
    stateFromBody(canonical.body) === "completed" &&
    stateFromBody(body) !== "completed"
  ) {
    return { updated: false, reason: "already_completed" } as const;
  }
  const updated = await updateChecked(
    client,
    scope,
    login,
    canonical.id,
    body,
    false,
  );
  if (!updated) return { updated: false, reason: "stale_comment" } as const;
  await cleanupDuplicates(client, scope, login, matching, canonical.id);
  return { updated: true, commentId: canonical.id } as const;
};

export const reconcileCompletedProgress = async (
  client: GitHubClient,
  scope: ReviewScope,
  counts: Record<string, number> = {},
) => {
  if (!(await currentHead(client, scope))) {
    return { updated: false, reason: "stale_head" } as const;
  }
  const login = await client.getAuthenticatedLogin();
  let comments = await ownProgressComments(client, scope, login);
  const existing = comments.find(
    (comment) =>
      comment.body.includes(progressHeadMarker(scope.headSha)) &&
      stateFromBody(comment.body) === "completed",
  );
  if (existing) {
    return { updated: false, reason: "already_completed" } as const;
  }

  const body = renderProgress(scope, "completed", {
    summary: "Review publication recovered from GitHub state.",
    findings: counts,
    tests: ["See the submitted review for recorded checks."],
  });
  if (comments.length === 0) {
    if (!(await currentHead(client, scope))) {
      return { updated: false, reason: "stale_head" } as const;
    }
    await client.createIssueComment(scope, body);
    comments = await ownProgressComments(client, scope, login);
  }
  const canonical = comments[0];
  if (!canonical) throw new Error("Unable to reconcile completed progress");
  const updated = await updateChecked(
    client,
    scope,
    login,
    canonical.id,
    body,
    true,
  );
  if (!updated) return { updated: false, reason: "stale_comment" } as const;
  await cleanupDuplicates(client, scope, login, comments, canonical.id);
  return { updated: true, commentId: canonical.id } as const;
};
