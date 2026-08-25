import { describe, expect, it } from "vitest";
import { memoryRecordSchema, memoryScopeKey } from "./memory.js";

describe("scoped memory", () => {
  it("keeps repository and user namespaces distinct", () => {
    expect(memoryScopeKey({ kind: "user", userId: "github:1" })).toBe("user:github:1");
    expect(memoryScopeKey({ kind: "repository", repositoryId: "99" })).toBe("repository:99");
  });

  it("requires provenance and bounded content", () => {
    expect(memoryRecordSchema.safeParse({
      id: "m1",
      scope: { kind: "organization", organizationId: "1" },
      content: "All public endpoints require audit logging.",
      authorPrincipalId: "github:1",
      status: "confirmed",
      createdAt: "2026-08-25T00:00:00.000Z",
    }).success).toBe(true);
  });
});
