import { defaultBackend, defineSandbox } from "eve/sandbox";
import { env } from "./lib/env.js";
import { createSandboxNetworkPolicy } from "./lib/sandbox-policy.js";

const networkPolicy = createSandboxNetworkPolicy(env.githubSandboxToken);

export default defineSandbox({
  backend: defaultBackend({
    vercel: { networkPolicy },
    docker: { networkPolicy: "deny-all" },
    microsandbox: { networkPolicy },
  }),
});
