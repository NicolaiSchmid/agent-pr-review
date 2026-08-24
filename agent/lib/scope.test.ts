import { describe, expect, it } from "vitest";
import {
  continuationTokenFor,
  parseContinuationToken,
  parseSessionFailedRecovery,
  scopeFromContext,
} from "./scope.js";
import type { ReviewScope } from "./scope.js";

const scope: ReviewScope = {
  owner: "NicolaiSchmid",
  repo: "nunc-immo",
  number: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseRef: "main",
  headRef: "feature",
  deliveryId: "d",
  fork: "false",
  allowExecution: "true",
};

describe("trusted scope", () => {
  it("reads auth attributes and round-trips durable identity", () => {
    expect(
      scopeFromContext({ session: { auth: { initiator: { attributes: scope } } } }),
    ).toEqual(scope);
    expect(parseContinuationToken(continuationTokenFor(scope))).toMatchObject({
      number: 1,
      headSha: scope.headSha,
    });
  });

  it("rejects a model-controlled repository", () => {
    expect(() =>
      scopeFromContext({
        session: { auth: { initiator: { attributes: { ...scope, repo: "other" } } } },
      }),
    ).toThrow("outside");
  });

  it("recovers scope from an Eve-namespaced session.failed event", () => {
    const event = {
      type: "session.failed" as const,
      data: {
        code: "workflow_failed",
        message: "review crashed",
        sessionId: "session-1",
      },
    };
    expect(
      parseSessionFailedRecovery(
        event,
        `github:${continuationTokenFor(scope)}`,
      ),
    ).toEqual({
      scope: {
        owner: "nicolaischmid",
        repo: "nunc-immo",
        number: 1,
        headSha: scope.headSha,
      },
      failure: event.data,
    });
  });
});
