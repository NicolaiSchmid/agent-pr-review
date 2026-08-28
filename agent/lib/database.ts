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
  searchMemories: async <T>(v: Record<string, unknown>) => {
    const scopeKeys = v.scopeKeys as string[];
    const search = v.query as string;
    const limit = v.limit as number;
    const now = Date.now();
    const found: Array<Record<string, unknown>> = [];
    await Promise.all(scopeKeys.map(async (scopeKey) => {
      let cursor: string | null = null;
      let done = false;
      let valid = 0;
      while (!done && valid < limit) {
        const page = await convex().query(query("searchMemoryPage"), args({
          scopeKey, query: search, limit: Math.max(limit, 20), cursor,
        })) as { page: Array<Record<string, unknown>>; continueCursor: string; isDone: boolean };
        for (const memory of page.page) {
          const expiresAt = memory.expires_at;
          if (typeof expiresAt !== "string" || Date.parse(expiresAt) > now) {
            found.push(memory);
            valid += 1;
            if (valid === limit) break;
          }
        }
        cursor = page.continueCursor;
        done = page.isDone;
      }
    }));
    found.sort((a, b) => Number(b.updated_at) - Number(a.updated_at));
    return found.slice(0, limit) as T;
  },
  supersedeMemory: (v: Record<string, unknown>) => convex().mutation(mutation("supersedeMemory"), args(v)) as Promise<boolean>,
  githubIdentity: <T>(principalId: string, providerTenantIds: string[]) => convex().query(query("githubIdentity"), args({ principalId, providerTenantIds })) as Promise<T>,
  deferCi: (v: Record<string, unknown>) => convex().mutation(mutation("deferCi"), args(v)) as Promise<string>,
  transitionTask: (v: Record<string, unknown>) => convex().mutation(mutation("transitionTask"), args(v)) as Promise<boolean>,
  taskMatches: (v: Record<string, unknown>) => convex().query(query("taskMatches"), args(v)) as Promise<boolean>,
  claimDeferred: <T>(limit: number, staleBefore: number) => convex().mutation(mutation("claimDeferred"), args({ limit, staleBefore })) as Promise<T>,
  settleLease: (taskId: string, leaseToken: string, state: string) => convex().mutation(mutation("settleLease"), args({ taskId, leaseToken, state })),
  getOrCreateOperation: <T>(v: Record<string, unknown>) => convex().mutation(mutation("getOrCreateOperation"), args(v)) as Promise<T>,
  getOperation: <T>(id: string) => convex().query(query("getOperation"), args({ id })) as Promise<T>,
  claimOperationPull: (id: string, number: number) => convex().mutation(mutation("claimOperationPull"), args({ id, number })) as Promise<boolean>,
  markRetryableClosure: (id: string, number: number) => convex().mutation(mutation("markRetryableClosure"), args({ id, number })) as Promise<boolean>,
  releaseOperationPull: (id: string, number: number) => convex().mutation(mutation("releaseOperationPull"), args({ id, number })) as Promise<boolean>,
  moveOperationBranch: (id: string, expectedBranch: string, nextBranch: string) => convex().mutation(mutation("moveOperationBranch"), args({ id, expectedBranch, nextBranch })) as Promise<boolean>,
  holdRerun: <T>(repositoryId: string, headSha: string) => convex().mutation(mutation("holdRerun"), args({ repositoryId, headSha })) as Promise<T>,
  resolveRerunPull: <T>(repositoryId: string, pullRequestNumber: number, headSha: string, disposition: "valid" | "cancelled" | "superseded") => convex().mutation(mutation("resolveRerunPull"), args({ repositoryId, pullRequestNumber, headSha, disposition })) as Promise<T>,
  acknowledgeRerunCleanup: (taskId: string) => convex().mutation(mutation("acknowledgeRerunCleanup"), args({ taskId })),
  supersedeCompleted: (taskId: string) => convex().mutation(mutation("supersedeCompleted"), args({ taskId })),
  cancelPullTasks: (repositoryId: string, pullRequestNumber: number) => convex().mutation(mutation("cancelPullTasks"), args({ repositoryId, pullRequestNumber })),
  claimWaiting: <T>(repositoryId: string, headSha: string, pullRequestNumbers: number[]) => convex().mutation(mutation("claimWaiting"), args({ repositoryId, headSha, pullRequestNumbers })) as Promise<T>,
  supersedeOldHeads: <T>(repositoryId: string, pullRequestNumber: number, headSha: string) => convex().mutation(mutation("supersedeOldHeads"), args({ repositoryId, pullRequestNumber, headSha })) as Promise<T>,
};
