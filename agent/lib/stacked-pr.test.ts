import { describe, expect, it, vi } from "vitest";
import type { GitHubClient, PullRequest } from "./github.js";
import type { ReviewResult } from "./result.js";
import type { ReviewScope } from "./scope.js";
import { compensateStackedReviewPull, createStackedReviewPull, parseStackMarker, stackMarker } from "./stacked-pr.js";

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
  title: "Feature", body: null, state: "open", user: { login: "eve-bot" },
  base: { sha: scope.baseSha, ref: "main" },
  head: { sha: scope.headSha, ref: "feature", repo: { full_name: "NicolaiSchmid/nunc-immo" } },
  ...overrides,
});

class StackGitHub {
  pulls: PullRequest[] = [];
  headSha = scope.headSha;
  ref: { ref: string; object: { sha: string; type: string } } | null = null;
  changeHeadAfterRef = false;
  changeHeadAfterPull = false;
  getPull = vi.fn(async () => pull({ head: { ...pull().head, sha: this.headSha } }));
  getAuthenticatedLogin = vi.fn(async () => "eve-bot");
  listPullFiles = vi.fn(async () => [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+broken" }]);
  listReviewComments = vi.fn(async () => []);
  getTree = vi.fn(async (_scope: ReviewScope, _revision: "base" | "head") => ({ sha: "source-tree", truncated: false, tree: [{ path: "src/a.ts", type: "blob", mode: "100755" }] }));
  listPullsByHead = vi.fn(async () => this.pulls);
  getRef = vi.fn(async () => this.ref);
  createBlob = vi.fn(async () => ({ sha: "blob" }));
  createTree = vi.fn(async () => ({ sha: "tree" }));
  createCommit = vi.fn(async () => ({ sha: "commit" }));
  getCommit = vi.fn(async (_scope: ReviewScope, sha: string) => ({
    sha,
    tree: { sha: "tree" },
    parents: [{ sha: sha === scope.headSha ? scope.baseSha : scope.headSha }],
  }));
  createRef = vi.fn(async () => {
    this.ref = { ref: "ref", object: { sha: "commit", type: "commit" } };
    if (this.changeHeadAfterRef) this.headSha = "d".repeat(40);
    return this.ref;
  });
  deleteRef = vi.fn(async () => { this.ref = null; });
  closePull = vi.fn(async () => pull());
  createPull = vi.fn(async (_scope: ReviewScope, input: { title: string; head: string; base: string; body: string }) => {
    const created = pull({ number: 8, html_url: "https://example.test/8", title: input.title, body: input.body, base: { sha: scope.headSha, ref: input.base }, head: { sha: "commit", ref: input.head, repo: { full_name: "NicolaiSchmid/nunc-immo" } } });
    if (this.changeHeadAfterPull) this.headSha = "d".repeat(40);
    return created;
  });
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
    const parentBranch = `eve/review-7-round-1-${scope.baseSha.slice(0, 7)}`;
    client.getPull.mockResolvedValue(pull({ number: 8, body: stackMarker(7, 1, 7), head: { ...pull().head, ref: parentBranch } }));
    await expect(createStackedReviewPull(client as unknown as GitHubClient, { ...scope, number: 8, headRef: parentBranch }, result)).resolves.toMatchObject({ round: 2 });
    await expect(createStackedReviewPull(client as unknown as GitHubClient, scope, { ...result, changes: [] })).resolves.toEqual({ status: "skipped", reason: "no_changes" });
    await expect(createStackedReviewPull(client as unknown as GitHubClient, { ...scope, fork: "true" }, result)).resolves.toEqual({ status: "skipped", reason: "fork" });
  });

  it("rejects partial finding coverage and non-blob replacements", async () => {
    const client = new StackGitHub();
    const secondFinding = { ...result.findings[0]!, path: "src/b.ts", title: "Fix B" };
    client.listPullFiles.mockResolvedValue([
      ...(await client.listPullFiles()),
      { filename: "src/b.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+broken" },
    ]);
    await expect(createStackedReviewPull(client as unknown as GitHubClient, scope, { ...result, findings: [...result.findings, secondFinding] })).rejects.toThrow("paths must match");

    client.getTree.mockResolvedValue({ sha: "source-tree", truncated: false, tree: [{ path: "src/a.ts", type: "commit", mode: "160000" }] });
    await expect(createStackedReviewPull(client as unknown as GitHubClient, scope, result)).rejects.toThrow("cannot replace commit entry");

    client.getTree.mockResolvedValue({ sha: "source-tree", truncated: false, tree: [{ path: "src/a.ts", type: "blob", mode: "120000" }] });
    await expect(createStackedReviewPull(client as unknown as GitHubClient, scope, result)).rejects.toThrow("mode 120000");
  });

