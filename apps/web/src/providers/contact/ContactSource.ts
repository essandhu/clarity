import type { ContactCandidate, ContactRequest, ListingProfile } from "@/shared/schema";

// The §4.3 ContactSource seam. This file is types-only: it is one of the five
// provider interface files src/domain/** is allowed to import (eslint layering
// rule) — implementations are wired in by the /api/contact route. The seam
// exists so a paid enrichment provider could be added later; v1 ships exactly
// one implementation (PublicSourceContactSurfacer) with NO paid dependency.

/**
 * Coverage as it reaches /api/contact: per-tier statuses + SourceRefs ONLY.
 * Extracted page text never round-trips through the client (decision 19) —
 * a source that needs page content re-reads it through the PageFetcher.
 */
export type ContactCoverage = ContactRequest["coverage"];

export interface ContactSource {
  id: string;
  find(profile: ListingProfile, coverage: ContactCoverage): Promise<ContactCandidate[]>;
}
