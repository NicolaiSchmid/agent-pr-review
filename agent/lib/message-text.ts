type MessageCompletedEvent = {
  type: "message.completed";
  data: {
    finishReason:
      | "content-filter"
      | "error"
      | "length"
      | "other"
      | "stop"
      | "tool-calls";
    message: string | null;
    sequence: number;
    stepIndex: number;
    turnId: string;
  };
};

export const extractCompletedAssistantText = (event: MessageCompletedEvent) =>
  event.data.finishReason === "tool-calls" ? "" : (event.data.message ?? "");
