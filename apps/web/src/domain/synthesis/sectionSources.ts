import type { EnrichmentResult, SourceRef, TierNumber } from "@/shared/schema";

// Source classification + excerpt selection helpers for Stage 3 — pre-split
// from confidenceRules.ts under the ~200-line ceiling. Everything here is
// pure: it reads the server-side EnrichmentResult (whose `extracted` text
// never rides the wire, decision 19) and hands ranked, capped prompt material
// to the section planner and the hook synthesizer.

export type SourceKind = "listing" | "site" | "github" | "blog" | "news";

export interface ClassifiedSource {
  ref: SourceRef;
  /** Server-side extracted page text (or the listing's rawText for tier 0). */
  text: string;
  tier: TierNumber;
  kind: SourceKind;
}

/** One prompt excerpt: the ref that will be cited + the capped text. */
export interface SectionExcerpt {
  ref: SourceRef;
  text: string;
}

// Prompt-material caps (PLAN.md risk 14): per-source excerpt ceilings and
// per-prompt source counts keep every synthesis prompt inside a small local
// model's context window. Single-sourced here. Lowered after live qwen3:4b
// testing (2026-07-06): the first sizing (4k chars × 3+1 sources) overflowed
// Ollama's context and context-shifted the prompt; the current sizing keeps
// section prompts ≈2k tokens and hook prompts ≈2k tokens — well inside the
// pinned 8k window with room for thinking + output, and CPU prefill stays
// tens of seconds, not minutes.
export const SECTION_EXCERPT_CAP = 2_500;
export const HOOK_EXCERPT_CAP = 1_500;
export const MAX_SECTION_WEB_SOURCES = 2;
export const MAX_HOOK_SOURCES = 5;

/**
 * Flatten coverage into classified sources. A source whose stored text is
 * missing or blank is dropped entirely — a section cannot be grounded (nor a
 * confidence badge earned) by a page we kept no words from.
 */
export function classifySources(enrichment: EnrichmentResult): ClassifiedSource[] {
  const out: ClassifiedSource[] = [];
  for (const tier of enrichment.tiers) {
    for (const ref of tier.sources) {
      const raw = tier.extracted[ref.url];
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) continue;
      out.push({ ref, text, tier: tier.tier, kind: kindOf(tier.tier, ref.url) });
    }
  }
  return out;
}

// Tier numbers carry the meaning (§4 Stage 2): 0 = the listing itself,
// 1 = the company's own site, 2 = engineering-adjacent discoveries (GitHub
// org vs blog/changelog split by host), 3 = news/press.
function kindOf(tier: TierNumber, url: string): SourceKind {
  if (tier === 0) return "listing";
  if (tier === 1) return "site";
  if (tier === 3) return "news";
  return hostOf(url) === "github.com" ? "github" : "blog";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Lowercased pathname without trailing slashes; "" for the site root. */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** Concatenate the given kinds, preserving tier/discovery order within each. */
export const byKind = (
  sources: ClassifiedSource[],
  ...kinds: SourceKind[]
): ClassifiedSource[] => kinds.flatMap((kind) => sources.filter((source) => source.kind === kind));

/**
 * Stable-rank sources by the first preference token their URL contains (the
 * special token "home" matches the site root). Sources matching nothing keep
 * their original order after every match.
 *
 * Tokens are matched against the SUBDOMAIN labels + path, never the
 * registrable domain: productboard.com must not score "product" for every
 * page on the site (increment-7 review finding), while changelog.acme.dev
 * still ranks for "changelog".
 */
export function rankByUrl(
  sources: ClassifiedSource[],
  preference: readonly string[],
): ClassifiedSource[] {
  const score = (source: ClassifiedSource): number => {
    const key = rankKey(source.ref.url);
    const idx = preference.findIndex((token) =>
      token === "home" ? pathOf(source.ref.url) === "" : key.includes(token),
    );
    return idx === -1 ? preference.length : idx;
  };
  return [...sources].sort((a, b) => score(a) - score(b));
}

function rankKey(url: string): string {
  try {
    const parsed = new URL(url);
    // Drop the last two host labels (the registrable domain, approximately —
    // ranking only, so multi-part TLD imprecision is acceptable).
    const subdomains = parsed.hostname.toLowerCase().split(".").slice(0, -2).join(".");
    return `${subdomains}${parsed.pathname.toLowerCase()}${parsed.search.toLowerCase()}`;
  } catch {
    return "";
  }
}

/** Cap excerpt text without leaving a slice-severed surrogate behind (the
 *  Stage-1/coverage rule, applied to prompt material). */
export function capExcerpt(text: string, cap: number): string {
  return text.slice(0, cap).replace(/[\uD800-\uDBFF]$/, "");
}
