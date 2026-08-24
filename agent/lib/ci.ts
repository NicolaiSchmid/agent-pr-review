import { z } from "zod";

export const checkSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z.string().nullable(),
});

export type Check = z.infer<typeof checkSchema>;

export const summarizeChecks = (checks: Check[]) => {
  const pending = checks.filter((check) => check.status !== "completed");
  const failed = checks.filter(
    (check) =>
      check.status === "completed" &&
      check.conclusion !== null &&
      !["success", "neutral", "skipped"].includes(check.conclusion),
  );
  return {
    terminal: checks.length > 0 && pending.length === 0,
    pending: pending.map((check) => check.name),
    failed: failed.map((check) => ({
      name: check.name,
      conclusion: check.conclusion!,
    })),
  };
};
