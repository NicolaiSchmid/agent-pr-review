import { describe, expect, it, vi } from "vitest";
import {
  GitHubError,
  IncompletePullFilesError,
  type GitHubClient,
  type Review,
  type ReviewComment,
} from "./github.js";
import {
  publishReview,
  reconcileExistingReview,
  reviewMarker,
  supersededReviewMarker,
} from "./publish.js";
import type { ReviewResult } from "./result.js";
import type { ReviewScope } from "./scope.js";

const scope: ReviewScope = {
  owner: "NicolaiSchmid",
  repo: "nunc-immo",
  number: 3,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseRef: "main",
  headRef: "feature",
  deliveryId: "delivery",
  fork: "false",
  allowExecution: "true",
};
const result: ReviewResult = {
  version: 1,
  summary: "No actionable defects.",
  tests: [],
  findings: [],
};

class ReviewGitHub {
  headSha = scope.headSha;
  changedFiles = 0;
  nextId = 10;
  reviews: Review[] = [];
  reviewComments: ReviewComment[] = [];
  lostCreateResponse = false;
  lostSubmitResponse = false;
  lostDeleteCommentResponse = false;
  lostUpdateReviewResponse = false;
  changeHeadAfterSubmit = false;
  getPull = vi.fn(async () => ({
    head: { sha: this.headSha },
    changed_files: this.changedFiles,
  }));
  getAuthenticatedLogin = vi.fn(async () => "eve-bot");
  listReviews = vi.fn(async () => this.reviews.map((review) => ({ ...review })));
  listReviewComments = vi.fn(async () => []);
  listReviewCommentsForReview = vi.fn(async (_scope: ReviewScope, reviewId: number) =>
    this.reviewComments.filter(
      (comment) => comment.pull_request_review_id === reviewId,
    ),
  );
  listPullFiles = vi.fn(async () => []);
  getReview = vi.fn(async (_scope: ReviewScope, id: number) => {
    const review = this.reviews.find((item) => item.id === id);
    if (!review) throw new GitHubError("missing", 404, "");
    return { ...review };
  });
  createPendingReview = vi.fn(async (_scope: ReviewScope, input: { body: string }) => {
    if (this.reviews.some((review) => review.state === "PENDING")) {
      throw new GitHubError("one pending review allowed", 422, "");
    }
    const review: Review = {
      id: this.nextId++,
      body: input.body,
      commit_id: scope.headSha,
      state: "PENDING",
      user: { login: "eve-bot" },
    };
    this.reviews.push(review);
    if (this.lostCreateResponse) {
      this.lostCreateResponse = false;
      throw new Error("connection lost after create");
    }
    return { ...review };
  });
  submitReview = vi.fn(async (_scope: ReviewScope, id: number) => {
    const review = this.reviews.find((item) => item.id === id);
    if (!review || review.state !== "PENDING") {
      throw new GitHubError("not pending", 422, "");
    }
    review.state = "COMMENTED";
    if (this.changeHeadAfterSubmit) this.headSha = "c".repeat(40);
    if (this.lostSubmitResponse) {
      this.lostSubmitResponse = false;
      throw new Error("connection lost after submit");
    }
    return { ...review };
  });
  updateReview = vi.fn(
    async (_scope: ReviewScope, id: number, body: string) => {
      const review = this.reviews.find((item) => item.id === id);
      if (!review) throw new GitHubError("missing", 404, "");
      review.body = body;
      if (this.lostUpdateReviewResponse) {
        this.lostUpdateReviewResponse = false;
        throw new Error("connection lost after review update");
      }
      return { ...review };
    },
  );
  deletePendingReview = vi.fn(async (_scope: ReviewScope, id: number) => {
    const index = this.reviews.findIndex(
      (review) => review.id === id && review.state === "PENDING",
    );
    if (index < 0) throw new GitHubError("not pending", 422, "");
    return this.reviews.splice(index, 1)[0]!;
  });
  deleteReviewComment = vi.fn(async (_scope: ReviewScope, id: number) => {
    const index = this.reviewComments.findIndex((comment) => comment.id === id);
    if (index < 0) throw new GitHubError("missing", 404, "");
    this.reviewComments.splice(index, 1);
    if (this.lostDeleteCommentResponse) {
      this.lostDeleteCommentResponse = false;
      throw new Error("connection lost after comment delete");
    }
  });
}

const pendingReview = (id = 10): Review => ({
  id,
  body: reviewMarker(scope.headSha),
  commit_id: scope.headSha,
  state: "PENDING",
  user: { login: "eve-bot" },
});

