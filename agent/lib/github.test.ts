import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubClient,
  IncompletePullFilesError,
  type PullFile,
} from "./github.js";

const scope = { owner: "NicolaiSchmid", repo: "nunc-immo", number: 1 };
const file = (index: number): PullFile => ({
  filename: `file-${index}.ts`,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: "@@ -0,0 +1 @@\n+value",
});

afterEach(() => vi.unstubAllGlobals());

describe("pull file completeness", () => {
  it("rejects counts above GitHub's documented 3000-file cap", () => {
    const client = new GitHubClient("token", "https://api.example.test");
    expect(() => client.listPullFiles(scope, 3_001)).toThrow(
      IncompletePullFilesError,
    );
  });

  it("stops exactly at the reported count without probing another page", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(Array.from({ length: 100 }, (_, index) => file(index))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitHubClient("token", "https://api.example.test");
    await expect(client.listPullFiles(scope, 100)).resolves.toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed when pagination terminates before changed_files", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(Array.from({ length: 100 }, (_, index) => file(index))),
      )
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitHubClient("token", "https://api.example.test");
    await expect(client.listPullFiles(scope, 101)).rejects.toThrow(
      "reported 101 changed files but returned 100",
    );
  });
});

describe("stale review compensation endpoints", () => {
  it("lists review-owned comments, deletes comments, and updates the review body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json({
          id: 7,
          body: "withdrawn",
          commit_id: "b".repeat(40),
          state: "COMMENTED",
          user: { login: "eve-bot" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitHubClient("token", "https://api.example.test");
    const reviewScope = {
      ...scope,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      baseRef: "main",
      headRef: "feature",
      deliveryId: "delivery",
      fork: "false" as const,
      allowExecution: "true" as const,
    };

    await client.listReviewCommentsForReview(reviewScope, 7);
    await client.deleteReviewComment(reviewScope, 99);
    await client.updateReview(reviewScope, 7, "withdrawn");

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [
        "https://api.example.test/repos/NicolaiSchmid/nunc-immo/pulls/1/reviews/7/comments?per_page=100&page=1",
        "GET",
      ],
      [
        "https://api.example.test/repos/NicolaiSchmid/nunc-immo/pulls/comments/99",
        "DELETE",
      ],
      [
        "https://api.example.test/repos/NicolaiSchmid/nunc-immo/pulls/1/reviews/7",
        "PUT",
      ],
    ]);
  });
});
