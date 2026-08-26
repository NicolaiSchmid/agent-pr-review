import { describe, expect, it, vi } from "vitest";
import type { GitHubClient, PullRequest } from "./github.js";
import type { ReviewResult } from "./result.js";
import type { ReviewScope } from "./scope.js";
import { createStackedReviewPull, parseStackMarker, stackMarker } from "./stacked-pr.js";

const scope: ReviewScope = {
  owner: "NicolaiSchmid", repo: "nunc-immo", number: 7,
  baseSha: "a".repeat(40), headSha: "b".repeat(40), baseRef: "main",
  headRef: "feature", deliveryId: "d", fork: "false", allowExecution: "true",
};
const result: ReviewResult = {
  version: 2, summary: "Fix the defect.", tests: [],
  findings: [{ severity: "high", path: "src/a.ts", line: 1, side: "RIGHT", title: "Handle failure", body: "It fails.", evidence: "Test." }],
  changes: [{ path: "src/a.ts", content: "fixed\n" }],
};
const pull = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  number: 7, changed_files: 1, draft: false, html_url: "https://example.test/7",
  title: "Feature", body: null, base: { sha: scope.baseSha, ref: "main" },
  head: { sha: scope.headSha, ref: "feature", repo: { full_name: "NicolaiSchmid/nunc-immo" } },
  ...overrides,
});

class StackGitHub {
  pulls: PullRequest[] = [];
  getPull = vi.fn(async () => pull());
  getAuthenticatedLogin = vi.fn(async () => "eve-bot");
  listPullFiles = vi.fn(async () => [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+broken" }]);
  listReviewComments = vi.fn(async () => []);
  getTree = vi.fn(async () => ({ sha: "source-tree", truncated: false, tree: [{ path: "src/a.ts", type: "blob", mode: "100755" }] }));
  listPullsByHead = vi.fn(async () => this.pulls);
  getRef = vi.fn(async () => null);
  createBlob = vi.fn(async () => ({ sha: "blob" }));
  createTree = vi.fn(async () => ({ sha: "tree" }));
  createCommit = vi.fn(async () => ({ sha: "commit" }));
  createRef = vi.fn(async () => ({ ref: "ref", object: { sha: "commit", type: "commit" } }));
  createPull = vi.fn(async (_scope: ReviewScope, input: { title: string; head: string; base: string; body: string }) =>
    pull({ number: 8, html_url: "https://example.test/8", title: input.title, body: input.body, base: { sha: scope.headSha, ref: input.base }, head: { sha: "c".repeat(40), ref: input.head, repo: { full_name: "NicolaiSchmid/nunc-immo" } } }),
  );
}

describe("stacked review pull requests", () => {
  it("creates a commit and PR on the reviewed branch", async () => {
    const client = new StackGitHub();
    const created = await createStackedReviewPull(client as unknown as GitHubClient, scope, result);
    expect(created).toMatchObject({ status: "created", round: 1 });
    expect(client.createTree).toHaveBeenCalledWith(scope, "source-tree", [{ path: "src/a.ts", sha: "blob", mode: "100755" }]);
    expect(client.createPull).toHaveBeenCalledWith(scope, expect.objectContaining({ base: "feature" }));
    expect(parseStackMarker(created.status === "created" ? created.pull.body : null)).toEqual({ root: 7, round: 1, parent: 7 });
  });

  it("continues marker rounds and skips empty or fork changes", async () => {
    const client = new StackGitHub();
    client.getPull.mockResolvedValue(pull({ number: 8, body: stackMarker(7, 1, 7) }));
    await expect(createStackedReviewPull(client as unknown as GitHubClient, { ...scope, number: 8 }, result)).resolves.toMatchObject({ round: 2 });
    await expect(createStackedReviewPull(client as unknown as GitHubClient, scope, { ...result, changes: [] })).resolves.toEqual({ status: "skipped", reason: "no_changes" });
    await expect(createStackedReviewPull(client as unknown as GitHubClient, { ...scope, fork: "true" }, result)).resolves.toEqual({ status: "skipped", reason: "fork" });
  });
});
