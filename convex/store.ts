import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const active = (state: string) => !["completed", "superseded", "failed", "cancelled"].includes(state);
const authorize = (secret: string) => {
  if (!process.env.CONVEX_AGENT_SECRET || secret !== process.env.CONVEX_AGENT_SECRET) {
    throw new Error("Unauthorized agent database request");
  }
};

export const saveMemory = mutationGeneric({
  args: { secret: v.string(), id: v.string(), scopeKind: v.string(), scopeKey: v.string(), content: v.string(), tags: v.array(v.string()), sourceUrl: v.optional(v.string()), authorPrincipalId: v.string(), expiresAt: v.optional(v.number()) },
  handler: async ({ db }, a) => {
    authorize(a.secret); const now = Date.now();
    const principal = await db.query("principals").withIndex("by_external_id", q => q.eq("externalId", a.authorPrincipalId)).unique();
    if (!principal) await db.insert("principals", { externalId: a.authorPrincipalId });
    await db.insert("memoryRecords", { externalId: a.id, scopeKind: a.scopeKind, scopeKey: a.scopeKey, content: a.content, tags: a.tags, sourceUrl: a.sourceUrl, authorPrincipalId: a.authorPrincipalId, status: "confirmed", expiresAt: a.expiresAt, updatedAt: now });
    return a.id;
  },
});

export const searchMemories = queryGeneric({
  args: { secret: v.string(), scopeKeys: v.array(v.string()), query: v.string(), limit: v.number() },
  handler: async ({ db }, a) => {
    authorize(a.secret); const now = Date.now(); const needle = a.query.toLocaleLowerCase();
    const groups = await Promise.all(a.scopeKeys.map(scopeKey => db.query("memoryRecords").withIndex("by_scope_status", q => q.eq("scopeKey", scopeKey)).collect()));
    return groups.flat().filter((m: any) => m.status === "confirmed" && (!m.expiresAt || m.expiresAt > now) && m.content.toLocaleLowerCase().includes(needle)).sort((x: any, y: any) => y.updatedAt - x.updatedAt).slice(0, a.limit).map((m: any) => ({ id: m.externalId, scope_kind: m.scopeKind, scope_key: m.scopeKey, content: m.content, tags: m.tags, source_url: m.sourceUrl ?? null, author_principal_id: m.authorPrincipalId, status: m.status, created_at: new Date(m._creationTime).toISOString(), expires_at: m.expiresAt ? new Date(m.expiresAt).toISOString() : null }));
  },
});

export const supersedeMemory = mutationGeneric({
  args: { secret: v.string(), id: v.string(), principalId: v.string(), scopeKeys: v.array(v.string()) },
  handler: async ({ db }, a) => {
    authorize(a.secret); const m = await db.query("memoryRecords").withIndex("by_external_id", q => q.eq("externalId", a.id)).unique();
    if (!m || m.authorPrincipalId !== a.principalId || !a.scopeKeys.includes(m.scopeKey) || m.status === "superseded") return false;
    await db.patch(m._id, { status: "superseded", updatedAt: Date.now() }); return true;
  },
});

export const githubIdentity = queryGeneric({
  args: { secret: v.string(), principalId: v.string() },
  handler: async ({ db }, a) => { authorize(a.secret); const rows: any[] = await db.query("principalIdentities").withIndex("by_principal_provider_verified", q => q.eq("principalId", a.principalId)).collect(); const i = rows.filter(x => x.provider === "github").sort((x, y) => y.verifiedAt - x.verifiedAt)[0]; return i ? { provider_user_id: i.providerUserId, provider_login: i.providerLogin ?? null } : null; },
});

