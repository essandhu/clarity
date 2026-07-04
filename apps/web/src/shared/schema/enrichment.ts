import { z } from "zod";
import { SourceRefSchema } from "./sourceRef";

export const TierNumberSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type TierNumber = z.infer<typeof TierNumberSchema>;

export const TierStatusSchema = z.enum(["found", "not_found", "skipped_budget"]);
export type TierStatus = z.infer<typeof TierStatusSchema>;

export const TierCoverageSchema = z.object({
  tier: TierNumberSchema,
  status: TierStatusSchema,
  sources: z.array(SourceRefSchema),
  // Per-source capped page text. SERVER-SIDE ONLY — never on the wire.
  extracted: z.record(z.string(), z.unknown()),
});
export type TierCoverage = z.infer<typeof TierCoverageSchema>;

export const EnrichmentResultSchema = z.object({
  tiers: z.array(TierCoverageSchema),
  fetchesUsed: z.number().int().nonnegative(),
});
export type EnrichmentResult = z.infer<typeof EnrichmentResultSchema>;

// What enrichment.completed carries: counts only. Per-tier SourceRef[] already
// arrived via enrichment.tier.completed, and extracted text stays server-side.
export const EnrichmentWireSummarySchema = z.object({
  tiers: z.array(
    z.object({
      tier: TierNumberSchema,
      status: TierStatusSchema,
      sourceCount: z.number().int().nonnegative(),
    }),
  ),
  fetchesUsed: z.number().int().nonnegative(),
});
export type EnrichmentWireSummary = z.infer<typeof EnrichmentWireSummarySchema>;
