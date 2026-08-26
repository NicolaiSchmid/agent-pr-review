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
  if (bytes > env.maxReviewChangeBytes) {
    throw new Error(`Review changes exceed the ${env.maxReviewChangeBytes}-byte safety limit`);
  }
};

const existingPullForBranch = async (
  client: GitHubClient,
  scope: ReviewScope,
  branch: string,
) => (await client.listPullsByHead(scope, branch)).find((pull) => pull.state === "open") ?? null;

const headMatches = async (client: GitHubClient, scope: ReviewScope) => {
  const pull = await client.getPull(scope);
  return pull.state === "open" && pull.head.sha === scope.headSha;
};

const verifiedStackParent = async (
  client: GitHubClient,
  pull: PullRequest,
  login: string,
  scope: ReviewScope,
) => {
  const marker = parseStackMarker(pull.body);
  if (!marker || pull.user.login.toLowerCase() !== login) return null;
  const commit = await client.getCommit(scope, pull.head.sha);
  if (commit.parents.length !== 1) return null;
  const expectedBranch = `eve/review-${marker.root}-round-${marker.round}-${commit.parents[0]!.sha.slice(0, 7)}`;
  return pull.head.repo?.full_name.toLowerCase() ===
      `${scope.owner}/${scope.repo}`.toLowerCase() &&
    pull.head.ref === expectedBranch
    ? marker
    : null;
};

const verifyRecoveredRef = async (
  client: GitHubClient,
  scope: ReviewScope,
  sha: string,
  expectedTree: string,
) => {
  const commit = await client.getCommit(scope, sha);
  if (
    commit.tree.sha !== expectedTree ||
    commit.parents.length !== 1 ||
    commit.parents[0]?.sha !== scope.headSha
  ) {
    throw new Error("Recovered review branch does not contain the expected fix commit");
  }
};

const verifyRecoveredPull = (
  pull: PullRequest,
  login: string,
  scope: ReviewScope,
  branch: string,
  refSha: string,
  marker: string,
) => {
  if (
    pull.state !== "open" ||
    pull.user.login.toLowerCase() !== login ||
    pull.base.ref !== scope.headRef ||
    pull.head.ref !== branch ||
    pull.head.sha !== refSha ||
    !pull.body?.includes(marker)
  ) {
    throw new Error("Recovered review pull request failed ownership validation");
  }
};

const deleteOwnedRef = async (
  client: GitHubClient,
  scope: ReviewScope,
  branch: string,
  expectedSha: string,
) => {
  const current = await client.getRef(scope, branch);
  if (current?.object.sha === expectedSha) await client.deleteRef(scope, branch);
};

