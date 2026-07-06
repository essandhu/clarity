import type { ContactSource, ContactCoverage } from "@/providers/contact/ContactSource";
import type { ContactCandidate, ContactConfidence, ListingProfile } from "@/shared/schema";

// Stage 4 orchestration (PLAN.md §4): run the configured ContactSource[]
// (v1: exactly PublicSourceContactSurfacer), concatenate, sort
// verified > public > guess, dedupe, cap at 5, strip phone-shaped strings
// (§7: no phone numbers — needless for job outreach). Lives OUTSIDE
// runAnalysis (decision 27): /api/contact is a separate, user-initiated
// route and nothing here is ever persisted.

export const MAX_CANDIDATES = 5;

// The "small 3-fetch contact budget" (§3 sibling routes) and its wall-clock
// bound — route-owned timers arm the deadline; the domain stays timer-free.
export const CONTACT_MAX_FETCHES = 3;
export const CONTACT_DEADLINE_MS = 30_000;

const CONFIDENCE_RANK: Record<ContactConfidence, number> = {
  verified: 0,
  public: 1,
  guess: 2,
};

// 7+ digits in one separator-linked run is phone-shaped; shorter runs (years,
// team sizes, zip-ish codes) survive. Applied to every candidate field.
const PHONE_CANDIDATE = /[+(]?\d[\d\s()./-]{5,}\d/g;
const digitCount = (text: string): number => text.match(/\d/g)?.length ?? 0;

/** Delete phone-shaped substrings (§7). URLs are left alone — a LinkedIn
 *  search URL's encoded digits are not a phone number. */
export function stripPhoneShapes(text: string): string {
  if (/^https?:\/\//i.test(text.trim())) return text.trim();
  return text
    .replace(PHONE_CANDIDATE, (match) => (digitCount(match) >= 7 ? " " : match))
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function surfaceContacts(
  profile: ListingProfile,
  coverage: ContactCoverage,
  sources: ContactSource[],
): Promise<ContactCandidate[]> {
  const found: ContactCandidate[] = [];
  // Sequential on purpose: v1 has one source, and a future second source
  // should not race the shared contact budget.
  for (const source of sources) {
    found.push(...(await source.find(profile, coverage)));
  }
  return rankCandidates(found);
}

/** The §4 pipeline over raw candidates: sanitize → rank → dedupe → cap. Pure
 *  and exported so the rules are unit-testable without any source. */
export function rankCandidates(candidates: ContactCandidate[]): ContactCandidate[] {
  const sanitized = candidates.flatMap((candidate) => {
    const clean = sanitizeCandidate(candidate);
    return clean ? [clean] : [];
  });
  // Array.prototype.sort is stable: within a confidence band, source order
  // (listing → careers → github → per-person guesses) is preserved.
  const ranked = [...sanitized].sort(
    (a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
  );
  const seen = new Set<string>();
  const out: ContactCandidate[] = [];
  for (const candidate of ranked) {
    const key = dedupeKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/** Phone-strip every text field; a candidate left with neither a name nor a
 *  value has nothing to show and is dropped. */
function sanitizeCandidate(candidate: ContactCandidate): ContactCandidate | undefined {
  const clean = (field?: string): string | undefined => {
    if (field === undefined) return undefined;
    const stripped = stripPhoneShapes(field);
    return stripped ? stripped : undefined;
  };
  const name = clean(candidate.name);
  const role = clean(candidate.role);
  const value = clean(candidate.value);
  if (!name && !value) return undefined;
  return { ...candidate, name, role, value };
}

// The same email surfacing via two channels (listing + careers) is one
// contact; the same person with no value competes per channel (a LinkedIn
// pointer and an inferred email for one name are distinct outputs).
function dedupeKey(candidate: ContactCandidate): string {
  if (candidate.value) return `value:${candidate.value.toLowerCase()}`;
  return `${candidate.channel}:${(candidate.name ?? "").toLowerCase()}`;
}
