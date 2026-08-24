import { env } from "./env.js";
import { findingMarker, validateAndDedupeFindings } from "./diff.js";
import {
  GitHubError,
  IncompletePullFilesError,
  type GitHubClient,
  type Review,
} from "./github.js";
import type { ReviewResult } from "./result.js";
import type { ReviewScope } from "./scope.js";

export const reviewMarker = (headSha: string) =>
  `<!-- eve-review:${headSha} -->`;

export const supersededReviewMarker = (headSha: string) =>
  `<!-- eve-review-superseded:${headSha} -->`;

const supersededReviewBody = (scope: ReviewScope) =>
  [
    reviewMarker(scope.headSha),
    supersededReviewMarker(scope.headSha),
    "## Eve review withdrawn",
    "",
    "Superseded by a newer push; findings withdrawn.",
    "",
    `Previously reviewed commit: \`${scope.headSha}\``,
  ].join("\n");

const isSubmitted = (review: Review) => review.state !== "PENDING";

const isOwnedExactReview = (
  review: Review,
  login: string,
  scope: ReviewScope,
) =>
  review.user?.login.toLowerCase() === login &&
  review.commit_id === scope.headSha &&
  review.body?.includes(reviewMarker(scope.headSha));

const isOwnedEvePending = (review: Review, login: string) =>
  review.state === "PENDING" &&
  review.user?.login.toLowerCase() === login &&
  review.body?.includes("<!-- eve-review:");

const findingBody = (
  headSha: string,
  finding: ReviewResult["findings"][number],
) =>
  [
    findingMarker(headSha, finding),
    `**${finding.severity.toUpperCase()}: ${finding.title}**`,
    "",
    finding.body,
    "",
    `Evidence: ${finding.evidence}`,
    ...(finding.suggestion && finding.side === "RIGHT"
      ? ["", "Suggested change:", "```suggestion", finding.suggestion, "```"]
      : []),
  ].join("\n");

const currentHeadMatches = async (client: GitHubClient, scope: ReviewScope) =>
  (await client.getPull(scope)).head.sha === scope.headSha;

const countsForHead = async (
  client: GitHubClient,
  scope: ReviewScope,
  login: string,
) =>
  (await client.listReviewComments(scope))
    .filter(
      (comment) =>
        comment.user?.login.toLowerCase() === login &&
        comment.commit_id === scope.headSha &&
        comment.body.includes(`<!-- eve-finding:${scope.headSha}:`),
    )
    .reduce<Record<string, number>>((output, comment) => {
      const severity = /^\*\*(CRITICAL|HIGH|MEDIUM|LOW):/m
        .exec(comment.body)?.[1]
        ?.toLowerCase();
      if (severity) output[severity] = (output[severity] ?? 0) + 1;
      return output;
    }, {});

const deletePendingLosers = async (
  client: GitHubClient,
  scope: ReviewScope,
  reviews: Review[],
  winnerId: number,
) => {
  for (const review of reviews) {
    if (review.state !== "PENDING" || review.id === winnerId) continue;
    try {
      if (!(await currentHeadMatches(client, scope))) return false;
      const current = await client.getReview(scope, review.id);
      if (
        current.state === "PENDING" &&
        current.body?.includes(reviewMarker(scope.headSha))
      ) {
        await client.deletePendingReview(scope, current.id);
      }
    } catch (error) {
      if (
        error instanceof GitHubError &&
        (error.status === 404 || error.status === 422)
      ) {
        continue;
      }
      throw error;
    }
  }
  return true;
};

const exactReviews = async (
  client: GitHubClient,
  scope: ReviewScope,
  login: string,
) =>
  (await client.listReviews(scope))
    .filter((review) => isOwnedExactReview(review, login, scope))
    .sort((left, right) => left.id - right.id);

const deleteReviewCommentWithRecovery = async (
  client: GitHubClient,
  scope: ReviewScope,
  reviewId: number,
  commentId: number,
) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await client.deleteReviewComment(scope, commentId);
      return;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return;
      const remaining = await client.listReviewCommentsForReview(scope, reviewId);
      if (!remaining.some((comment) => comment.id === commentId)) return;
      if (attempt === 1) throw error;
    }
  }
};

