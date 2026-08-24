import { defineTool } from "eve/tools";
import { z } from "zod";
import { GitHubClient } from "../lib/github.js";
import { scopeFromContext } from "../lib/scope.js";

export default defineTool({
  description:
    "Get trusted metadata and the complete changed-file list for the triggering PR. Repository, PR number, and SHAs come only from session authentication scope.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const scope = scopeFromContext(ctx);
    const client = new GitHubClient();
    const pull = await client.getPull(scope);
    const files = await client.listPullFiles(scope, pull.changed_files);
    return {
      scope,
      currentHeadSha: pull.head.sha,
      title: pull.title,
      url: pull.html_url,
      files,
    };
  },
});
