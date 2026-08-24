import { z } from "zod";

export const findingSchema = z.object({
  severity: z.enum(["critical", "high", "medium", "low"]),
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: z.enum(["LEFT", "RIGHT"]),
  title: z.string().min(1).max(160),
  body: z.string().min(1),
  evidence: z.string().min(1),
  suggestion: z.string().min(1).optional(),
});

export const reviewResultSchema = z.object({
  version: z.literal(1),
  summary: z.string().min(1),
  tests: z.array(
    z.object({
      command: z.string().min(1),
      result: z.enum(["passed", "failed", "skipped"]),
      details: z.string().optional(),
    }),
  ),
  findings: z.array(findingSchema),
});

export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type Finding = z.infer<typeof findingSchema>;

export const parseReviewResult = (text: string): ReviewResult => {
  const trimmed = text.trim();
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(
    (match) => match[1]!.trim(),
  );
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  const candidates = [
    trimmed,
    ...fenced,
    ...(firstBrace >= 0 && lastBrace > firstBrace
      ? [trimmed.slice(firstBrace, lastBrace + 1)]
      : []),
  ];
  for (const candidate of candidates) {
    try {
      return reviewResultSchema.parse(JSON.parse(candidate));
    } catch {
      // Try the next extraction form.
    }
  }
  throw new Error("Assistant completion did not contain a valid review result JSON object");
};
