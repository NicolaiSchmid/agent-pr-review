import { env } from "./env.js";
import { validateAndDedupeFindings } from "./diff.js";
import { GitHubError, type GitHubClient, type PullRequest } from "./github.js";
import type { ReviewResult } from "./result.js";
import type { ReviewScope } from "./scope.js";

export const stackMarker = (root: number, round: number, parent: number) =>
  `<!-- eve-review-stack:root=${root};round=${round};parent=${parent} -->`;

export const parseStackMarker = (body: string | null | undefined) => {
  const match = /<!-- eve-review-stack:root=(\d+);round=(\d+);parent=(\d+) -->/.exec(
    body ?? "",
  );
  return match
    ? { root: Number(match[1]), round: Number(match[2]), parent: Number(match[3]) }
    : null;
};

const validateChanges = (result: ReviewResult) => {
  if (result.changes.length > 20) throw new Error("A review round may change at most 20 files");
  const seen = new Set<string>();
  let bytes = 0;
  for (const change of result.changes) {
    if (
      change.path.startsWith("/") ||
      change.path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Unsafe review change path: ${change.path}`);
    }
    if (seen.has(change.path)) throw new Error(`Duplicate review change path: ${change.path}`);
    seen.add(change.path);
    bytes += Buffer.byteLength(change.content);
  }
  if (bytes > 500_000) throw new Error("Review changes exceed the 500 KB safety limit");
};

const existingPullForBranch = async (
  client: GitHubClient,
  scope: ReviewScope,
  branch: string,
) => (await client.listPullsByHead(scope, branch))[0] ?? null;

export const createStackedReviewPull = async (
  client: GitHubClient,
  scope: ReviewScope,
  result: ReviewResult,
) => {
  if (scope.fork === "true") return { status: "skipped", reason: "fork" } as const;
  if (result.findings.length === 0 || result.changes.length === 0) {
    return { status: "skipped", reason: "no_changes" } as const;
  }
  validateChanges(result);

  const pull = await client.getPull(scope);
  if (pull.head.sha !== scope.headSha) return { status: "skipped", reason: "stale_head" } as const;
  if (pull.changed_files > 3_000) {
    return { status: "skipped", reason: "incomplete_pull_files" } as const;
  }
  const login = await client.getAuthenticatedLogin();
  const [files, comments, sourceTree] = await Promise.all([
    client.listPullFiles(scope, pull.changed_files),
    client.listReviewComments(scope),
    client.getTree(scope, "head"),
  ]);
  if (sourceTree.truncated) throw new Error("Reviewed source tree is truncated");
  const findings = validateAndDedupeFindings(
    scope.headSha,
    result.findings,
    files,
    comments.filter((comment) => comment.user?.login.toLowerCase() === login).map((comment) => comment.body),
  ).slice(0, Math.max(0, env.maxFindings));
  if (findings.length === 0) return { status: "skipped", reason: "no_valid_findings" } as const;
  const findingPaths = new Set(findings.map((finding) => finding.path));
  if (result.changes.some((change) => !findingPaths.has(change.path))) {
    throw new Error("Every review change must correspond to a validated finding path");
  }
  const parent = parseStackMarker(pull.body);
  const root = parent?.root ?? scope.number;
  const round = (parent?.round ?? 0) + 1;
  if (round > env.maxReviewRounds) {
    return { status: "skipped", reason: "max_rounds" } as const;
  }

  const branch = `eve/review-${root}-round-${round}-${scope.headSha.slice(0, 7)}`;
  const existing = await existingPullForBranch(client, scope, branch);
  if (existing) return { status: "existing", pull: existing, round } as const;

  let ref = await client.getRef(scope, branch);
  if (!ref) {
    const modes = new Map(
      sourceTree.tree
        .filter((entry) => entry.type === "blob")
        .map((entry) => [entry.path, entry.mode]),
    );
    const blobs = await Promise.all(
      result.changes.map(async (change) => ({
        path: change.path,
        sha: (await client.createBlob(scope, change.content)).sha,
        mode: modes.get(change.path),
      })),
    );
    const tree = await client.createTree(scope, sourceTree.sha, blobs);
    const commit = await client.createCommit(scope, {
      message: `Address Eve review round ${round}`,
      tree: tree.sha,
      parent: scope.headSha,
    });
    try {
      ref = await client.createRef(scope, branch, commit.sha);
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 422) throw error;
      ref = await client.getRef(scope, branch);
      if (!ref) throw error;
    }
  }

  const recovered = await existingPullForBranch(client, scope, branch);
  if (recovered) return { status: "existing", pull: recovered, round } as const;
  const body = [
    stackMarker(root, round, scope.number),
    `Stacks on #${scope.number}. Root review PR: #${root}.`,
    "",
    result.summary,
    "",
    "### Addressed findings",
    ...findings.map((finding) => `- **${finding.severity}:** ${finding.title}`),
    "",
    "### Checks",
    ...(result.tests.length
      ? result.tests.map((test) => `- ${test.result.toUpperCase()} \`${test.command}\`${test.details ? ` — ${test.details}` : ""}`)
      : ["- None reported"]),
  ].join("\n");
  const created = await client.createPull(scope, {
    title: `[Eve review ${round}/${env.maxReviewRounds}] ${findings[0]!.title}`,
    head: branch,
    base: scope.headRef,
    body,
  });
  return { status: "created", pull: created, round } as const;
};
