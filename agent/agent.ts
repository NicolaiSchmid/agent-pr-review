import { createAnthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";
import { env } from "./lib/env.js";

const anthropic = createAnthropic({ apiKey: env.anthropicApiKey });

export default defineAgent({
  model: anthropic(env.anthropicModel),
  modelContextWindowTokens: 200_000,
  compaction: { modelContextWindowTokens: 200_000 },
  limits: {
    maxInputTokensPerSession: 400_000,
    maxOutputTokensPerSession: 30_000,
  },
});
