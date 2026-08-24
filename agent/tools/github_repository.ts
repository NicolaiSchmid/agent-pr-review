import { connect } from "@vercel/connect/eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { readResponseTextLimited } from "../lib/bounded-response.js";
import { env } from "../lib/env.js";
import { requireRepositoryPermission } from "../lib/repository-authorization.js";

const githubAuth = connect({
  connector: env.githubConnector,
  principalType: "app",
});

const repository = {
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
};

const inputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("metadata"), ...repository }),
  z.object({ operation: z.literal("pull_request"), ...repository, number: z.number().int().positive() }),
  z.object({ operation: z.literal("tree"), ...repository, ref: z.string().min(1).max(200) }),
  z.object({ operation: z.literal("read_file"), ...repository, ref: z.string().min(1).max(200), path: z.string().min(1).max(1_000) }),
  z.object({ operation: z.literal("checks"), ...repository, ref: z.string().min(1).max(200) }),
]);

export default defineTool({
  description:
    "Read metadata, a pull request, a recursive tree, one text file, or CI checks from any repository accessible to the configured GitHub connector. This tool never mutates GitHub.",
  inputSchema,
  async execute(input, ctx) {
    if ("path" in input && (input.path.startsWith("/") || input.path.split("/").includes(".."))) {
      throw new Error("File path must stay within the repository");
    }
    const { token } = await ctx.getToken(githubAuth);
    await requireRepositoryPermission(ctx, token, input.owner, input.repo, "read");
    const root = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    const path = (() => {
      switch (input.operation) {
        case "metadata": return root;
        case "pull_request": return `${root}/pulls/${input.number}`;
        case "tree": return `${root}/git/trees/${encodeURIComponent(input.ref)}?recursive=1`;
        case "read_file": return `${root}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(input.ref)}`;
        case "checks": return "";
      }
    })();
    const fetchGitHub = async (requestPath: string, accept = "application/vnd.github+json") => {
      const response = await fetch(`https://api.github.com${requestPath}`, {
        headers: {
          accept,
          authorization: `Bearer ${token}`,
          "user-agent": "eve-engineering-agent",
          "x-github-api-version": "2022-11-28",
        },
        signal: ctx.abortSignal,
      });
      if (!response.ok) {
        if (response.status === 401) ctx.requireAuth(githubAuth);
        throw new Error(`GitHub GET ${requestPath} failed with ${response.status}: ${(await response.text()).slice(0, 500)}`);
      }
      return response;
    };
    if (input.operation === "checks") {
      const ref = encodeURIComponent(input.ref);
      const checkRuns: unknown[] = [];
      const statuses: unknown[] = [];
      let checkRunTotal = 0;
      let statusTotal = 0;
      for (let page = 1; page <= 30; page += 1) {
        const response = await fetchGitHub(
          `${root}/commits/${ref}/check-runs?per_page=100&page=${page}`,
        );
        const body = await response.json() as { total_count: number; check_runs: unknown[] };
        checkRunTotal = body.total_count;
        checkRuns.push(...body.check_runs);
        if (checkRuns.length >= checkRunTotal || body.check_runs.length < 100) break;
      }
      if (checkRuns.length < checkRunTotal) {
        throw new Error(`GitHub check-run pagination stopped at ${checkRuns.length} of ${checkRunTotal}`);
      }
      for (let page = 1; page <= 30; page += 1) {
        const response = await fetchGitHub(
          `${root}/commits/${ref}/status?per_page=100&page=${page}`,
        );
        const body = await response.json() as { total_count: number; statuses: unknown[] };
        statusTotal = body.total_count;
        statuses.push(...body.statuses);
        if (statuses.length >= statusTotal || body.statuses.length < 100) break;
      }
      if (statuses.length < statusTotal) {
        throw new Error(`GitHub status pagination stopped at ${statuses.length} of ${statusTotal}`);
      }
      return {
        operation: input.operation,
        data: {
          check_runs: checkRuns,
          check_run_total_count: checkRunTotal,
          statuses,
          status_total_count: statusTotal,
        },
      };
    }
    const response = await fetchGitHub(
      path,
      input.operation === "read_file"
        ? "application/vnd.github.raw+json"
        : "application/vnd.github+json",
    );
    if (input.operation === "read_file") {
      const content = await readResponseTextLimited(response, 500_000);
      return { operation: input.operation, content };
    }
    return { operation: input.operation, data: await response.json() };
  },
});
