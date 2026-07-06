import type {
  Confidence,
  EnrichmentResult,
  ListingProfile,
  SectionId,
  SourceRef,
} from "@/shared/schema";
import { SECTION_PLAN } from "@/shared/schema";
import {
  byKind,
  capExcerpt,
  classifySources,
  MAX_SECTION_WEB_SOURCES,
  pathOf,
  rankByUrl,
  SECTION_EXCERPT_CAP,
  type ClassifiedSource,
  type SectionExcerpt,
} from "./sectionSources";

// Coverage -> per-section confidence + citations + prompt material (PLAN.md
// §4 Stage 3, decision 16). Pure rules, never self-reported by the model:
// `high` needs a relevant non-listing source, `low` means only the listing
// supports the section (and always cites the listing ref — real or pasted),
// `none` means nothing does and the section is canned with NO model call.

export interface PlannedSection {
  id: SectionId;
  title: string;
  confidence: Confidence;
  /** Exactly what synthesis.section.started/completed cite (empty iff none). */
  sources: SourceRef[];
  /** Prompt material, parallel to sources. SERVER-SIDE ONLY, never on the wire. */
  excerpts: SectionExcerpt[];
}

interface SectionRule {
  title: string;
  /** Ranked non-listing sources that ground the section as 'high'. */
  web(sources: ClassifiedSource[]): ClassifiedSource[];
  /** Whether the LISTING itself has material for the section ('low' support). */
  listing(profile: ListingProfile): boolean;
}

const sitePages = (sources: ClassifiedSource[], pattern: RegExp) =>
  byKind(sources, "site").filter((source) => pattern.test(pathOf(source.ref.url)));

const SECTION_RULES: Record<SectionId, SectionRule> = {
  "what-they-do": {
    title: "What they do",
    web: (s) => [
      ...rankByUrl(byKind(s, "site"), ["home", "about", "product"]),
      ...byKind(s, "github"),
    ],
    // Every listing says something about its company — worst case the model
    // writes little, but the section is honestly listing-grounded.
    listing: () => true,
  },
  "product-area": {
    title: "Product area",
    web: (s) => [
      ...rankByUrl(byKind(s, "site"), ["product", "home", "about"]),
      ...rankByUrl(byKind(s, "blog"), ["changelog"]),
    ],
    listing: (profile) => profile.productArea !== undefined,
  },
  stack: {
    title: "Stack",
    // A homepage or about page rarely states a stack — counting one as 'high'
    // grounding would over-claim. GitHub, engineering blogs, and careers/jobs
    // pages genuinely do.
    web: (s) => [
      ...byKind(s, "github"),
      ...rankByUrl(byKind(s, "blog"), ["changelog"]),
      ...sitePages(s, /careers|jobs/),
    ],
    listing: (profile) => profile.namedTechnologies.length > 0,
  },
  "team-signals": {
    title: "Team signals",
    web: (s) => rankByUrl(sitePages(s, /about|careers|jobs|team/), ["about", "careers"]),
    listing: (profile) => profile.teamSignals !== undefined,
  },
  "seniority-fit": {
    title: "Seniority fit",
    // Inherently listing-grounded: the question is what level the LISTING
    // pitches. Always 'low' — role is a required profile field.
    web: () => [],
    listing: () => true,
  },
  "recent-launches": {
    title: "Recent launches",
    // A listing snapshot cannot evidence recency: without blog/changelog/news
    // coverage this section is honestly 'none', never listing-backed.
    web: (s) => [...rankByUrl(byKind(s, "blog"), ["changelog"]), ...byKind(s, "news")],
    listing: () => false,
  },
};

/** The fixed section plan, in SECTION_PLAN order, with deterministic
 *  confidence and the exact prompt excerpts each sourced section may use. */
export function planSections(
  profile: ListingProfile,
  enrichment: EnrichmentResult,
): PlannedSection[] {
  const classified = classifySources(enrichment);
  const listing = byKind(classified, "listing")[0];
  return SECTION_PLAN.map((id) => {
    const rule = SECTION_RULES[id];
    const web = rule.web(classified).slice(0, MAX_SECTION_WEB_SOURCES);
    const grounding = rule.listing(profile) && listing ? [...web, listing] : web;
    const confidence: Confidence =
      web.length > 0 ? "high" : grounding.length > 0 ? "low" : "none";
    return {
      id,
      title: rule.title,
      confidence,
      sources: grounding.map((source) => source.ref),
      excerpts: grounding.map((source) => ({
        ref: source.ref,
        text: capExcerpt(source.text, SECTION_EXCERPT_CAP),
      })),
    };
  });
}
