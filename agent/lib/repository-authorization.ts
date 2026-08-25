import type { SessionContext } from "eve/context";
import { database } from "./database.js";
import { env } from "./env.js";

type RequiredPermission = "read" | "write";

const allowed = {
  read: new Set(["read", "triage", "write", "maintain", "admin", "pull", "push"]),
  write: new Set(["write", "maintain", "admin", "push"]),
} satisfies Record<RequiredPermission, Set<string>>;

const githubLoginFor = async (ctx: SessionContext): Promise<string | null> => {
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
  const identities = await database()<Array<{ provider_user_id: string }>>`
    select provider_user_id
    from principal_identities
    where principal_id = ${auth.principalId} and provider = 'github'
    order by verified_at desc
    limit 1
  `;
  return identities[0]?.provider_user_id ?? null;
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
  const login = await githubLoginFor(ctx);
  if (!login) {
    throw new Error("A verified GitHub identity is required for repository access");
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