export const compensateSupersededReview = async (
  client: GitHubClient,
  scope: ReviewScope,
  review: Review,
) => {
  const body = supersededReviewBody(scope);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const comments = await client.listReviewCommentsForReview(scope, review.id);
    for (const comment of comments) {
      await deleteReviewCommentWithRecovery(
        client,
        scope,
        review.id,
        comment.id,
      );
    }
    if ((await client.listReviewCommentsForReview(scope, review.id)).length > 0) {
      if (attempt === 2) {
        throw new Error(`Unable to withdraw all comments from review ${review.id}`);
      }
      continue;
    }

    const current = await client.getReview(scope, review.id);
    if (current.body?.includes(supersededReviewMarker(scope.headSha))) {
      return current;
    }
    try {
      return await client.updateReview(scope, review.id, body);
    } catch (error) {
      const recovered = await client.getReview(scope, review.id);
      if (recovered.body?.includes(supersededReviewMarker(scope.headSha))) {
        return recovered;
      }
      if (attempt === 2) throw error;
    }
  }
  throw new Error(`Unable to mark review ${review.id} as superseded`);
};

const compensateSubmittedReviews = async (
  client: GitHubClient,
  scope: ReviewScope,
  reviews: Review[],
) => {
  for (const review of reviews.filter(isSubmitted)) {
    await compensateSupersededReview(client, scope, review);
  }
};

const submitPendingWithRecovery = async (
  client: GitHubClient,
  scope: ReviewScope,
  login: string,
  pending: Review,
) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await currentHeadMatches(client, scope))) {
      return { status: "stale" } as const;
    }
    try {
      const submittedReview = await client.submitReview(
        scope,
        pending.id,
        pending.body ?? reviewMarker(scope.headSha),
      );
      const current = await currentHeadMatches(client, scope);
      if (!current) {
        await compensateSupersededReview(client, scope, submittedReview);
        return { status: "superseded" } as const;
      }
      return { status: "published" } as const;
    } catch (error) {
      const recovered = await exactReviews(client, scope, login);
      const submitted = recovered.filter(isSubmitted);
      if (submitted.length > 0) {
        const current = await currentHeadMatches(client, scope);
        if (!current) {
          await compensateSubmittedReviews(client, scope, submitted);
          return { status: "superseded" } as const;
        }
        return { status: "published" } as const;
      }
      const stillPending = recovered.find((review) => review.state === "PENDING");
      if (!stillPending || attempt === 1) throw error;
      pending = stillPending;
      continue;
    }
  }
  return { status: "stale" } as const;
};

export const reconcileExistingReview = async (
  client: GitHubClient,
  scope: ReviewScope,
) => {
  const login = await client.getAuthenticatedLogin();
  const matches = await exactReviews(client, scope, login);
  const submitted = matches.filter(isSubmitted);
  if (submitted.length > 0) {
    if (
      submitted.some((review) =>
        review.body?.includes(supersededReviewMarker(scope.headSha)),
      )
    ) {
      await compensateSubmittedReviews(client, scope, submitted);
      return { status: "superseded" } as const;
    }
    await deletePendingLosers(client, scope, matches, submitted[0]!.id);
    if (!(await currentHeadMatches(client, scope))) {
      await compensateSubmittedReviews(client, scope, submitted);
      return { status: "superseded" } as const;
    }
    return {
      status: "published",
      counts: await countsForHead(client, scope, login),
    } as const;
  }

  const pending = matches.filter((review) => review.state === "PENDING");
  if (pending.length === 0) return { status: "none" } as const;
  const winner = pending[0]!;
  if (!(await deletePendingLosers(client, scope, pending, winner.id))) {
    return { status: "stale" } as const;
  }
  const submission = await submitPendingWithRecovery(
    client,
    scope,
    login,
    winner,
  );
  if (submission.status !== "published") return submission;
  return {
    status: "published",
    counts: await countsForHead(client, scope, login),
  } as const;
};

