import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluatePullRequestEvent, isOwnStackedPull, verifyWebhookSignature } from "./webhook.js";

const payload = (overrides: Record<string, unknown> = {}) => ({
  action: "opened",
  installation: { id: 42 },
  repository: { name: "nunc-immo", owner: { login: "NicolaiSchmid" } },
  sender: { login: "human", type: "User" },
  pull_request: {
    number: 7,
    draft: false,
    user: { login: "human", type: "User" },
    base: {
      sha: "a".repeat(40),
      ref: "main",
      repo: { name: "nunc-immo", owner: { login: "NicolaiSchmid" } },
    },
    head: {
      sha: "b".repeat(40),
      ref: "feature",
      repo: { name: "nunc-immo", owner: { login: "NicolaiSchmid" } },
    },
  },
  ...overrides,
});

describe("webhook authentication", () => {
  it("verifies exact raw bytes", () => {
    const body = Buffer.from('{"hello":"world"}');
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifyWebhookSignature(body, signature, "secret")).toBe(true);
    expect(verifyWebhookSignature(Buffer.from("changed"), signature, "secret")).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=bad", "secret")).toBe(false);
  });
});

describe("pull request event filtering", () => {
  it("accepts target pushes with immutable scope", () => {
    const decision = evaluatePullRequestEvent(payload({ action: "synchronize" }), "delivery");
    expect(decision.accepted).toBe(true);
    if (decision.accepted) {
      expect(decision.scope).toMatchObject({
        owner: "NicolaiSchmid",
        repo: "nunc-immo",
        number: 7,
        headSha: "b".repeat(40),
        deliveryId: "delivery",
        allowExecution: "true",
      });
    }
  });

  it("ignores other repos, drafts, actions, and bots", () => {
    expect(evaluatePullRequestEvent(payload({ action: "closed" }), "d")).toMatchObject({ reason: "action_ignored" });
    expect(
      evaluatePullRequestEvent(
        payload({ repository: { name: "other", owner: { login: "NicolaiSchmid" } } }),
        "d",
      ),
    ).toMatchObject({ reason: "repository_ignored" });
    const draft = payload();
    draft.pull_request.draft = true;
    expect(evaluatePullRequestEvent(draft, "d")).toMatchObject({ reason: "draft_ignored" });
    expect(
      evaluatePullRequestEvent(payload({ sender: { login: "eve[bot]", type: "Bot" } }), "d"),
    ).toMatchObject({ reason: "bot_ignored" });
  });

  it("marks fork execution as denied", () => {
    const fork = payload();
    fork.pull_request.head.repo = { name: "nunc-immo", owner: { login: "contributor" } };
    const decision = evaluatePullRequestEvent(fork, "d");
    expect(decision.accepted && decision.scope.allowExecution).toBe("false");
  });

  it("recognizes only marked pull requests owned by the configured bot", () => {
    const marked = { user: { login: "eve[bot]" }, body: "<!-- eve-review-stack:root=7;round=1;parent=7 -->" };
    expect(isOwnStackedPull(marked, "eve[bot]")).toBe(true);
    expect(isOwnStackedPull({ ...marked, user: { login: "other[bot]" } }, "eve[bot]")).toBe(false);
    expect(isOwnStackedPull({ ...marked, body: "ordinary PR" }, "eve[bot]")).toBe(false);
  });

  it("reports missing bot configuration for marked stacked webhooks", () => {
    const event = payload({ sender: { login: "eve[bot]", type: "Bot" } });
    event.pull_request.user = { login: "eve[bot]", type: "Bot" };
    Object.assign(event.pull_request, {
      body: "<!-- eve-review-stack:root=7;round=1;parent=7 -->",
    });
    expect(evaluatePullRequestEvent(event, "d")).toEqual({
      accepted: false,
      reason: "bot_login_required",
    });
  });

});
