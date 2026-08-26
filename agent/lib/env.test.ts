import { describe, expect, it } from "vitest";
import { positiveInteger } from "./env.js";

describe("positiveInteger", () => {
  it("uses the fallback and accepts positive safe integers", () => {
    expect(positiveInteger("LIMIT", undefined, 3)).toBe(3);
    expect(positiveInteger("LIMIT", "20", 3)).toBe(20);
  });

  it("rejects values that could disable a safety bound", () => {
    for (const value of ["three", "20kb", "NaN", "Infinity", "0", "-1", "1.5"]) {
      expect(() => positiveInteger("LIMIT", value, 3)).toThrow(
        "LIMIT must be a positive integer",
      );
    }
  });
});
