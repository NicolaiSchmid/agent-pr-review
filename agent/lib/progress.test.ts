import { describe, expect, it, vi } from "vitest";
import {
  GitHubError,
  type GitHubClient,
  type IssueComment,
  type Review,
} from "./github.js";
import {
  beginProgress,
  progressHeadMarker,
  progressMarker,
  reconcileCompletedProgress,
  renderProgress,
  updateProgress,
} from "./progress.js";
import type { ReviewScope } from "./scope.js";

const scope: ReviewScope = {
  owner: "NicolaiSchmid",
  repo: "nunc-immo",
  number: 9,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseRef: "main",
  headRef: "feature",
  deliveryId: "delivery-1",
  fork: "false",
  allowExecution: "true",
};

class StatefulGitHub {
  headSha = scope.headSha;
  comments: IssueComment[] = [];
  reviews: Review[] = [];
  nextId = 1;
  onGetComment?: (comment: IssueComment) => void;
  getPull = vi.fn(async () => ({ head: { sha: this.headSha } }));
  getAuthenticatedLogin = vi.fn(async () => "eve-bot");
  listReviews = vi.fn(async () => this.reviews.map((review) => ({ ...review })));
  listIssueComments = vi.fn(async () =>
    this.comments.map((comment) => ({ ...comment, user: comment.user && { ...comment.user } })),
  );
  getIssueComment = vi.fn(async (_scope: ReviewScope, id: number) => {
    const comment = this.comments.find((item) => item.id === id);
    if (!comment) throw new GitHubError("missing comment", 404, "");
    this.onGetComment?.(comment);
    return { ...comment, user: comment.user && { ...comment.user } };
  });
  createIssueComment = vi.fn(async (_scope: ReviewScope, body: string) => {
    const comment = {
      id: this.nextId++,
      body,
      user: { login: "eve-bot" },
    };
    this.comments.push(comment);
    return { ...comment };
  });
  updateIssueComment = vi.fn(
    async (_scope: ReviewScope, id: number, body: string) => {
      const comment = this.comments.find((item) => item.id === id)!;
      comment.body = body;
      return { ...comment };
    },
  );
  deleteIssueComment = vi.fn(async (_scope: ReviewScope, id: number) => {
    const index = this.comments.findIndex((item) => item.id === id);
    if (index >= 0) this.comments.splice(index, 1);
  });
}

describe("progress ownership and idempotency", () => {
  it("ignores participant marker spoofing and only manages the bot comment", async () => {
    const client = new StatefulGitHub();
    const spoof = {
      id: 50,
      body: `${progressMarker(scope)}\n${progressHeadMarker(scope.headSha)}\n### Eve PR review: completed`,
      user: { login: "participant" },
    };
    client.comments.push(spoof);

    await expect(
      beginProgress(client as unknown as GitHubClient, scope),
    ).resolves.toMatchObject({ started: true });
    expect(client.comments).toContain(spoof);
    expect(client.updateIssueComment).not.toHaveBeenCalledWith(
      scope,
      spoof.id,
      expect.anything(),
    );
    expect(client.deleteIssueComment).not.toHaveBeenCalledWith(scope, spoof.id);
  });

  it("does not reset or redispatch a same-head in-flight review", async () => {
    const client = new StatefulGitHub();
    client.comments.push({
      id: 1,
      body: renderProgress(scope, "reviewing", { phase: "context" }),
      user: { login: "EVE-BOT" },
    });

    await expect(
      beginProgress(client as unknown as GitHubClient, scope),
    ).resolves.toEqual({ started: false, reason: "already_reviewing" });
    expect(client.createIssueComment).not.toHaveBeenCalled();
    expect(client.updateIssueComment).not.toHaveBeenCalled();
  });

  it("treats only a bot-authored exact-head review marker as completed", async () => {
    const marker = `<!-- eve-review:${scope.headSha} -->`;
    const participant = new StatefulGitHub();
    participant.reviews.push({
      id: 1,
      body: marker,
      commit_id: scope.headSha,
      state: "COMMENTED",
      user: { login: "participant" },
    });
    await expect(
      beginProgress(participant as unknown as GitHubClient, scope),
    ).resolves.toMatchObject({ started: true });

    const bot = new StatefulGitHub();
    bot.reviews.push({
      id: 2,
      body: marker,
      commit_id: scope.headSha,
      state: "COMMENTED",
      user: { login: "eve-bot" },
    });
    await expect(
      beginProgress(bot as unknown as GitHubClient, scope),
    ).resolves.toEqual({ started: false, reason: "already_completed" });
  });

  it("reconciles an in-flight bot comment after publication recovery", async () => {
    const client = new StatefulGitHub();
    client.comments.push({
      id: 1,
      body: renderProgress(scope, "reviewing", { phase: "synthesis" }),
      user: { login: "eve-bot" },
    });
    await expect(
      reconcileCompletedProgress(
        client as unknown as GitHubClient,
        scope,
        { high: 1 },
      ),
    ).resolves.toEqual({ updated: true, commentId: 1 });
    expect(client.comments[0]?.body).toContain("### Eve PR review: completed");
    expect(client.comments[0]?.body).toContain("high 1");
  });
});

