import { createEnv } from "@t3-oss/env-core";
import * as z from "zod";

export const positiveInteger = (name: string, value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

const positiveIntegerSchema = (name: string, fallback: number) =>
  z
    .string()
    .optional()
    .transform((value, context) => {
      try {
        return positiveInteger(name, value, fallback);
      } catch {
        context.addIssue({
          code: "custom",
          message: `${name} must be a positive integer`,
        });
        return z.NEVER;
      }
    });

const runtimeEnv = createEnv({
  server: {
    ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
    ANTHROPIC_MODEL: z.string().trim().min(1).default("claude-fable-5"),
    GITHUB_TOKEN: z.string().trim().min(1).optional(),
    GITHUB_SANDBOX_TOKEN: z.string().trim().min(1).optional(),
    GITHUB_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
    GITHUB_BOT_LOGIN: z.string().trim().min(1).toLowerCase().optional(),
    GITHUB_API_URL: z.string().trim().url().default("https://api.github.com"),
    ALLOW_FORK_EXECUTION: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    MAX_FINDINGS: positiveIntegerSchema("MAX_FINDINGS", 12),
    MAX_REVIEW_ROUNDS: positiveIntegerSchema("MAX_REVIEW_ROUNDS", 3),
    MAX_REVIEW_CHANGE_BYTES: positiveIntegerSchema("MAX_REVIEW_CHANGE_BYTES", 20_000),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export const env = {
  anthropicApiKey: runtimeEnv.ANTHROPIC_API_KEY,
  anthropicModel: runtimeEnv.ANTHROPIC_MODEL,
  githubToken: runtimeEnv.GITHUB_TOKEN,
  githubSandboxToken: runtimeEnv.GITHUB_SANDBOX_TOKEN,
  githubWebhookSecret: runtimeEnv.GITHUB_WEBHOOK_SECRET,
  githubBotLogin: runtimeEnv.GITHUB_BOT_LOGIN,
  githubApiUrl: runtimeEnv.GITHUB_API_URL,
  allowForkExecution: runtimeEnv.ALLOW_FORK_EXECUTION,
  maxFindings: runtimeEnv.MAX_FINDINGS,
  maxReviewRounds: runtimeEnv.MAX_REVIEW_ROUNDS,
  maxReviewChangeBytes: runtimeEnv.MAX_REVIEW_CHANGE_BYTES,
};

export const requireEnv = (name: keyof typeof env): string => {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};
