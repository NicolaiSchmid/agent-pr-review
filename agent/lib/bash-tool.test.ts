import { describe, expect, it } from "vitest";
import bash from "../tools/bash.js";

describe("fork execution policy", () => {
  it("denies shell execution from immutable fork scope", async () => {
    const output = await bash.execute(
      { command: "exit 0" },
      {
        session: {
          auth: {
            initiator: {
              attributes: {
                owner: "NicolaiSchmid",
                repo: "nunc-immo",
                number: "1",
                baseSha: "a".repeat(40),
                headSha: "b".repeat(40),
                baseRef: "main",
                headRef: "fork",
                deliveryId: "d",
                fork: "true",
                allowExecution: "false",
              },
            },
          },
        },
      } as never,
    );
    expect(output).toMatchObject({ exitCode: 126 });
  });
});
