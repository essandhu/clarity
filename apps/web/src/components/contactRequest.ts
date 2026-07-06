import type { ContactRequest, ListingProfile, TierNumber } from "@/shared/schema";
import type { RunState } from "./runState";

// RunState.tiers (a sparse record filled by enrichment.tier.completed frames)
// → the /api/contact request's coverage array. Pure so the wire shape is
// pinned by a unit test against ContactRequestSchema.

const TIER_NUMBERS: readonly TierNumber[] = [0, 1, 2, 3];

export function buildContactRequest(
  profile: ListingProfile,
  tiers: RunState["tiers"],
): ContactRequest {
  return {
    profile,
    coverage: {
      tiers: TIER_NUMBERS.flatMap((tier) => {
        const entry = tiers[tier];
        return entry ? [{ tier, status: entry.status, sources: entry.sources }] : [];
      }),
    },
  };
}
