import type { SessionContext } from "eve/context";
import { store } from "./database.js";
import { env } from "./env.js";

type RequiredPermission = "read" | "write";

const allowed = {
  read: new Set(["read", "triage", "write", "maintain", "admin", "pull", "push"]),
  write: new Set(["write", "maintain", "admin", "push"]),
} satisfies Record<RequiredPermission, Set<string>>;

const githubLoginFor = async (ctx: SessionContext, owner: string): Promise<string | null> => {
  const auth = ctx.session.auth.current;
  if (!auth) return null;
  const webhookLogin = auth.attributes.user_login;
  if (
    auth.principalType === "user" &&
    auth.authenticator === "github-webhook" &&
    typeof webhookLogin === "string" && webhookLogin
  ) {
    return webhookLogin;
  }
  if (auth.principalType !== "user") return null;
  const identity = await store.githubIdentity<{
    provider_user_id: string; provider_login: string | null;
  } | null>(auth.principalId, [owner.toLowerCase()]);
  if (!identity) return null;
  return /^\d+$/.test(identity.provider_user_id)
    ? identity.provider_user_id
    : identity.provider_login ?? identity.provider_user_id;
};

export const requireRepositoryPermission = async (
  ctx: SessionContext,
  token: string,
  owner: string,
  repo: string,
  required: RequiredPermission,
) => {
  const auth = ctx.session.auth.current;
  if (auth?.principalType === "runtime" && auth.authenticator === "app") {
    const target = auth.attributes.repository;
    if (typeof target === "string" && target.toLowerCase() === `${owner}/${repo}`.toLowerCase()) return;
    throw new Error("Runtime repository access is outside the claimed task target");
  }
  let login = await githubLoginFor(ctx, owner);
  if (!login) {
    throw new Error("A verified GitHub identity is required for repository access");
  }
  if (/^\d+$/.test(login)) {
    const identity = await fetch(`${env.githubApiUrl.replace(/\/+$/, "")}/user/${login}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "eve-engineering-agent",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!identity.ok) throw new Error("Could not resolve the verified GitHub account login");
    const account = await identity.json() as { login?: string };
    if (!account.login) throw new Error("Verified GitHub account has no login");
    login = account.login;
  }
  const response = await fetch(
    `${env.githubApiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(login)}/permission`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "eve-engineering-agent",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Could not verify ${required} permission for ${login} on ${owner}/${repo}`);
  }
  const result = await response.json() as { permission?: string; role_name?: string };
  if (![result.permission, result.role_name].some((value) => value && allowed[required].has(value))) {
    throw new Error(`${login} does not have ${required} permission on ${owner}/${repo}`);
  }
};