export const deferCi = mutationGeneric({
  args: { secret: v.string(), conversationId: v.string(), taskId: v.string(), conversationKey: v.string(), repositoryId: v.string(), repositoryOwner: v.string(), repositoryName: v.string(), githubInstallationId: v.optional(v.string()), pullRequestNumber: v.number(), headSha: v.string() },
  handler: async ({ db }, a) => {
    authorize(a.secret); const now = Date.now();
    let c: any = await db.query("conversations").withIndex("by_conversation_key", q => q.eq("conversationKey", a.conversationKey)).unique();
    if (!c) { const id = await db.insert("conversations", { externalId: a.conversationId, conversationKey: a.conversationKey, source: "github", repositoryId: a.repositoryId, repositoryOwner: a.repositoryOwner, repositoryName: a.repositoryName, githubInstallationId: a.githubInstallationId, pullRequestNumber: a.pullRequestNumber, updatedAt: now }); c = await db.get(id); }
    else await db.patch(c._id, { repositoryId: a.repositoryId, repositoryOwner: a.repositoryOwner, repositoryName: a.repositoryName, githubInstallationId: a.githubInstallationId ?? c.githubInstallationId, pullRequestNumber: a.pullRequestNumber, updatedAt: now });
    const same: any[] = (await db.query("tasks").withIndex("by_conversation_head", q => q.eq("conversationId", c._id)).collect()).filter((t: any) => t.headSha === a.headSha);
    const existing = same.find(t => t.kind === "pr_review" && active(t.state));
    if (existing) { if (existing.state === "waiting_for_ci") await db.patch(existing._id, { updatedAt: now }); return existing.externalId; }
    await db.insert("tasks", { externalId: a.taskId, conversationId: c._id, kind: "pr_review", state: "waiting_for_ci", repositoryId: a.repositoryId, headSha: a.headSha, updatedAt: now }); return a.taskId;
  },
});

export const transitionTask = mutationGeneric({
  args: { secret: v.string(), repositoryId: v.string(), pullRequestNumber: v.number(), headSha: v.string(), from: v.string(), to: v.string(), taskId: v.string(), leaseToken: v.string() },
  handler: async ({ db }, a) => { authorize(a.secret); const t: any = await db.query("tasks").withIndex("by_external_id", q => q.eq("externalId", a.taskId)).unique(); if (!t || t.repositoryId !== a.repositoryId || t.headSha !== a.headSha || t.state !== a.from || t.kind !== "pr_review" || t.leaseToken !== a.leaseToken) return false; const c: any = await db.get(t.conversationId); if (c?.pullRequestNumber !== a.pullRequestNumber) return false; await db.patch(t._id, { state: a.to, updatedAt: Date.now() }); return true; },
});

export const taskMatches = queryGeneric({
  args: { secret: v.string(), repositoryId: v.string(), pullRequestNumber: v.number(), headSha: v.string(), state: v.string(), taskId: v.string(), leaseToken: v.string() },
  handler: async ({ db }, a) => { authorize(a.secret); const t: any = await db.query("tasks").withIndex("by_external_id", q => q.eq("externalId", a.taskId)).unique(); if (!t || t.repositoryId !== a.repositoryId || t.headSha !== a.headSha || t.state !== a.state || t.leaseToken !== a.leaseToken) return false; const c: any = await db.get(t.conversationId); return c?.pullRequestNumber === a.pullRequestNumber; },
});