  it("restores a deleted regular file with its base-tree mode", async () => {
    const client = new StackGitHub();
    client.listPullFiles.mockResolvedValue([{ filename: "src/a.ts", status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-broken" }]);
    client.getTree.mockImplementation(async (_scope: ReviewScope, revision: "base" | "head") =>
      revision === "head"
        ? { sha: "source-tree", truncated: false, tree: [] }
        : { sha: "base-tree", truncated: false, tree: [{ path: "src/a.ts", type: "blob" as const, mode: "100755" }] },
    );
    await createStackedReviewPull(client as unknown as GitHubClient, { ...scope, baseSha: scope.baseSha }, { ...result, findings: [{ ...result.findings[0]!, side: "LEFT" }] });
    expect(client.createTree).toHaveBeenCalledWith(scope, "source-tree", [{ path: "src/a.ts", sha: "blob", mode: "100755" }]);
  });

  it("does not stack closed pulls or trust contributor-supplied markers", async () => {
    const closed = new StackGitHub();
    closed.getPull.mockResolvedValue(pull({ state: "closed" }));
    await expect(createStackedReviewPull(closed as unknown as GitHubClient, scope, result)).resolves.toEqual({ status: "skipped", reason: "closed" });
    expect(closed.createBlob).not.toHaveBeenCalled();

    const spoofed = new StackGitHub();
    spoofed.getPull.mockResolvedValue(pull({ body: stackMarker(99, 3, 1), user: { login: "contributor" } }));
    await expect(createStackedReviewPull(spoofed as unknown as GitHubClient, scope, result)).resolves.toMatchObject({ round: 1 });
  });

  it("rejects unverified recovered refs and pull requests", async () => {
    const badRef = new StackGitHub();
    badRef.ref = { ref: "ref", object: { sha: "foreign", type: "commit" } };
    badRef.getCommit.mockResolvedValue({ sha: "foreign", tree: { sha: "foreign-tree" }, parents: [{ sha: scope.headSha }] });
    await expect(createStackedReviewPull(badRef as unknown as GitHubClient, scope, result)).rejects.toThrow("expected fix commit");

    const badPull = new StackGitHub();
    badPull.ref = { ref: "ref", object: { sha: "commit", type: "commit" } };
    badPull.pulls = [pull({ number: 8, user: { login: "contributor" } })];
    await expect(createStackedReviewPull(badPull as unknown as GitHubClient, scope, result)).rejects.toThrow("ownership validation");
  });

  it("compensates only an authenticated open stacked pull", async () => {
    const client = new StackGitHub();
    const branch = `eve/review-7-round-1-${scope.headSha.slice(0, 7)}`;
    const stacked = pull({
      number: 8,
      body: stackMarker(7, 1, 7),
      head: { ...pull().head, sha: "commit", ref: branch },
    });
    client.getPull.mockResolvedValue(stacked);
    client.ref = { ref: branch, object: { sha: "commit", type: "commit" } };
    await compensateStackedReviewPull(client as unknown as GitHubClient, scope, {
      pull: stacked,
      branch,
      refSha: "commit",
    });
    expect(client.closePull).toHaveBeenCalledWith(scope, 8);
    expect(client.deleteRef).toHaveBeenCalledWith(scope, branch);
  });

  it("deletes its branch when pull creation fails without recovery", async () => {
    const client = new StackGitHub();
    client.createPull.mockRejectedValue(new Error("permission denied"));
    await expect(createStackedReviewPull(client as unknown as GitHubClient, scope, result)).rejects.toThrow("permission denied");
    expect(client.deleteRef).toHaveBeenCalledWith(scope, expect.stringContaining("eve/review-7-round-1"));
  });

  it("skips no-op trees and compensates head changes", async () => {
    const noOp = new StackGitHub();
    noOp.createTree.mockResolvedValue({ sha: "source-tree" });
    await expect(createStackedReviewPull(noOp as unknown as GitHubClient, scope, result)).resolves.toEqual({ status: "skipped", reason: "no_changes" });
    expect(noOp.createCommit).not.toHaveBeenCalled();

    const beforePull = new StackGitHub();
    beforePull.changeHeadAfterRef = true;
    await expect(createStackedReviewPull(beforePull as unknown as GitHubClient, scope, result)).resolves.toEqual({ status: "skipped", reason: "stale_head" });
    expect(beforePull.deleteRef).toHaveBeenCalled();
    expect(beforePull.createPull).not.toHaveBeenCalled();

    const afterPull = new StackGitHub();
    afterPull.changeHeadAfterPull = true;
    await expect(createStackedReviewPull(afterPull as unknown as GitHubClient, scope, result)).resolves.toEqual({ status: "skipped", reason: "stale_head" });
    expect(afterPull.closePull).toHaveBeenCalledWith(scope, 8);
    expect(afterPull.deleteRef).toHaveBeenCalled();
  });
});
