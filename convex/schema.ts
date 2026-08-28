import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const taskState = v.union(
  v.literal("queued"), v.literal("waiting_for_ci"), v.literal("reviewing"),
  v.literal("waiting_for_user"), v.literal("publishing"), v.literal("completed"),
  v.literal("superseded"), v.literal("failed"), v.literal("cancelled"),
);

export default defineSchema({
  principals: defineTable({ externalId: v.string(), organizationId: v.optional(v.string()) })
    .index("by_external_id", ["externalId"]),
  principalIdentities: defineTable({
    provider: v.union(v.literal("github"), v.literal("slack")),
    providerTenantId: v.string(), providerUserId: v.string(),
    providerLogin: v.optional(v.string()), principalId: v.string(), verifiedAt: v.number(),
  }).index("by_principal_provider_verified", ["principalId", "provider", "verifiedAt"])
    .index("by_provider_tenant_user", ["provider", "providerTenantId", "providerUserId"]),
  conversations: defineTable({
    externalId: v.string(), conversationKey: v.string(),
    source: v.union(v.literal("github"), v.literal("slack")),
    repositoryId: v.optional(v.string()), repositoryOwner: v.optional(v.string()),
    repositoryName: v.optional(v.string()), githubInstallationId: v.optional(v.string()),
    pullRequestNumber: v.optional(v.number()), updatedAt: v.number(),
  }).index("by_external_id", ["externalId"])
    .index("by_conversation_key", ["conversationKey"]),
  tasks: defineTable({
    externalId: v.string(), conversationId: v.id("conversations"),
    kind: v.union(v.literal("pr_review"), v.literal("change_request"), v.literal("memory"), v.literal("question")),
    state: taskState, requestedBy: v.optional(v.string()), repositoryId: v.optional(v.string()),
    headSha: v.optional(v.string()), leaseToken: v.optional(v.string()),
    rerunCleanupPending: v.optional(v.boolean()),
    rerunResultState: v.optional(v.union(v.literal("reopened"), v.literal("superseded"))),
    deadlineAt: v.optional(v.number()), updatedAt: v.number(),
  }).index("by_external_id", ["externalId"])
    .index("by_conversation_head", ["conversationId", "headSha"])
    .index("by_repository_head", ["repositoryId", "headSha"])
    .index("by_state_updated", ["state", "updatedAt"]),
  eventDeliveries: defineTable({
    provider: v.string(), deliveryId: v.string(), receivedAt: v.number(), payloadSha256: v.string(),
  }).index("by_provider_delivery", ["provider", "deliveryId"]),
  checkSnapshots: defineTable({
    taskId: v.string(), headSha: v.string(), checkName: v.string(), status: v.string(),
    conclusion: v.optional(v.string()), observedAt: v.number(),
  }).index("by_task_head_name", ["taskId", "headSha", "checkName"]),
  memoryRecords: defineTable({
    externalId: v.string(),
    scopeKind: v.union(v.literal("user"), v.literal("organization"), v.literal("repository"), v.literal("pull_request")),
    scopeKey: v.string(), scopeStatus: v.string(), content: v.string(), tags: v.array(v.string()),
    sourceUrl: v.optional(v.string()), authorPrincipalId: v.string(),
    status: v.union(v.literal("proposed"), v.literal("confirmed"), v.literal("superseded")),
    expiresAt: v.optional(v.number()), updatedAt: v.number(),
  }).index("by_external_id", ["externalId"])
    .index("by_scope_status", ["scopeKey", "status"])
    .searchIndex("search_content", { searchField: "content", filterFields: ["scopeStatus"] }),
  approvalRequests: defineTable({
    externalId: v.string(), taskId: v.string(), capability: v.string(),
    requestedFrom: v.optional(v.string()), decision: v.optional(v.union(v.literal("approved"), v.literal("denied"))),
    decidedAt: v.optional(v.number()),
  }).index("by_external_id", ["externalId"]),
  changeOperations: defineTable({
    externalId: v.string(), requestFingerprint: v.string(), repositoryOwner: v.string(),
    repositoryName: v.string(), branch: v.string(), pullRequestNumber: v.optional(v.number()), updatedAt: v.number(),
  }).index("by_external_id", ["externalId"])
    .index("by_request_fingerprint", ["requestFingerprint"]),
  auditEvents: defineTable({
    taskId: v.optional(v.string()), actorPrincipalId: v.optional(v.string()), action: v.string(),
    target: v.optional(v.string()), metadata: v.any(),
  }).index("by_task", ["taskId"]),
});
