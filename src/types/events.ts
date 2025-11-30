import { z } from "zod";

// Severity levels
export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

// Bug report content (encrypted in NOSTR event)
export const BugReportContentSchema = z.object({
  bug_id: z.string().uuid(),
  repo: z.string().url(),
  file: z.string().optional(),
  line_start: z.number().optional(),
  line_end: z.number().optional(),
  description: z.string().min(10).max(10000),
  suggested_fix: z.string().optional(),
  severity: SeveritySchema,
  category: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  agent_model: z.string().optional(),
  agent_version: z.string().optional(),
  deposit_tx: z.string().optional(),
  deposit_amount: z.string().optional(),
});
export type BugReportContent = z.infer<typeof BugReportContentSchema>;

// Bug response content
export const ResponseTypeSchema = z.enum([
  "acknowledge",
  "accept",
  "reject",
  "fix_published",
]);
export type ResponseType = z.infer<typeof ResponseTypeSchema>;

export const BugResponseContentSchema = z.object({
  report_id: z.string().uuid(),
  response_type: ResponseTypeSchema,
  message: z.string().optional(),
  commit_hash: z.string().optional(),
  bounty_paid: z.string().optional(),
});
export type BugResponseContent = z.infer<typeof BugResponseContentSchema>;

// Bounty announcement
export const BountySchema = z.object({
  bounty_id: z.string().uuid(),
  repo: z.string().url(),
  severity: SeveritySchema.optional(),
  amount: z.string(),
  coin_id: z.string(),
  description: z.string().optional(),
  expires_at: z.number().optional(),
});
export type Bounty = z.infer<typeof BountySchema>;
