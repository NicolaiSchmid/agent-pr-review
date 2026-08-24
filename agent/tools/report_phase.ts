import { defineTool } from "eve/tools";
import { z } from "zod";
import { GitHubClient } from "../lib/github.js";
import { renderProgress, updateProgress } from "../lib/progress.js";
import { scopeFromContext } from "../lib/scope.js";

export default defineTool({
  description:
    "Update the single PR progress comment after entering a review phase. Scope is derived from trusted session authentication.",
  inputSchema: z.object({
    phase: z.enum(["intake", "context", "checks", "verification", "synthesis"]),
  }),
  async execute({ phase }, ctx) {
    const scope = scopeFromContext(ctx);
    return await updateProgress(
      new GitHubClient(),
      scope,
      renderProgress(scope, "reviewing", { phase }),
    );
  },
});
