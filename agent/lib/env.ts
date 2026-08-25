const read = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

export const env = {
  anthropicApiKey: read("ANTHROPIC_API_KEY"),
  anthropicModel: read("ANTHROPIC_MODEL") ?? "claude-fable-5",
  githubConnector: read("GITHUB_CONNECTOR") ?? "github/eve",
  slackConnector: read("SLACK_CONNECTOR") ?? "slack/eve",
  agentBotName: read("AGENT_BOT_NAME") ?? "eve",
  convexUrl: read("CONVEX_URL"),
  convexAgentSecret: read("CONVEX_AGENT_SECRET"),
  githubToken: read("GITHUB_TOKEN"),
  githubSandboxToken: read("GITHUB_SANDBOX_TOKEN"),
  githubWebhookSecret: read("GITHUB_WEBHOOK_SECRET"),
  githubBotLogin: read("GITHUB_BOT_LOGIN")?.toLowerCase(),
  githubApiUrl: read("GITHUB_API_URL") ?? "https://api.github.com",
  allowForkExecution: read("ALLOW_FORK_EXECUTION") === "true",
  maxFindings: Number(read("MAX_FINDINGS") ?? "12"),
};

export const requireEnv = (name: keyof typeof env): string => {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};
