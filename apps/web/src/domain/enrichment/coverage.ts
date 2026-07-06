import type {
  EnrichmentResult,
  EnrichmentWireSummary,
  FetchSkipReason,
  SourceRef,
  TierCoverage,
  TierNumber,
} from "@/shared/schema";

// Coverage folds (PLAN.md §4): candidate fetch outcomes -> tier status ->
// TierCoverage -> the counts-only wire summary. Pure rules; the enricher owns
// the loop and the events.

/** Per-source cleaned text cap (risk 14): ~6k chars per source keeps the
 *  increment-7 per-section prompts inside an 8k-token local-model window. */
export const SOURCE_TEXT_CAP = 6_000;

/** One candidate's outcome, as coverage sees it. */
export type CandidateOutcome =
  | { kind: "page"; source: SourceRef; text: string }
  | { kind: "skip"; reason: FetchSkipReason };

/**
 * The §4 tier-status rule: `found` if ≥ 1 page, `skipped_budget` only when
 * there were candidates and EVERY one was budget-skipped, else `not_found`.
 * Zero candidates is `not_found` — "skipped" would claim the budget stopped
 * us when there was simply nothing to try.
 */
export function tierStatus(outcomes: CandidateOutcome[]): TierCoverage["status"] {
  if (outcomes.some((outcome) => outcome.kind === "page")) return "found";
  if (
    outcomes.length > 0 &&
    outcomes.every((outcome) => outcome.kind === "skip" && outcome.reason === "budget_exhausted")
  ) {
    return "skipped_budget";
  }
  return "not_found";
}

/** Fold one dispatched tier. Sources are deduped by URL (two candidates can
 *  redirect to the same final page); extracted text is capped per source. */
export function foldTier(tier: TierNumber, outcomes: CandidateOutcome[]): TierCoverage {
  const sources: SourceRef[] = [];
  const extracted: Record<string, string> = {};
  for (const outcome of outcomes) {
    if (outcome.kind !== "page") continue;
    if (outcome.source.url in extracted) continue;
    sources.push(outcome.source);
    extracted[outcome.source.url] = capSourceText(outcome.text);
  }
  return { tier, status: tierStatus(outcomes), sources, extracted };
}

/** Cap a source's text without leaving a slice-severed surrogate behind. */
export function capSourceText(text: string): string {
  return text.slice(0, SOURCE_TEXT_CAP).replace(/[\uD800-\uDBFF]$/, "");
}

/** What enrichment.completed carries: counts ONLY — per-tier SourceRef[]
 *  already arrived via enrichment.tier.completed, and extracted page text
 *  never rides the wire (decision 19). */
export function toWireSummary(result: EnrichmentResult): EnrichmentWireSummary {
  return {
    tiers: result.tiers.map((tier) => ({
      tier: tier.tier,
      status: tier.status,
      sourceCount: tier.sources.length,
    })),
    fetchesUsed: result.fetchesUsed,
  };
}