export const claimDeferred = mutationGeneric({
  args: { secret: v.string(), limit: v.number(), staleBefore: v.number() },
  handler: async ({ db }, a) => { authorize(a.secret); const waiting: any[] = await db.query("tasks").withIndex("by_state_updated",q=>q.eq("state","waiting_for_ci")).take(a.limit); const reviewing: any[] = (await db.query("tasks").withIndex("by_state_updated",q=>q.eq("state","reviewing")).take(a.limit)).filter((t:any)=>t.updatedAt<a.staleBefore); const publishing: any[] = (await db.query("tasks").withIndex("by_state_updated",q=>q.eq("state","publishing")).take(a.limit)).filter((t:any)=>t.updatedAt<a.staleBefore); const candidates=[...waiting,...reviewing,...publishing].filter(t=>t.headSha).sort((x,y)=>x.updatedAt-y.updatedAt||x._creationTime-y._creationTime).slice(0,a.limit); const out=[]; for (const t of candidates) { const c: any = await db.get(t.conversationId); if (!c?.repositoryId || !c.repositoryOwner || !c.repositoryName || !c.pullRequestNumber) continue; const leaseToken=crypto.randomUUID(); await db.patch(t._id,{state:"reviewing",leaseToken,updatedAt:Date.now()}); out.push({id:t.externalId,head_sha:t.headSha,repository_id:c.repositoryId,repository_owner:c.repositoryOwner,repository_name:c.repositoryName,github_installation_id:c.githubInstallationId??null,pull_request_number:c.pullRequestNumber,lease_token:leaseToken}); } return out; },
});

export const settleLease = mutationGeneric({
  args: { secret: v.string(), taskId: v.string(), leaseToken: v.string(), state: v.string() },
  handler: async ({ db }, a) => { authorize(a.secret); const t:any=await db.query("tasks").withIndex("by_external_id",q=>q.eq("externalId",a.taskId)).unique(); if (!t || t.state!=="reviewing" || t.leaseToken!==a.leaseToken) return false; await db.patch(t._id,{state:a.state,updatedAt:Date.now()}); return true; },
});

export const getOrCreateOperation = mutationGeneric({
  args: { secret:v.string(), externalId:v.string(), requestFingerprint:v.string(), repositoryOwner:v.string(), repositoryName:v.string(), branch:v.string() },
  handler: async ({db},a)=>{authorize(a.secret); let o:any=await db.query("changeOperations").withIndex("by_request_fingerprint",q=>q.eq("requestFingerprint",a.requestFingerprint)).unique(); if(!o){const id=await db.insert("changeOperations",{externalId:a.externalId,requestFingerprint:a.requestFingerprint,repositoryOwner:a.repositoryOwner,repositoryName:a.repositoryName,branch:a.branch,updatedAt:Date.now()});o=await db.get(id);} return {id:o.externalId,pull_request_number:o.pullRequestNumber??null};},
});
export const getOperation = queryGeneric({args:{secret:v.string(),id:v.string()},handler:async({db},a)=>{authorize(a.secret);const o:any=await db.query("changeOperations").withIndex("by_external_id",q=>q.eq("externalId",a.id)).unique();return o?{pull_request_number:o.pullRequestNumber??null}:null;}});
export const claimOperationPull = mutationGeneric({args:{secret:v.string(),id:v.string(),number:v.number()},handler:async({db},a)=>{authorize(a.secret);const o:any=await db.query("changeOperations").withIndex("by_external_id",q=>q.eq("externalId",a.id)).unique();if(!o||(o.pullRequestNumber!==undefined&&o.pullRequestNumber!==a.number))return false;await db.patch(o._id,{pullRequestNumber:a.number,updatedAt:Date.now()});return true;}});

