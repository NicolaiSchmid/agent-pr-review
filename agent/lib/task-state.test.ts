import { describe, expect, it } from "vitest";
import { canTransitionTask, reviewConversationKey, reviewPassKey, transitionTask } from "./task-state.js";

describe("task lifecycle", () => {
  it("supports CI deferral and immutable head passes", () => {
    expect(canTransitionTask("queued", "waiting_for_ci")).toBe(true);
    expect(transitionTask("waiting_for_ci", "reviewing")).toBe("reviewing");
    expect(transitionTask("waiting_for_user", "superseded")).toBe("superseded");
    expect(() => transitionTask("completed", "reviewing")).toThrow();
    const conversation = reviewConversationKey({
      installationId: "42",
      owner: "Acme",
      repo: "Web",
      pullRequest: 7,
    });
    expect(conversation).toBe("github:42:acme/web#7");
    expect(reviewPassKey(conversation, "ABC1234")).toBe(`${conversation}@abc1234`);
  });
});
