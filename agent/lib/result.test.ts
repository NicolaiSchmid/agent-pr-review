import { describe, expect, it } from "vitest";
import { parseReviewResult } from "./result.js";

const valid = {
  version: 2,
  summary: "No defects found.",
  tests: [{ command: "pnpm test", result: "passed" }],
  findings: [],
  changes: [],
};

describe("parseReviewResult", () => {
  it("parses raw and fenced JSON", () => {
    expect(parseReviewResult(JSON.stringify(valid))).toEqual(valid);
    expect(parseReviewResult(`Result:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).toEqual(valid);
  });

  it("rejects malformed contracts", () => {
    expect(() => parseReviewResult('{"version":1,"summary":"x"}')).toThrow(
      "valid review result",
    );
  });

  it("defaults omitted changes to an empty array so reviews still publish", () => {
    const { changes: _changes, ...withoutChanges } = valid;
    expect(parseReviewResult(JSON.stringify(withoutChanges))).toEqual({
      ...withoutChanges,
      changes: [],
    });
  });
});
