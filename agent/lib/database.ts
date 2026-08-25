import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { env } from "./env.js";

let client: ConvexHttpClient | undefined;
const convex = () => {
  if (!env.convexUrl || !env.convexAgentSecret) throw new Error("CONVEX_URL and CONVEX_AGENT_SECRET are required for durable state");
  client ??= new ConvexHttpClient(env.convexUrl);
  return client;
};
const args = <T extends Record<string, unknown>>(value: T) => ({ ...value, secret: env.convexAgentSecret! });
const mutation = (name: string) => makeFunctionReference<"mutation">(`store:${name}`);
const query = (name: string) => makeFunctionReference<"query">(`store:${name}`);

export const store = {
  saveMemory: (v: Record<string, unknown>) => convex().mutation(mutation("saveMemory"), args(v)),
  searchMemories: <T>(v: Record<string, unknown>) => convex().query(query("searchMemories"), args(v)) as Promise<T>,
  supersedeMemory: (v: Record<string, unknown>) => convex().mutation(mutation("supersedeMemory"), args(v)) as Promise<boolean>,
  githubIdentity: <T>(principalId: string) => convex().query(query("githubIdentity"), args({ principalId })) as Promise<T>,
  deferCi: (v: Record<string, unknown>) => convex().mutation(mutation("deferCi"), args(v)) as Promise<string>,
  transitionTask: (v: Record<string, unknown>) => convex().mutation(mutation("transitionTask"), args(v)) as Promise<boolean>,
  taskMatches: (v: Record<string, unknown>) => convex().query(query("taskMatches"), args(v)) as Promise<boolean>,
  claimDeferred: <T>(limit: number, staleBefore: number) => convex().mutation(mutation("claimDeferred"), args({ limit, staleBefore })) as Promise<T>,
  settleLease: (taskId: string, leaseToken: string, state: string) => convex().mutation(mutation("settleLease"), args({ taskId, leaseToken, state })),
  getOrCreateOperation: <T>(v: Record<string, unknown>) => convex().mutation(mutation("getOrCreateOperation"), args(v)) as Promise<T>,
  getOperation: <T>(id: string) => convex().query(query("getOperation"), args({ id })) as Promise<T>,
  claimOperationPull: (id: string, number: number) => convex().mutation(mutation("claimOperationPull"), args({ id, number })) as Promise<boolean>,
  rerun: <T>(repositoryId: string, headSha: string) => convex().mutation(mutation("rerun"), args({ repositoryId, headSha })) as Promise<T>,
  finalizeRerun: (taskId: string) => convex().mutation(mutation("finalizeRerun"), args({ taskId })),
  supersedeCompleted: (taskId: string) => convex().mutation(mutation("supersedeCompleted"), args({ taskId })),
  cancelPullTasks: (repositoryId: string, pullRequestNumber: number) => convex().mutation(mutation("cancelPullTasks"), args({ repositoryId, pullRequestNumber })),
  claimWaiting: <T>(repositoryId: string, headSha: string, pullRequestNumbers: number[]) => convex().mutation(mutation("claimWaiting"), args({ repositoryId, headSha, pullRequestNumbers })) as Promise<T>,
  supersedeOldHeads: <T>(repositoryId: string, pullRequestNumber: number, headSha: string) => convex().mutation(mutation("supersedeOldHeads"), args({ repositoryId, pullRequestNumber, headSha })) as Promise<T>,
};
