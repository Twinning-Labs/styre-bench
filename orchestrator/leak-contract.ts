import { z } from "zod";

const count = z.number().int().nonnegative();
export const TranscriptScanSchema = z
  .object({
    status: z.enum(["complete", "partial", "unstructured", "unavailable"]),
    assistant_messages: count,
    unparsed_lines: count,
    unknown_entries: count,
  })
  .superRefine((s, ctx) => {
    if (
      s.status === "complete" &&
      (s.assistant_messages === 0 || s.unparsed_lines > 0 || s.unknown_entries > 0)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "complete coverage requires parsed assistant messages and no parser holes",
      });
    if (
      s.status === "unavailable" &&
      (s.assistant_messages || s.unparsed_lines || s.unknown_entries)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "unavailable coverage cannot contain observations",
      });
  });
const measurements = {
  exposure: z.literal("unknown"),
  network_indicators: z.array(z.string()),
  transcript_scan: TranscriptScanSchema,
  fix_changed_lines: count.optional(),
  similarity: z.number().min(0).max(1).optional(),
  containment: z.number().min(0).max(1).nullable().optional(),
};
/** Validate the Python boundary before accepting even a negative heuristic result. */
export const LeakResultSchema = z.object({
  suspected: z.boolean(),
  reasons: z.array(z.string()),
  ...measurements,
});
export const LeakCheckSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-run"), reason: z.string().min(1) }),
  z.object({ status: z.literal("error"), reason: z.string().min(1) }),
  z.object({
    status: z.literal("completed"),
    scope: z.enum(["full", "transcript-only"]),
    reason: z.string().optional(),
    ...measurements,
  }),
]);
export type LeakResult = z.infer<typeof LeakResultSchema>;
export type LeakCheck = z.infer<typeof LeakCheckSchema>;