describe("GitHub-backed publication claim", () => {
  it("converges concurrent publishers on one GitHub review", async () => {
    const client = new ReviewGitHub();
    const publications = await Promise.all([
      publishReview(client as unknown as GitHubClient, scope, result),
      publishReview(client as unknown as GitHubClient, scope, result),
    ]);
    expect(publications.every((publication) =>
      publication.published || publication.reason === "already_published",
    )).toBe(true);
    expect(client.reviews).toEqual([
      expect.objectContaining({ state: "COMMENTED" }),
    ]);
  });

  it("recovers a successful pending create after its response is lost", async () => {
    const client = new ReviewGitHub();
    client.lostCreateResponse = true;
    await expect(
      publishReview(client as unknown as GitHubClient, scope, result),
    ).resolves.toMatchObject({ published: true });
    expect(client.reviews).toHaveLength(1);
    expect(client.reviews[0]?.state).toBe("COMMENTED");
  });

  it("recovers a successful submission after its response is lost", async () => {
    const client = new ReviewGitHub();
    client.reviews.push(pendingReview());
    client.lostSubmitResponse = true;
    await expect(
      reconcileExistingReview(client as unknown as GitHubClient, scope),
    ).resolves.toEqual({ status: "published", counts: {} });
    expect(client.reviews[0]?.state).toBe("COMMENTED");
  });

  it("elects the lowest pending review and deletes losing drafts", async () => {
    const client = new ReviewGitHub();
    client.reviews.push(pendingReview(12), pendingReview(11));
    await expect(
      reconcileExistingReview(client as unknown as GitHubClient, scope),
    ).resolves.toEqual({ status: "published", counts: {} });
    expect(client.submitReview).toHaveBeenCalledWith(scope, 11, expect.any(String));
    expect(client.reviews).toEqual([
      expect.objectContaining({ id: 11, state: "COMMENTED" }),
    ]);
  });

  it("does not submit when the head is stale and compensates a post-submit push", async () => {
    const stale = new ReviewGitHub();
    stale.reviews.push(pendingReview());
    stale.headSha = "c".repeat(40);
    await expect(
      reconcileExistingReview(stale as unknown as GitHubClient, scope),
    ).resolves.toEqual({ status: "stale" });
    expect(stale.submitReview).not.toHaveBeenCalled();

    const raced = new ReviewGitHub();
    raced.reviews.push(pendingReview());
    raced.changeHeadAfterSubmit = true;
    await expect(
      reconcileExistingReview(raced as unknown as GitHubClient, scope),
    ).resolves.toEqual({ status: "superseded" });
    expect(raced.reviews[0]?.body).toContain(
      supersededReviewMarker(scope.headSha),
    );
  });

  it("retries partial/lost rollback responses and never reposts superseded findings", async () => {
    const client = new ReviewGitHub();
    client.headSha = "c".repeat(40);
    client.reviews.push({ ...pendingReview(20), state: "COMMENTED" });
    client.reviewComments.push(
      {
        id: 101,
        body: "actionable stale finding",
        commit_id: scope.headSha,
        pull_request_review_id: 20,
        user: { login: "eve-bot" },
      },
      {
        id: 102,
        body: "another stale finding",
        commit_id: scope.headSha,
        pull_request_review_id: 20,
        user: { login: "eve-bot" },
      },
    );
    client.lostDeleteCommentResponse = true;
    client.lostUpdateReviewResponse = true;

    await expect(
      reconcileExistingReview(client as unknown as GitHubClient, scope),
    ).resolves.toEqual({ status: "superseded" });
    expect(client.reviewComments).toEqual([]);
    expect(client.reviews[0]?.body).toContain("findings withdrawn");

    await expect(
      publishReview(client as unknown as GitHubClient, scope, result),
    ).resolves.toEqual({ published: false, reason: "superseded" });
    expect(client.createPendingReview).not.toHaveBeenCalled();
    expect(client.reviewComments).toEqual([]);
  });

  it("ignores participant markers and recovers bot-submitted reviews", async () => {
    const participant = new ReviewGitHub();
    participant.reviews.push({
      ...pendingReview(1),
      state: "COMMENTED",
      user: { login: "participant" },
    });
    await expect(
      publishReview(participant as unknown as GitHubClient, scope, result),
    ).resolves.toMatchObject({ published: true });

    const bot = new ReviewGitHub();
    bot.reviews.push({ ...pendingReview(2), state: "COMMENTED" });
    await expect(
      publishReview(bot as unknown as GitHubClient, scope, result),
    ).resolves.toEqual({
      published: false,
      reason: "already_published",
      counts: {},
    });
    expect(bot.createPendingReview).not.toHaveBeenCalled();
  });

  it("fails closed before publication above GitHub's 3000-file cap", async () => {
    const client = new ReviewGitHub();
    client.changedFiles = 3_001;
    await expect(
      publishReview(client as unknown as GitHubClient, scope, result),
    ).rejects.toBeInstanceOf(IncompletePullFilesError);
    expect(client.createPendingReview).not.toHaveBeenCalled();
  });
});
