import { connect } from "@vercel/connect/eve";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { env } from "../lib/env.js";

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
  draft: z.boolean().default(true),
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
    const root = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
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
        throw new Error(`GitHub ${method} ${path} failed with ${response.status}: ${(await response.text()).slice(0, 500)}`);
      }
      return (await response.json()) as T;
    };

    const repository = await request<{ default_branch: string }>("GET", root);
    const baseBranch = input.baseBranch ?? repository.default_branch;
    const baseRef = await request<{ object: { sha: string } }>(
      "GET",
      `${root}/git/ref/heads/${baseBranch.split("/").map(encodeURIComponent).join("/")}`,
    );
    const baseCommit = await request<{ tree: { sha: string } }>(
      "GET",
      `${root}/git/commits/${baseRef.object.sha}`,
    );
    const treeEntries = [];
    for (const file of input.files) {
      const blob = await request<{ sha: string }>("POST", `${root}/git/blobs`, {
        content: file.content,
        encoding: "utf-8",
      });
      treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const tree = await request<{ sha: string }>("POST", `${root}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree: treeEntries,
    });
    const commit = await request<{ sha: string }>("POST", `${root}/git/commits`, {
      message: input.commitMessage,
      tree: tree.sha,
      parents: [baseRef.object.sha],
    });
    await request("POST", `${root}/git/refs`, {
      ref: `refs/heads/${input.branch}`,
      sha: commit.sha,
    });
    const pull = await request<{ number: number; html_url: string }>("POST", `${root}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.branch,
      base: baseBranch,
      draft: input.draft,
    });
    return {
      owner: input.owner,
      repo: input.repo,
      number: pull.number,
      url: pull.html_url,
      branch: input.branch,
      commitSha: commit.sha,
      draft: input.draft,
    };
  },
});
