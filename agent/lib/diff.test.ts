import { describe, expect, it } from "vitest";
import { changedLines, findingMarker, validateAndDedupeFindings } from "./diff.js";
import type { PullFile } from "./github.js";
import type { Finding } from "./result.js";

const files: PullFile[] = [
  {
    filename: "src/example.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -10,3 +10,3 @@\n same\n-old\n+new\n end",
  },
];
const finding: Finding = {
  severity: "high",
  path: "src/example.ts",
  line: 11,
  side: "RIGHT",
  title: "Breaks the contract",
  body: "This returns the wrong value.",
  evidence: "Focused test fails.",
};

describe("diff validation", () => {
  it("tracks modern left and right diff lines", () => {
    expect(changedLines(files)).toEqual(
      new Set(["src/example.ts:LEFT:11", "src/example.ts:RIGHT:11"]),
    );
  });

  it("drops invalid, duplicate, and already-published findings", () => {
    const invalid = { ...finding, line: 99 };
    expect(validateAndDedupeFindings("head", [finding, finding, invalid], files)).toEqual([finding]);
    expect(
      validateAndDedupeFindings("head", [finding], files, [findingMarker("head", finding)]),
    ).toEqual([]);
  });
});
