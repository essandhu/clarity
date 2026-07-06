import { z } from "zod";
import { firstEmail, soleEmail } from "@/domain/contact/emailPattern";
import { isPublicHttpHost, urlKey } from "@/domain/enrichment/candidateUrls";
import type { SectionExcerpt } from "@/domain/synthesis/sectionSources";
import type { ContactCandidate, SourceRef } from "@/shared/schema";
import type { ContactCoverage } from "./ContactSource";

// The pure half of PublicSourceContactSurfacer — a pre-split under the
// ~200-line ceiling: people grounding, the listing candidate, and coverage
// ref picking. No I/O and no model calls live here.

export const MAX_CONTACT_PEOPLE = 3;

// Model-facing shape (decision-18 pattern): citations are raw URL strings the
// domain maps back to refs it actually holds; unattributable people are
// dropped, never re-homed. maxItems is looser than MAX_CONTACT_PEOPLE so an
// overeager model loses its tail, not the run.
export const PeopleSchema = z.object({
  people: z
    .array(
      z.object({
        name: z.string().min(1),
        role: z.string().optional(),
        email: z.string().optional(),
        sourceUrl: z.string().min(1),
      }),
    )
    .max(6),
});

export interface NamedPerson {
  name: string;
  role?: string;
  email?: string;
  ref: SourceRef;
}

/** Citation validation for people (decision 18): keep only people whose
 *  sourceUrl resolves to an excerpt this search actually holds, and keep an
 *  email only when it LITERALLY appears in the excerpt text the model was
 *  shown — a model-invented address must never wear the 'public' badge
 *  (review finding: it would bypass decision 28's guess gate into mailto). */
export function groundPeople(
  raw: z.infer<typeof PeopleSchema>["people"],
  excerpts: readonly SectionExcerpt[],
): NamedPerson[] {
  const known = new Map(excerpts.map((excerpt) => [urlKey(excerpt.ref.url), excerpt.ref] as const));
  const sourceTexts = excerpts.map((excerpt) => excerpt.text.toLowerCase());
  const people: NamedPerson[] = [];
  const seenNames = new Set<string>();
  for (const person of raw) {
    if (people.length >= MAX_CONTACT_PEOPLE) break;
    const ref = known.get(urlKey(person.sourceUrl));
    if (!ref) continue; // fabricated attribution — drop, never re-home
    const name = person.name.trim();
    const nameKey = name.toLowerCase();
    if (!name || name.includes("@") || seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
    const stated = person.email ? firstEmail(person.email) : undefined;
    const email =
      stated && sourceTexts.some((text) => text.includes(stated.toLowerCase()))
        ? stated
        : undefined;
    people.push({ name, role: person.role?.trim() || undefined, email, ref });
  }
  return people;
}

/**
 * The listing's published application contact as a candidate. The stated
 * applicationContact drives it; when that carries no email-shaped value —
 * Stage 1's small model sometimes garbles an address (live-observed:
 * "recruiting@dr:driftlock.io"), or names a person without one — the pasted
 * listing TEXT is the published source of truth (spec §6.1), so its one
 * unambiguous email is used instead. Nothing here is inferred: every value
 * literally appears in the listing.
 */
export function listingCandidate(
  contactText: string | undefined,
  rawText: string,
  listingRef: SourceRef,
): ContactCandidate | undefined {
  const base = { channel: "listing", confidence: "public", source: listingRef } as const;
  const stated = contactText?.trim() || undefined;
  const statedEmail = stated ? firstEmail(stated) : undefined;
  if (stated && statedEmail) {
    const remainder = stated
      .replace(statedEmail, " ")
      .replace(/[<>():,;]/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    return { ...base, name: remainder || undefined, value: statedEmail };
  }
  if (stated && /^https?:\/\//i.test(stated)) return { ...base, name: undefined, value: stated };
  const published = soleEmail(rawText);
  if (stated) {
    // A garbled email-ish string is not a person name — show only the real
    // published address it presumably meant.
    const name = stated.includes("@") ? undefined : stated;
    return name || published ? { ...base, name, value: published } : undefined;
  }
  if (published) return { ...base, name: undefined, value: published };
  return undefined;
}

// Whole path segments, not substrings: "/blog/steve-jobs-tribute" and
// "/joint-venture" must not read as careers pages (review finding).
const CAREERS_SEGMENTS = new Set([
  "careers", "career", "jobs", "job", "join", "join-us", "joinus",
  "hiring", "recruiting", "recruitment", "vacancies", "work-with-us",
]);
const CAREERS_HOST = /^(careers|jobs)\./i;

/** The careers-ish page the run already found, tier 1 outward. Private hosts
 *  are never picked: coverage is client-supplied, and this is the route's one
 *  non-github re-fetch (the increment-6 SSRF rule applied to /api/contact).
 *  The pasted-listing sentinel is not a URL and can never be picked. */
export function pickCareersRef(coverage: ContactCoverage): SourceRef | undefined {
  for (const tierNumber of [1, 2, 3] as const) {
    for (const ref of coverage.tiers.find((tier) => tier.tier === tierNumber)?.sources ?? []) {
      try {
        const url = new URL(ref.url);
        if (!/^https?:$/.test(url.protocol) || !isPublicHttpHost(url.hostname)) continue;
        const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
        if (segments.some((segment) => CAREERS_SEGMENTS.has(segment))) return ref;
        if (CAREERS_HOST.test(url.hostname)) return ref;
      } catch {
        // Not parseable as a URL — never picked.
      }
    }
  }
  return undefined;
}

/**
 * The request-time public-host guard covers the URL we DIAL; this covers
 * where the server REDIRECTED us (review finding: a crafted/compromised
 * public host could 30x a contact re-fetch at an internal or cloud-metadata
 * address). Content from a non-public final host is never used.
 */
export function isPublicFinalPage(finalUrl: string): boolean {
  try {
    const url = new URL(finalUrl);
    return /^https?:$/.test(url.protocol) && isPublicHttpHost(url.hostname);
  } catch {
    return false;
  }
}

/** The right channel over a raw address (spec §6.4): a people-search URL —
 *  constructed, not found, so its candidates are always 'guess'. */
export function linkedInSearchUrl(name: string, company: string): string {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${name} ${company}`)}`;
}
