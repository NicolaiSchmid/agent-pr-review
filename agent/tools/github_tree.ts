import { defineTool } from "eve/tools";
import { z } from "zod";
import { GitHubClient } from "../lib/github.js";
import { scopeFromContext } from "../lib/scope.js";

export default defineTool({
  description:
    "List the repository tree at the trusted base or head SHA. Use with github_read_file to explore callers and contracts without sandbox credentials.",
  inputSchema: z.object({ revision: z.enum(["base", "head"]) }),
  async execute({ revision }, ctx) {
    const scope = scopeFromContext(ctx);
    return await new GitHubClient().getTree(scope, revision);
  },
});
