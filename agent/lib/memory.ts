import { z } from "zod";

export const memoryScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
  z.object({ kind: z.literal("organization"), organizationId: z.string().min(1) }),
  z.object({
    kind: z.literal("repository"),
    repositoryId: z.string().min(1),
  }),
  z.object({ kind: z.literal("pull_request"), repositoryId: z.string().min(1), number: z.number().int().positive() }),
]);

export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  scope: memoryScopeSchema,
  content: z.string().min(1).max(8_000),
  tags: z.array(z.string().min(1).max(80)).max(20).default([]),
  sourceUrl: z.string().url().optional(),
  authorPrincipalId: z.string().min(1),
  status: z.enum(["proposed", "confirmed", "superseded"]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
});

export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export interface MemoryStore {
  search(scopes: MemoryScope[], query: string, limit: number): Promise<MemoryRecord[]>;
  put(record: MemoryRecord): Promise<MemoryRecord>;
  supersede(scope: MemoryScope, id: string, actorPrincipalId: string): Promise<boolean>;
}

export const memoryScopeKey = (scope: MemoryScope) => {
  switch (scope.kind) {
    case "user": return `user:${scope.userId}`;
    case "organization": return `organization:${scope.organizationId}`;
    case "repository": return `repository:${scope.repositoryId}`;
    case "pull_request": return `pull_request:${scope.repositoryId}#${scope.number}`;
  }
};
