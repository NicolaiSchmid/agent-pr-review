import type { MemoryScope } from "./memory.js";

type SessionLike = {
  session?: {
    auth?: {
      current?: {
        authenticator?: string;
        issuer?: string;
        principalId?: string;
        principalType?: string;
        attributes?: Record<string, unknown>;
      } | null;
    };
  };
};

export const memoryContext = (ctx: SessionLike) => {
  const auth = ctx.session?.auth?.current;
  if (!auth?.principalId || auth.principalType !== "user") {
    throw new Error("Long-term memory requires an authenticated human caller");
  }
  const scopes: MemoryScope[] = [{ kind: "user", userId: auth.principalId }];
  const repositoryId = auth.attributes?.repository_id;
  const githubRepository = auth.attributes?.repository;
  const githubLogin = auth.attributes?.user_login;
  if (
    typeof repositoryId === "string" && repositoryId &&
    typeof githubRepository === "string" && githubRepository &&
    typeof githubLogin === "string" && githubLogin
  ) {
    scopes.push({ kind: "repository", repositoryId });
    const pullRequest = Number(auth.attributes?.pull_request_number);
    if (Number.isInteger(pullRequest) && pullRequest > 0) {
      scopes.push({ kind: "pull_request", repositoryId, number: pullRequest });
    }
  }
  return { principalId: auth.principalId, scopes };
};
