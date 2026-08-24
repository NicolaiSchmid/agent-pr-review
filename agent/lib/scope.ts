import { z } from "zod";

export const TARGET_OWNER = "NicolaiSchmid";
export const TARGET_REPO = "nunc-immo";

export const reviewScopeSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.coerce.number().int().positive(),
  baseSha: z.string().min(7),
  headSha: z.string().min(7),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  installationId: z.string().optional(),
  deliveryId: z.string().min(1),
  fork: z.enum(["true", "false"]),
  allowExecution: z.enum(["true", "false"]),
});

export type ReviewScope = z.infer<typeof reviewScopeSchema>;

type SessionContext = {
  session?: {
    auth?: { initiator?: { attributes?: Record<string, unknown> } | null };
  };
};

export const scopeFromContext = (ctx: SessionContext): ReviewScope => {
  const parsed = reviewScopeSchema.safeParse(
    ctx.session?.auth?.initiator?.attributes,
  );
  if (!parsed.success) throw new Error("Missing trusted pull request scope");
  if (
    parsed.data.owner.toLowerCase() !== TARGET_OWNER.toLowerCase() ||
    parsed.data.repo.toLowerCase() !== TARGET_REPO.toLowerCase()
  ) {
    throw new Error("Pull request scope is outside the configured repository");
  }
  return parsed.data;
};

export const continuationTokenFor = (scope: ReviewScope) =>
  `github-pr:${scope.owner.toLowerCase()}/${scope.repo.toLowerCase()}#${scope.number}@${scope.headSha}`;

export const parseContinuationToken = (token: string) => {
  const match = /(?:^|:)github-pr:([^/]+)\/([^#]+)#(\d+)@([0-9a-f]+)$/i.exec(
    token,
  );
  if (!match) return null;
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: Number(match[3]),
    headSha: match[4]!,
  };
};

export const parseSessionFailedRecovery = (
  event: {
    type: "session.failed";
    data: {
      code: string;
      message: string;
      sessionId: string;
      details?: Record<string, unknown>;
    };
  },
  continuationToken: string,
) => {
  const scope = parseContinuationToken(continuationToken);
  return scope ? { scope, failure: event.data } : null;
};
