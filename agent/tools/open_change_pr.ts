import { createHash } from "node:crypto";
import { connect } from "@vercel/connect/eve";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { env } from "../lib/env.js";
import { requireRepositoryPermission } from "../lib/repository-authorization.js";

const githubAuth = connect({
  connector: env.githubConnector,
  principalType: "app",
});

const inputSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  baseBranch: z.string().min(1).max(200).optional(),
  branch: z.string().regex(/^eve\/[A-Za-z0-9._/-]{1,180}$/),
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(60_000),
  commitMessage: z.string().min(1).max(256),
  files: z.array(z.object({
    path: z.string().min(1).max(1_000),
    content: z.string().max(200_000),
  })).min(1).max(20),
});

export default defineTool({
  description:
    "Create a draft pull request containing complete file replacements in any repository accessible to the configured GitHub connector. Always requires human approval and never merges or deploys.",
  inputSchema,
  approval: always(),
  async execute(input, ctx) {
    if (new Set(input.files.map((file) => file.path)).size !== input.files.length) {
      throw new Error("Duplicate file paths are not allowed");
    }
    if (input.files.some((file) => file.path.startsWith("/") || file.path.split("/").includes(".."))) {
      throw new Error("File paths must stay within the repository");
    }

    const { token } = await ctx.getToken(githubAuth);
    await requireRepositoryPermission(ctx, token, input.owner, input.repo, "write");
    const root = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    class GitHubRequestError extends Error {
      constructor(readonly status: number, message: string) {
        super(message);
      }
    }
    const request = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => {
      const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "eve-engineering-agent",
          "x-github-api-version": "2022-11-28",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ctx.abortSignal,
      });
      if (!response.ok) {
        if (response.status === 401) ctx.requireAuth(githubAuth);
        throw new GitHubRequestError(
          response.status,
          `GitHub ${method} ${path} failed with ${response.status}: ${(await response.text()).slice(0, 500)}`,
        );
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    };

    const branchPath = input.branch.split("/").map(encodeURIComponent).join("/");
    const listPulls = (baseBranch?: string) => request<Array<{
      number: number;
      html_url: string;
      head: { sha: string };
      draft: boolean;
      title: string;
      body: string | null;
    }>>(
      "GET",
      `${root}/pulls?state=open&head=${encodeURIComponent(`${input.owner}:${input.branch}`)}${baseBranch ? `&base=${encodeURIComponent(baseBranch)}` : ""}`,
    );
    const existingPull = async (baseBranch?: string) => (await listPulls(baseBranch))[0];
    const createPull = async (baseBranch: string, commitSha: string, createdRef: boolean) => {
      try {
        const pull = await request<{ number: number; html_url: string }>("POST", `${root}/pulls`, {
          title: input.title,
          body: input.body,
          head: input.branch,
          base: baseBranch,
          draft: true,
        });
        const created = await request<{
          number: number;
          html_url: string;
          head: { sha: string };
          draft: boolean;
          title: string;
          body: string | null;
        }>("GET", `${root}/pulls/${pull.number}`);
        if (!created.draft) throw new Error("The created pull request is no longer a draft");
        if (created.title !== input.title || (created.body ?? "") !== input.body) {
          throw new Error("The created pull request metadata no longer matches the approved request");
        }
        await assertMatchingCommit(created.head.sha);
        return { ...created, commitSha: created.head.sha };
      } catch (error) {
        const recovered = await existingPull(baseBranch);
        if (recovered) {
          if (!recovered.draft) throw new Error("Refusing to recover a pull request that is no longer a draft");
          if (recovered.title !== input.title || (recovered.body ?? "") !== input.body) {
            throw new Error("Refusing to recover a pull request with different title or body");
          }
          await assertMatchingCommit(recovered.head.sha);
          return {
            number: recovered.number,
            html_url: recovered.html_url,
            commitSha: recovered.head.sha,
            draft: recovered.draft,
          };
        }
        throw error;
      }
    };

    const repository = await request<{ default_branch: string }>("GET", root);
    const baseBranch = input.baseBranch ?? repository.default_branch;
    const baseRef = await request<{ object: { sha: string } }>(
      "GET",
      `${root}/git/ref/heads/${baseBranch.split("/").map(encodeURIComponent).join("/")}`,
    );
    const fingerprintFor = (baseSha: string) => createHash("sha256").update(JSON.stringify({
      owner: input.owner.toLowerCase(),
      repo: input.repo.toLowerCase(),
      baseBranch,
      baseSha,
      branch: input.branch,
      title: input.title,
      body: input.body,
      commitMessage: input.commitMessage,
      files: input.files,
    })).digest("hex");
    const commitMessageFor = (baseSha: string) =>
      `${input.commitMessage}\n\nEve-Change-Fingerprint: ${fingerprintFor(baseSha)}`;
    const buildExpectedTree = async (baseSha: string) => {
      const baseCommit = await request<{ tree: { sha: string } }>(
        "GET", `${root}/git/commits/${baseSha}`,
      );
      const baseTree = await request<{
        truncated: boolean;
        tree: Array<{ path: string; mode: string; type: string }>;
      }>("GET", `${root}/git/trees/${baseCommit.tree.sha}?recursive=1`);
      if (baseTree.truncated) {
        throw new Error("GitHub returned a truncated base tree; refusing to guess file modes");
      }
      const entries = new Map(baseTree.tree.map((entry) => [entry.path, entry]));
      for (const file of input.files) {
        const existing = entries.get(file.path);
        if (existing && existing.type !== "blob") {
          throw new Error(`Replacement path ${file.path} is an existing ${existing.type}`);
        }
        const segments = file.path.split("/");
        for (let index = 1; index < segments.length; index += 1) {
          const ancestor = entries.get(segments.slice(0, index).join("/"));
          if (ancestor && ancestor.type !== "tree") {
            throw new Error(`Replacement path ${file.path} descends from an existing ${ancestor.type}`);
          }
        }
        if (input.files.some(
          (candidate) => candidate.path !== file.path &&
            (candidate.path.startsWith(`${file.path}/`) || file.path.startsWith(`${candidate.path}/`)),
        )) {
          throw new Error("Replacement paths cannot be ancestors or descendants of each other");
        }
      }
      const treeEntries = [];
      for (const file of input.files) {
        const blob = await request<{ sha: string }>("POST", `${root}/git/blobs`, {
          content: file.content,
          encoding: "utf-8",
        });
        treeEntries.push({
          path: file.path,
          mode: entries.get(file.path)?.mode ?? "100644",
          type: "blob",
          sha: blob.sha,
        });
      }
      return await request<{ sha: string }>("POST", `${root}/git/trees`, {
        base_tree: baseCommit.tree.sha,
        tree: treeEntries,
      });
    };
    const commitMessage = commitMessageFor(baseRef.object.sha);
    const tree = await buildExpectedTree(baseRef.object.sha);
    const assertMatchingCommit = async (sha: string) => {
      const candidate = await request<{
        message: string;
        parents: Array<{ sha: string }>;
        tree: { sha: string };
      }>("GET", `${root}/git/commits/${sha}`);
      const candidateBase = candidate.parents[0]?.sha;
      const expectedTree = candidateBase ? await buildExpectedTree(candidateBase) : null;
      if (
        !candidateBase ||
        candidate.parents.length !== 1 ||
        candidate.message !== commitMessageFor(candidateBase) ||
        candidate.tree.sha !== expectedTree?.sha
      ) {
        throw new Error(
          `Branch ${input.branch} already exists but does not match this approved change`,
        );
      }
    };
    const alreadyOpen = await existingPull(baseBranch);
    if (alreadyOpen) {
      if (!alreadyOpen.draft) throw new Error("Refusing to recover a pull request that is no longer a draft");
      if (alreadyOpen.title !== input.title || (alreadyOpen.body ?? "") !== input.body) {
        throw new Error("Refusing to recover a pull request with different title or body");
      }
      await assertMatchingCommit(alreadyOpen.head.sha);
      return {
        owner: input.owner,
        repo: input.repo,
        number: alreadyOpen.number,
        url: alreadyOpen.html_url,
        branch: input.branch,
        commitSha: alreadyOpen.head.sha,
        draft: alreadyOpen.draft,
        recovered: true,
      };
    }
    try {
      const existingRef = await request<{ object: { sha: string } }>(
        "GET",
        `${root}/git/ref/heads/${branchPath}`,
      );
      await assertMatchingCommit(existingRef.object.sha);
      const pull = await createPull(baseBranch, existingRef.object.sha, false);
      return {
        owner: input.owner,
        repo: input.repo,
        number: pull.number,
        url: pull.html_url,
        branch: input.branch,
        commitSha: pull.commitSha,
        draft: pull.draft,
        recovered: true,
      };
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 404) throw error;
    }
    const commit = await request<{ sha: string }>("POST", `${root}/git/commits`, {
      message: commitMessage,
      tree: tree.sha,
      parents: [baseRef.object.sha],
    });
    let commitSha = commit.sha;
    let createdRef = true;
    try {
      await request("POST", `${root}/git/refs`, {
        ref: `refs/heads/${input.branch}`,
        sha: commit.sha,
      });
    } catch (error) {
      if (!(error instanceof GitHubRequestError) || error.status !== 422) throw error;
      const concurrent = await request<{ object: { sha: string } }>(
        "GET", `${root}/git/ref/heads/${branchPath}`,
      );
      await assertMatchingCommit(concurrent.object.sha);
      commitSha = concurrent.object.sha;
      createdRef = false;
    }
    const pull = await createPull(baseBranch, commitSha, createdRef);
    return {
      owner: input.owner,
      repo: input.repo,
      number: pull.number,
      url: pull.html_url,
      branch: input.branch,
      commitSha: pull.commitSha,
      draft: pull.draft,
      recovered: !createdRef,
    };
  },
});
