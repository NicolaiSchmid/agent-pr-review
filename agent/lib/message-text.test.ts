import { describe, expect, it } from "vitest";
import { extractCompletedAssistantText } from "./message-text.js";

const event = (
  finishReason: "stop" | "tool-calls",
  message: string | null,
) => ({
  type: "message.completed" as const,
  data: {
    finishReason,
    message,
    sequence: 4,
    stepIndex: 2,
    turnId: "turn-1",
  },
});

describe("Eve message.completed extraction", () => {
  it("reads the terminal assistant text from event.data.message", () => {
    expect(extractCompletedAssistantText(event("stop", "final JSON"))).toBe(
      "final JSON",
    );
  });

  it("ignores interim tool-call completions and null messages", () => {
    expect(
      extractCompletedAssistantText(event("tool-calls", "interim text")),
    ).toBe("");
    expect(extractCompletedAssistantText(event("stop", null))).toBe("");
  });
});