export const rerun = mutationGeneric({
  args:{secret:v.string(),repositoryId:v.string(),headSha:v.string()},
  handler:async({db},a)=>{authorize(a.secret);const rows:any[]=(await db.query("tasks").withIndex("by_repository_head",q=>q.eq("repositoryId",a.repositoryId)).collect()).filter((t:any)=>t.headSha===a.headSha);const now=Date.now();for(const t of rows)if(t.kind==="pr_review"&&["reviewing","publishing"].includes(t.state))await db.patch(t._id,{state:"waiting_for_ci",leaseToken:undefined,updatedAt:now});const completed=[];for(const t of rows.filter(t=>t.kind==="pr_review"&&t.state==="completed")){const peers:any[]=(await db.query("tasks").withIndex("by_conversation_head",q=>q.eq("conversationId",t.conversationId)).collect()).filter((p:any)=>p.headSha===t.headSha);const hasActive=peers.some(p=>p._id!==t._id&&p.kind==="pr_review"&&active(p.state));const c:any=await db.get(t.conversationId);if(c?.pullRequestNumber)completed.push({id:t.externalId,pull_request_number:c.pullRequestNumber,has_active:hasActive});}return completed;},
});
export const finalizeRerun = mutationGeneric({args:{secret:v.string(),taskId:v.string()},handler:async({db},a)=>{authorize(a.secret);const t:any=await db.query("tasks").withIndex("by_external_id",q=>q.eq("externalId",a.taskId)).unique();if(!t||t.state!=="completed")return null;const peers:any[]=(await db.query("tasks").withIndex("by_conversation_head",q=>q.eq("conversationId",t.conversationId)).collect()).filter((p:any)=>p.headSha===t.headSha);const hasActive=peers.some(p=>p._id!==t._id&&p.kind==="pr_review"&&active(p.state));await db.patch(t._id,{state:hasActive?"superseded":"waiting_for_ci",leaseToken:undefined,updatedAt:Date.now()});return hasActive?"superseded":"reopened";}});
export const supersedeCompleted = mutationGeneric({args:{secret:v.string(),taskId:v.string()},handler:async({db},a)=>{authorize(a.secret);const t:any=await db.query("tasks").withIndex("by_external_id",q=>q.eq("externalId",a.taskId)).unique();if(t?.state==="completed")await db.patch(t._id,{state:"superseded",leaseToken:undefined,updatedAt:Date.now()});return null;}});
export const cancelPullTasks = mutationGeneric({args:{secret:v.string(),repositoryId:v.string(),pullRequestNumber:v.number()},handler:async({db},a)=>{authorize(a.secret);const rows:any[]=await db.query("tasks").withIndex("by_repository_head",q=>q.eq("repositoryId",a.repositoryId)).collect();for(const t of rows){if(t.kind!=="pr_review"||!["queued","waiting_for_ci","reviewing","waiting_for_user"].includes(t.state))continue;const c:any=await db.get(t.conversationId);if(c?.pullRequestNumber===a.pullRequestNumber)await db.patch(t._id,{state:"cancelled",updatedAt:Date.now()});}return null;}});
export const claimWaiting = mutationGeneric({args:{secret:v.string(),repositoryId:v.string(),headSha:v.string(),pullRequestNumbers:v.array(v.number())},handler:async({db},a)=>{authorize(a.secret);const rows:any[]=(await db.query("tasks").withIndex("by_repository_head",q=>q.eq("repositoryId",a.repositoryId)).collect()).filter((t:any)=>t.headSha===a.headSha);for(const t of rows.sort((x,y)=>x._creationTime-y._creationTime)){if(t.state!=="waiting_for_ci")continue;const c:any=await db.get(t.conversationId);if(!a.pullRequestNumbers.includes(c?.pullRequestNumber))continue;const leaseToken=crypto.randomUUID();await db.patch(t._id,{state:"reviewing",leaseToken,updatedAt:Date.now()});return {id:t.externalId,lease_token:leaseToken};}return null;}});
export const supersedeOldHeads = mutationGeneric({args:{secret:v.string(),repositoryId:v.string(),pullRequestNumber:v.number(),headSha:v.string()},handler:async({db},a)=>{authorize(a.secret);const rows:any[]=await db.query("tasks").withIndex("by_repository_head",q=>q.eq("repositoryId",a.repositoryId)).collect();const completed=[];for(const t of rows){if(t.kind!=="pr_review"||t.headSha===a.headSha)continue;const c:any=await db.get(t.conversationId);if(c?.pullRequestNumber!==a.pullRequestNumber)continue;if(t.state==="completed")completed.push({id:t.externalId,head_sha:t.headSha});else if(["queued","waiting_for_ci","reviewing","waiting_for_user"].includes(t.state))await db.patch(t._id,{state:"superseded",updatedAt:Date.now()});}return completed;}});
