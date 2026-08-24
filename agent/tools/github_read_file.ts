import { defineTool } from "eve/tools";
import { z } from "zod";
import { GitHubClient } from "../lib/github.js";
import { scopeFromContext } from "../lib/scope.js";

export default defineTool({
  description:
    "Read a source file at the trusted base or head SHA. This is the safe fallback when no read-only sandbox token is configured.",
  inputSchema: z.object({
    path: z.string().min(1),
    revision: z.enum(["base", "head"]),
  }),
  async execute({ path, revision }, ctx) {
    if (path.startsWith("/") || path.split("/").includes("..")) {
      return { error: "Path must be repository-relative and may not traverse." };
    }
    const scope = scopeFromContext(ctx);
    const content = await new GitHubClient().readFile(scope, path, revision);
    return {
      repository: `${scope.owner}/${scope.repo}`,
      ref: revision === "base" ? scope.baseSha : scope.headSha,
      path,
      content,
    };
  },
});
