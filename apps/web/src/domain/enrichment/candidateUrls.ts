import type { TierNumber } from "@/shared/schema";

// Tier-1 candidate derivation (PLAN.md §4 Stage 2): purely mechanical URLs on
// the company's own host — the homepage plus the four highest-signal paths.
// ≤ 5 candidates, one host: the per-host limiter serializes them and risk 9
// caps the same-host burst.

export interface EnrichmentCandidate {
  url: string;
  tier: Exclude<TierNumber, 0>;
  /** Human step label ("Reading careers page…") — reaches the timeline. */
  label: string;
  /** Slug-guessed fallback (decision 20): may count as found ONLY when the
   *  fetched page loosely matches the company name. */
  requiresNameMatch?: boolean;
}

const TIER1_PATHS: { path: string; label: string }[] = [
  { path: "/", label: "Reading company homepage…" },
  { path: "/about", label: "Reading about page…" },
  { path: "/careers", label: "Reading careers page…" },
  { path: "/jobs", label: "Reading jobs page…" },
  { path: "/product", label: "Reading product page…" },
];

export function tier1Candidates(domain: string | undefined): EnrichmentCandidate[] {
  if (!domain) return [];
  let origin: string;
  try {
    // domainDeriver already validated the shape; this is a cheap backstop
    // against anything else that ends up in profile.domain.
    origin = new URL(`https://${domain}`).origin;
  } catch {
    return [];
  }
  return TIER1_PATHS.map(({ path, label }) => ({ url: `${origin}${path}`, tier: 1, label }));
}

/**
 * Dedup key shared by the enricher and link discovery: fragment stripped,
 * trailing slash normalized ("/about" and "/about/" are the same candidate).
 * Query strings stay significant — two news articles can differ only there.
 */
export function urlKey(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return raw;
  }
}