const createOrRecoverPending = async (
  client: GitHubClient,
  scope: ReviewScope,
  login: string,
  body: string,
  comments: Array<{
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
    body: string;
  }>,
) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await currentHeadMatches(client, scope))) return null;
    try {
      await client.createPendingReview(scope, { body, comments });
    } catch (error) {
      const reviews = await client.listReviews(scope);
      const exact = reviews
        .filter((review) => isOwnedExactReview(review, login, scope))
        .sort((left, right) => left.id - right.id);
      if (exact.length > 0) return exact[0]!;

      if (!(error instanceof GitHubError) || error.status !== 422) throw error;
      const stalePending = reviews.filter((review) =>
        isOwnedEvePending(review, login),
      );
      for (const stale of stalePending) {
        if (!(await currentHeadMatches(client, scope))) return null;
        try {
          await client.deletePendingReview(scope, stale.id);
        } catch (deleteError) {
          if (
            !(deleteError instanceof GitHubError) ||
            ![404, 422].includes(deleteError.status)
          ) {
            throw deleteError;
          }
        }
      }
      if (attempt === 1) throw error;
      continue;
    }

    // Recover from a successful create whose response was lost, and ensure
    // every instance elects the same lowest exact-head review ID.
    const exact = await exactReviews(client, scope, login);
    if (exact.length > 0) return exact[0]!;
  }
  return null;
};

export const publishReview = async (
  client: GitHubClient,
  scope: ReviewScope,
  result: ReviewResult,
) => {
  const reconciled = await reconcileExistingReview(client, scope);
  if (reconciled.status === "published") {
    return {
      published: false,
      reason: "already_published",
      counts: reconciled.counts,
    } as const;
  }
  if (reconciled.status !== "none") {
    return { published: false, reason: reconciled.status } as const;
  }

  let pull = await client.getPull(scope);
  if (pull.head.sha !== scope.headSha) {
    return { published: false, reason: "stale_head" } as const;
  }
  if (pull.changed_files > 3_000) {
    throw new IncompletePullFilesError(pull.changed_files);
  }

  const login = await client.getAuthenticatedLogin();
  const [files, existingComments] = await Promise.all([
    client.listPullFiles(scope, pull.changed_files),
    client.listReviewComments(scope),
  ]);
  const findings = validateAndDedupeFindings(
    scope.headSha,
    result.findings,
    files,
    existingComments
      .filter((comment) => comment.user?.login.toLowerCase() === login)
      .map((comment) => comment.body),
  ).slice(0, Math.max(0, env.maxFindings));

  const counts = findings.reduce<Record<string, number>>((output, finding) => {
    output[finding.severity] = (output[finding.severity] ?? 0) + 1;
    return output;
  }, {});
  const tests = result.tests.map(
    (test) =>
      `- ${test.result === "passed" ? "PASS" : test.result === "failed" ? "FAIL" : "SKIP"} \`${test.command}\`${test.details ? `: ${test.details}` : ""}`,
  );
  const body = [
    reviewMarker(scope.headSha),
    "## Eve review",
    "",
    result.summary,
    "",
    `Findings published: ${findings.length}`,
    "",
    "### Checks",
    ...(tests.length ? tests : ["- None reported"]),
    "",
    `Reviewed commit: \`${scope.headSha}\``,
  ].join("\n");

  pull = await client.getPull(scope);
  if (pull.head.sha !== scope.headSha) {
    return { published: false, reason: "stale_head" } as const;
  }
  const pending = await createOrRecoverPending(
    client,
    scope,
    login,
    body,
    findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: findingBody(scope.headSha, finding),
    })),
  );
  if (!pending) return { published: false, reason: "stale_head" } as const;

  const submission = await reconcileExistingReview(client, scope);
  if (submission.status !== "published") {
    return { published: false, reason: submission.status } as const;
  }
  return { published: true, findings, counts } as const;
};
