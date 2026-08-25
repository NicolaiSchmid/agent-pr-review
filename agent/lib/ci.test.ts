import { describe, expect, it } from "vitest";
import { summarizeChecks } from "./ci.js";

describe("CI aggregation", () => {
  it("waits until every observed check is terminal", () => {
    expect(summarizeChecks([
      { name: "test", status: "completed", conclusion: "success" },
      { name: "lint", status: "in_progress", conclusion: null },
    ])).toEqual({ terminal: false, pending: ["lint"], failed: [] });
  });

  it("treats failed checks as terminal evidence", () => {
    expect(summarizeChecks([
      { name: "test", status: "completed", conclusion: "failure" },
    ])).toEqual({
      terminal: true,
      pending: [],
      failed: [{ name: "test", conclusion: "failure" }],
    });
  });

  it("keeps completed checks without a conclusion unresolved", () => {
    expect(summarizeChecks([
      { name: "deploy", status: "completed", conclusion: null },
    ])).toEqual({ terminal: false, pending: ["deploy"], failed: [] });
  });
});