export const compensateStackedReviewPull = async (
  client: GitHubClient,
  scope: ReviewScope,
  stacked: {
    pull: PullRequest;
    branch: string;
    refSha: string;
  },
) => {
  const login = await client.getAuthenticatedLogin();
  const current = await client.getPull({ ...scope, number: stacked.pull.number });
  if (
    current.state === "open" &&
    current.user.login.toLowerCase() === login &&
    current.head.ref === stacked.branch &&
    current.head.sha === stacked.refSha &&
    current.body?.includes("<!-- eve-review-stack:")
  ) {
    await client.closePull(scope, current.number);
    await deleteOwnedRef(client, scope, stacked.branch, stacked.refSha);
  }
};

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
  if (pull.state !== "open") return { status: "skipped", reason: "closed" } as const;
  if (pull.head.sha !== scope.headSha) return { status: "skipped", reason: "stale_head" } as const;
  if (pull.changed_files > 3_000) {
    return { status: "skipped", reason: "incomplete_pull_files" } as const;
  }
  const login = await client.getAuthenticatedLogin();
  const [files, comments, sourceTree, baseTree] = await Promise.all([
    client.listPullFiles(scope, pull.changed_files),
    client.listReviewComments(scope),
    client.getTree(scope, "head"),
    client.getTree(scope, "base"),
  ]);
  if (sourceTree.truncated || baseTree.truncated) {
    throw new Error("Reviewed source tree is truncated");
  }
  const findings = validateAndDedupeFindings(
    scope.headSha,
    result.findings,
    files,
    comments.filter((comment) => comment.user?.login.toLowerCase() === login).map((comment) => comment.body),
  ).slice(0, Math.max(0, env.maxFindings));
  if (findings.length === 0) return { status: "skipped", reason: "no_valid_findings" } as const;
  const findingPaths = new Set(findings.map((finding) => finding.path));
  const changePaths = new Set(result.changes.map((change) => change.path));
  if (
    result.changes.some((change) => !findingPaths.has(change.path)) ||
    findings.some((finding) => !changePaths.has(finding.path))
  ) {
    throw new Error("Validated finding paths and review change paths must match");
  }
  const parent = await verifiedStackParent(client, pull, login, scope);
  const root = parent?.root ?? scope.number;
  const round = (parent?.round ?? 0) + 1;
  if (round > env.maxReviewRounds) {
    return { status: "skipped", reason: "max_rounds" } as const;
  }

  const branch = `eve/review-${root}-round-${round}-${scope.headSha.slice(0, 7)}`;
  const marker = stackMarker(root, round, scope.number);
  const entries = new Map(sourceTree.tree.map((entry) => [entry.path, entry]));
  const baseEntries = new Map(baseTree.tree.map((entry) => [entry.path, entry]));
  const fileStatuses = new Map(files.map((file) => [file.filename, file.status]));
  const modes = new Map<string, string>();
  for (const change of result.changes) {
    const headEntry = entries.get(change.path);
    const entry =
      headEntry ??
      (fileStatuses.get(change.path) === "removed"
        ? baseEntries.get(change.path)
        : undefined);
    if (!entry && fileStatuses.get(change.path) !== "added") {
      throw new Error(`Review change path is missing from the expected tree: ${change.path}`);
    }
    if (
      entry &&
      (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
    ) {
      throw new Error(
        `Review changes cannot replace ${entry.type} entry with mode ${entry.mode}: ${change.path}`,
      );
    }
    modes.set(change.path, entry?.mode ?? "100644");
  }
  const blobs = await Promise.all(
    result.changes.map(async (change) => ({
      path: change.path,
      sha: (await client.createBlob(scope, change.content)).sha,
      mode: modes.get(change.path),
    })),
  );
  const tree = await client.createTree(scope, sourceTree.sha, blobs);
  if (tree.sha === sourceTree.sha) {
    return { status: "skipped", reason: "no_changes" } as const;
  }

  let ref = await client.getRef(scope, branch);
  if (!ref) {
    const commit = await client.createCommit(scope, {
      message: `Address Eve review round ${round}`,
      tree: tree.sha,
      parent: scope.headSha,
    });
    if (!(await headMatches(client, scope))) {
      return { status: "skipped", reason: "stale_head" } as const;
    }
    try {
      ref = await client.createRef(scope, branch, commit.sha);
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 422) throw error;
      ref = await client.getRef(scope, branch);
      if (!ref) throw error;
    }
  }
  await verifyRecoveredRef(client, scope, ref.object.sha, tree.sha);

  if (!(await headMatches(client, scope))) {
    await deleteOwnedRef(client, scope, branch, ref.object.sha);
    return { status: "skipped", reason: "stale_head" } as const;
  }

  const recovered = await existingPullForBranch(client, scope, branch);
  if (recovered) {
    verifyRecoveredPull(recovered, login, scope, branch, ref.object.sha, marker);
    return {
      status: "existing",
      pull: recovered,
      round,
      branch,
      refSha: ref.object.sha,
    } as const;
  }
  const body = [
    marker,
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
  let created: PullRequest;
  try {
    created = await client.createPull(scope, {
      title: `[Eve review ${round}/${env.maxReviewRounds}] ${findings[0]!.title}`,
      head: branch,
      base: scope.headRef,
      body,
    });
  } catch (error) {
    const recoveredPull = await existingPullForBranch(client, scope, branch);
    if (!recoveredPull) {
      await deleteOwnedRef(client, scope, branch, ref.object.sha);
      throw error;
    }
    created = recoveredPull;
  }
  if (!(await headMatches(client, scope))) {
    await client.closePull(scope, created.number);
    await deleteOwnedRef(client, scope, branch, ref.object.sha);
    return { status: "skipped", reason: "stale_head" } as const;
  }
  verifyRecoveredPull(created, login, scope, branch, ref.object.sha, marker);
  return {
    status: "created",
    pull: created,
    round,
    branch,
    refSha: ref.object.sha,
  } as const;
};