describe("progress concurrency-adjacent behavior", () => {
  it("allows only the canonical creator to win concurrent empty-state claims", async () => {
    const client = new StatefulGitHub();
    let initialReads = 0;
    let releaseReads!: () => void;
    const readsReady = new Promise<void>((resolve) => (releaseReads = resolve));
    client.listIssueComments = vi.fn(async () => {
      if (client.comments.length === 0) {
        initialReads += 1;
        if (initialReads === 2) releaseReads();
        await readsReady;
        return [];
      }
      return client.comments.map((comment) => ({ ...comment }));
    });
    let creates = 0;
    let releaseCreates!: () => void;
    const createsReady = new Promise<void>((resolve) => (releaseCreates = resolve));
    client.createIssueComment = vi.fn(async (_scope, body: string) => {
      const comment = {
        id: client.nextId++,
        body,
        user: { login: "eve-bot" },
      };
      client.comments.push(comment);
      creates += 1;
      if (creates === 2) releaseCreates();
      await createsReady;
      return { ...comment };
    });

    const [first, second] = await Promise.all([
      beginProgress(client as unknown as GitHubClient, scope),
      beginProgress(client as unknown as GitHubClient, {
        ...scope,
        deliveryId: "delivery-2",
      }),
    ]);

    expect([first.started, second.started].sort()).toEqual([false, true]);
    expect(client.comments).toHaveLength(1);
    expect(client.comments[0]?.id).toBe(1);
  });

  it("refuses an old completion when a newer marker appears before PATCH", async () => {
    const client = new StatefulGitHub();
    client.comments.push({
      id: 1,
      body: renderProgress(scope, "reviewing", { phase: "verification" }),
      user: { login: "eve-bot" },
    });
    client.onGetComment = (comment) => {
      comment.body = renderProgress(
        { ...scope, headSha: "c".repeat(40), deliveryId: "new-delivery" },
        "reviewing",
      );
    };

    await expect(
      updateProgress(
        client as unknown as GitHubClient,
        scope,
        renderProgress(scope, "completed", { summary: "old" }),
      ),
    ).resolves.toEqual({ updated: false, reason: "stale_comment" });
    expect(client.updateIssueComment).not.toHaveBeenCalled();
  });

  it("rechecks the PR head before deleting a duplicate", async () => {
    const client = new StatefulGitHub();
    client.comments.push(
      {
        id: 1,
        body: renderProgress(scope, "reviewing"),
        user: { login: "eve-bot" },
      },
      {
        id: 2,
        body: renderProgress(scope, "reviewing"),
        user: { login: "eve-bot" },
      },
    );
    client.onGetComment = () => {
      client.headSha = "c".repeat(40);
    };

    await updateProgress(
      client as unknown as GitHubClient,
      scope,
      renderProgress(scope, "completed"),
    );
    expect(client.deleteIssueComment).not.toHaveBeenCalled();
  });
});
