import { describe, expect, it } from "vitest";
import { createSandboxNetworkPolicy } from "./sandbox-policy.js";

describe("sandbox credential brokering", () => {
  it("places a read-only token only in the github.com firewall transform", () => {
    const policy = createSandboxNetworkPolicy("read-only-secret");
    const serialized = JSON.stringify(policy);
    expect(policy.allow["github.com"]).toEqual([
      {
        transform: [
          {
            headers: {
              authorization: `Basic ${Buffer.from("x-access-token:read-only-secret").toString("base64")}`,
            },
          },
        ],
      },
    ]);
    expect(serialized).not.toContain("GITHUB_TOKEN");
    expect(serialized).not.toContain("GITHUB_SANDBOX_TOKEN");
  });

  it("adds no authorization transform when no read-only token exists", () => {
    expect(createSandboxNetworkPolicy().allow["github.com"]).toEqual([]);
  });
});
