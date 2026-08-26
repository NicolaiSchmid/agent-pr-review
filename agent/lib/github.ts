import { env, requireEnv } from "./env.js";
import type { ReviewScope } from "./scope.js";

export type PullRequest = {
  number: number;
  changed_files: number;
  draft: boolean;
  html_url: string;
  title: string;
  body: string | null;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string; repo: { full_name: string } | null };
};

export type GitRef = { ref: string; object: { sha: string; type: string } };

export type PullFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export type GitHubUser = { login: string };
export type IssueComment = { id: number; body: string; user: GitHubUser | null };
export type Review = {
  id: number;
  body: string | null;
  commit_id: string | null;
  state: "PENDING" | "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | string;
  user: GitHubUser | null;
};
export type ReviewComment = {
  id: number;
  body: string;
  commit_id: string;
  pull_request_review_id?: number | null;
  user: GitHubUser | null;
};

const authenticatedUsers = new Map<string, Promise<string>>();

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(message);
  }
}

export class IncompletePullFilesError extends Error {
  constructor(readonly changedFiles: number, message?: string) {
    super(
      message ??
        `Pull request changes ${changedFiles} files; GitHub exposes at most 3000 through the files API. Refusing an incomplete review.`,
    );
  }
}

export class GitHubClient {
  constructor(
    private readonly token = requireEnv("githubToken"),
    private readonly baseUrl = env.githubApiUrl,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "user-agent": "eve-pr-review-agent",
        "x-github-api-version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const responseBody = await response.text();
      throw new GitHubError(
        `GitHub ${method} ${path} failed with ${response.status}`,
        response.status,
        responseBody.slice(0, 2_000),
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async paginate<T>(
    path: string,
    options: { expectedCount?: number; maxPages?: number } = {},
  ): Promise<T[]> {
    const output: T[] = [];
    const maxPages = options.maxPages ?? 100;
    for (let page = 1; page <= maxPages; page += 1) {
      const join = path.includes("?") ? "&" : "?";
      const items = await this.request<T[]>(
        "GET",
        `${path}${join}per_page=100&page=${page}`,
      );
      output.push(...items);
      if (options.expectedCount !== undefined) {
        if (output.length === options.expectedCount) return output;
        if (output.length > options.expectedCount || items.length < 100) {
          throw new IncompletePullFilesError(
            options.expectedCount,
            `GitHub reported ${options.expectedCount} changed files but returned ${output.length}. Refusing an incomplete review.`,
          );
        }
      } else if (items.length < 100) {
        return output;
      }
    }
    if (options.expectedCount !== undefined) {
      throw new IncompletePullFilesError(
        options.expectedCount,
        `GitHub file pagination stopped at ${output.length} of ${options.expectedCount}. Refusing an incomplete review.`,
      );
    }
    throw new Error(`GitHub pagination exceeded safety limit for ${path}`);
  }

  getAuthenticatedLogin() {
    const key = `${this.baseUrl}\u0000${this.token}`;
    let login = authenticatedUsers.get(key);
    if (!login) {
      login = this.request<GitHubUser>("GET", "/user").then((user) =>
        user.login.toLowerCase(),
      );
      authenticatedUsers.set(key, login);
      login.catch(() => authenticatedUsers.delete(key));
    }
    return login;
  }

  getPull(scope: Pick<ReviewScope, "owner" | "repo" | "number">) {
    return this.request<PullRequest>(
      "GET",
      `/repos/${scope.owner}/${scope.repo}/pulls/${scope.number}`,
    );
  }

  async getRef(
    scope: Pick<ReviewScope, "owner" | "repo">,
    ref: string,
  ) {
    try {
      return await this.request<GitRef>(
        "GET",
        `/repos/${scope.owner}/${scope.repo}/git/ref/heads/${encodeURIComponent(ref)}`,
      );
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  createBlob(scope: Pick<ReviewScope, "owner" | "repo">, content: string) {
    return this.request<{ sha: string }>(
      "POST",
      `/repos/${scope.owner}/${scope.repo}/git/blobs`,
      { content, encoding: "utf-8" },
    );
  }

  createTree(
    scope: Pick<ReviewScope, "owner" | "repo">,
    baseTree: string,
    entries: Array<{ path: string; sha: string; mode?: string }>,
  ) {
    return this.request<{ sha: string }>(
      "POST",
      `/repos/${scope.owner}/${scope.repo}/git/trees`,
      {
        base_tree: baseTree,
        tree: entries.map((entry) => ({
          ...entry,
          mode: entry.mode ?? "100644",
          type: "blob",
        })),
      },
    );
  }

  createCommit(
    scope: Pick<ReviewScope, "owner" | "repo">,
    input: { message: string; tree: string; parent: string },
  ) {
    return this.request<{ sha: string }>(
      "POST",
      `/repos/${scope.owner}/${scope.repo}/git/commits`,
      { message: input.message, tree: input.tree, parents: [input.parent] },
    );
  }

  createRef(
    scope: Pick<ReviewScope, "owner" | "repo">,
    ref: string,
    sha: string,
  ) {
    return this.request<GitRef>(
      "POST",
      `/repos/${scope.owner}/${scope.repo}/git/refs`,
      { ref: `refs/heads/${ref}`, sha },
    );
  }

  deleteRef(scope: Pick<ReviewScope, "owner" | "repo">, ref: string) {
    return this.request<void>(
      "DELETE",
      `/repos/${scope.owner}/${scope.repo}/git/refs/heads/${encodeURIComponent(ref)}`,
    );
  }

  listPullsByHead(
    scope: Pick<ReviewScope, "owner" | "repo">,
    branch: string,
  ) {
    return this.paginate<PullRequest>(
      `/repos/${scope.owner}/${scope.repo}/pulls?state=all&head=${encodeURIComponent(`${scope.owner}:${branch}`)}`,
      { maxPages: 2 },
    );
  }

  createPull(
    scope: Pick<ReviewScope, "owner" | "repo">,
    input: { title: string; head: string; base: string; body: string },
  ) {
    return this.request<PullRequest>(
      "POST",
      `/repos/${scope.owner}/${scope.repo}/pulls`,
      { ...input, draft: false },
    );
  }

  closePull(scope: Pick<ReviewScope, "owner" | "repo">, number: number) {
    return this.request<PullRequest>(
      "PATCH",
      `/repos/${scope.owner}/${scope.repo}/pulls/${number}`,
      { state: "closed" },
    );
  }

  listPullFiles(
    scope: Pick<ReviewScope, "owner" | "repo" | "number">,
    changedFiles: number,
  ) {
    if (changedFiles > 3_000) throw new IncompletePullFilesError(changedFiles);
    if (changedFiles === 0) return Promise.resolve([] as PullFile[]);
    return this.paginate<PullFile>(
      `/repos/${scope.owner}/${scope.repo}/pulls/${scope.number}/files`,
      { expectedCount: changedFiles, maxPages: 30 },
    );
  }

  listIssueComments(scope: Pick<ReviewScope, "owner" | "repo" | "number">) {
    return this.paginate<IssueComment>(
      `/repos/${scope.owner}/${scope.repo}/issues/${scope.number}/comments`,
    );
  }

  getIssueComment(scope: ReviewScope, id: number) {
    return this.request<IssueComment>(
      "GET",
      `/repos/${scope.owner}/${scope.repo}/issues/comments/${id}`,
    );
  }

  createIssueComment(scope: ReviewScope, body: string) {
    return this.request<IssueComment>(
      "POST",
      `/repos/${scope.owner}/${scope.repo}/issues/${scope.number}/comments`,
      { body },
    );
  }

  updateIssueComment(scope: ReviewScope, id: number, body: string) {
    return this.request<IssueComment>(
      "PATCH",
      `/repos/${scope.owner}/${scope.repo}/issues/comments/${id}`,
      { body },
    );
  }

  deleteIssueComment(scope: ReviewScope, id: number) {
    return this.request<void>(
      "DELETE",
      `/repos/${scope.owner}/${scope.repo}/issues/comments/${id}`,
    );
  }

  listReviews(scope: ReviewScope) {
    return this.paginate<Review>(
      `/repos/${scope.owner}/${scope.repo}/pulls/${scope.number}/reviews`,
    );
  }

  listReviewComments(scope: ReviewScope) {
    return this.paginate<ReviewComment>(
      `/repos/${scope.owner}/${scope.repo}/pulls/${scope.number}/comments`,
    );
  }

  listReviewCommentsForReview(scope: ReviewScope, reviewId: number) {
    return this.paginate<ReviewComment>(
      `/repos/${scope.owner}/${scope.repo}/pulls/${scope.number}/reviews/${reviewId}/comments`,
    );
  }

  getTree(scope: ReviewScope, revision: "base" | "head") {
    const ref = revision === "base" ? scope.baseSha : scope.headSha;
    return this.request<{
      sha: string;
      truncated: boolean;
      tree: Array<{ path: string; type: "blob" | "tree" | "commit"; mode: string; size?: number }>;
    }>(
      "GET",
      `/repos/${scope.owner}/${scope.repo}/git/trees/${ref}?recursive=1`,
    );
  }

  createPendingReview(
    scope: ReviewScope,
    input: {
      body: string;
      comments: Array<{
        path: string;
        line: number;
        side: "LEFT" | "RIGHT";
        body: string;
      }>;
    },
  ) {
    return this.request<Review>(
      "POST",
      `/repos/${scope.owner}/${scope.repo}/pulls/${scope.number}/reviews`,
      { ...input, commit_id: scope.headSha },
    );
  }

  getReview(scope: ReviewScope, id: number) {
    return this.request<Review>(
      "GET",
      `/repos/${scope.owner}/${scope.repo}/pulls/${scope.number}/reviews/${id}`,
    );
  }

  updateReview(scope: ReviewScope, id: number, body: string) {
    return this.request<Review>(
      "PUT",
      `/repos/${scope.owner}/${scope.repo}/pulls/${scope.number}/reviews/${id}`,
      { body },
    );
  }

  submitReview(scope: ReviewScope, id: number, body: string) {
    return this.request<Review>(
      "POST",
      `/repos/${scope.owner}/${scope.repo}/pulls/${scope.number}/reviews/${id}/events`,
      { event: "COMMENT", body },
    );
  }

  deletePendingReview(scope: ReviewScope, id: number) {
    return this.request<Review>(
      "DELETE",
      `/repos/${scope.owner}/${scope.repo}/pulls/${scope.number}/reviews/${id}`,
    );
  }

  deleteReviewComment(scope: ReviewScope, commentId: number) {
    return this.request<void>(
      "DELETE",
      `/repos/${scope.owner}/${scope.repo}/pulls/comments/${commentId}`,
    );
  }

  async readFile(scope: ReviewScope, path: string, revision: "base" | "head") {
    const ref = revision === "base" ? scope.baseSha : scope.headSha;
    const safePath = path
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const response = await fetch(
      `${this.baseUrl}/repos/${scope.owner}/${scope.repo}/contents/${safePath}?ref=${ref}`,
      {
        headers: {
          accept: "application/vnd.github.raw+json",
          authorization: `Bearer ${this.token}`,
          "user-agent": "eve-pr-review-agent",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new GitHubError(
        `GitHub file read failed with ${response.status}`,
        response.status,
        (await response.text()).slice(0, 2_000),
      );
    }
    return await response.text();
  }
}
