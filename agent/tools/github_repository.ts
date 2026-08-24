import { connect } from "@vercel/connect/eve";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { env } from "../lib/env.js";

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
    const root = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    const path = (() => {
      switch (input.operation) {
        case "metadata": return root;
        case "pull_request": return `${root}/pulls/${input.number}`;
        case "tree": return `${root}/git/trees/${encodeURIComponent(input.ref)}?recursive=1`;
        case "read_file": return `${root}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(input.ref)}`;
        case "checks": return `${root}/commits/${encodeURIComponent(input.ref)}/check-runs?per_page=100`;
      }
    })();
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: input.operation === "read_file"
          ? "application/vnd.github.raw+json"
          : "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "eve-engineering-agent",
        "x-github-api-version": "2022-11-28",
      },
      signal: ctx.abortSignal,
    });
    if (!response.ok) {
      if (response.status === 401) ctx.requireAuth(githubAuth);
      throw new Error(`GitHub GET ${path} failed with ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    if (input.operation === "read_file") {
      const content = await response.text();
      if (content.length > 500_000) throw new Error("File exceeds the 500 KB read limit");
      return { operation: input.operation, content };
    }
    return { operation: input.operation, data: await response.json() };
  },
});
