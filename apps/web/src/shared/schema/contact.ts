import { z } from "zod";
import { TierNumberSchema, TierStatusSchema } from "./enrichment";
import { FetchSkipSchema } from "./fetch";
import { ListingProfileSchema } from "./listingProfile";
import { SourceRefSchema } from "./sourceRef";

export const ContactChannelSchema = z.enum([
  "listing",
  "careers",
  "github",
  "linkedin",
  "inferred-email",
]);
export type ContactChannel = z.infer<typeof ContactChannelSchema>;

// Nothing labeled 'guess' may ever be presented as fact: the UI styles it
// dashed/unverified, and a guessed email enters a mailto: target only after
// an explicit "use this guess" click.
export const ContactConfidenceSchema = z.enum(["verified", "public", "guess"]);
export type ContactConfidence = z.infer<typeof ContactConfidenceSchema>;

export const ContactCandidateSchema = z.object({
  name: z.string().optional(),
  role: z.string().optional(),
  channel: ContactChannelSchema,
  value: z.string().optional(),
  confidence: ContactConfidenceSchema,
  // Mandatory: even linkedin candidates cite the page the name came from;
  // 'listing' candidates from pasted text cite pastedListingRef.
  source: SourceRefSchema,
});
export type ContactCandidate = z.infer<typeof ContactCandidateSchema>;

// POST /api/contact wire shapes. The route re-reads pages through the
// cache-backed PageFetcher — SourceRefs only, page text never round-trips.
export const ContactRequestSchema = z.object({
  profile: ListingProfileSchema,
  coverage: z.object({
    tiers: z.array(
      z.object({
        tier: TierNumberSchema,
        status: TierStatusSchema,
        sources: z.array(SourceRefSchema),
      }),
    ),
  }),
});
export type ContactRequest = z.infer<typeof ContactRequestSchema>;

export const ContactSourceTriedSchema = z.object({
  id: z.string(),
  status: z.enum(["found", "none", "skipped"]),
  skip: FetchSkipSchema.optional(),
});
export type ContactSourceTried = z.infer<typeof ContactSourceTriedSchema>;

export const ContactResponseSchema = z.object({
  candidates: z.array(ContactCandidateSchema),
  sourcesTried: z.array(ContactSourceTriedSchema),
});
export type ContactResponse = z.infer<typeof ContactResponseSchema>;
