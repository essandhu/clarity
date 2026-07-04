import { z } from "zod";
import { HttpUrlSchema } from "./sourceRef";

// One shared taxonomy for fetcher-produced AND pipeline-produced skips.
// Skips are data, not errors: returned, never thrown, folded into coverage.
export const FetchSkipReasonSchema = z.enum([
  "robots_disallowed",
  "timeout",
  "http_status",
  "not_html",
  "network",
  "too_large",
  "empty_content",
  "circuit_open",
  "budget_exhausted",
  "cancelled",
]);
export type FetchSkipReason = z.infer<typeof FetchSkipReasonSchema>;

export const FetchSkipSchema = z.object({
  kind: z.literal("skip"),
  // Always set by the fetcher; optional because pipeline-produced skips on
  // non-fetch steps (a cancelled hooks/synthesis step) have no URL to cite.
  url: HttpUrlSchema.optional(),
  reason: FetchSkipReasonSchema,
  detail: z.string().optional(),
  httpStatus: z.number().int().optional(),
});
export type FetchSkip = z.infer<typeof FetchSkipSchema>;

export const CleanPageSchema = z.object({
  kind: z.literal("page"),
  url: HttpUrlSchema,
  finalUrl: HttpUrlSchema,
  title: z.string(),
  text: z.string(),
  fetchedAt: z.iso.datetime(),
});
export type CleanPage = z.infer<typeof CleanPageSchema>;
