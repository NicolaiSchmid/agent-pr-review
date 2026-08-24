import { defineBashTool, defineTool } from "eve/tools";
import { z } from "zod";
import { scopeFromContext } from "../lib/scope.js";

const sandboxBash = defineBashTool({
  description:
    "Execute a shell command in the persistent review sandbox. Disabled by policy for fork PRs unless fork execution was explicitly configured before session creation.",
});

export default defineTool({
  description: sandboxBash.description,
  inputSchema: z.object({ command: z.string().min(1) }),
  async execute(input, ctx) {
    const scope = scopeFromContext(ctx);
    if (scope.allowExecution !== "true") {
      return {
        exitCode: 126,
        stdout: "",
        stderr: "Sandbox command execution is disabled for this fork PR.",
        truncated: false,
      };
    }
    return await sandboxBash.execute(input, ctx);
  },
});
