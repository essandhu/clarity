import type {
  CleanPage,
  EnrichmentResult,
  ListingProfile,
  SourceRef,
  TierCoverage,
  TierNumber,
} from "@/shared/schema";
import { tier1Candidates, urlKey, type EnrichmentCandidate } from "./candidateUrls";
import { foldTier } from "./coverage";
import { discoverCandidates, slugGuessCandidates } from "./linkDiscovery";
import { dispatchTier, type EnricherDeps, type EnricherOpts } from "./tierDispatch";

// Stage 2 (PLAN.md §4): the tier loop. Tier 0 is the listing itself at zero
// cost; tiers 1–3 are budgeted parallel fetches with per-source step events
// (dispatched by tierDispatch.ts). Structurally incapable of killing a run
// (decision 21): every failure mode is a typed skip folded into coverage.

export type { EnricherDeps, EnricherOpts, EnrichmentEvent } from "./tierDispatch";

/** Below this much remaining wall clock, no tier is worth starting. */
export const MIN_USEFUL_MS = 1_500;

export async function enrichCompany(
  profile: ListingProfile,
  listingSource: SourceRef,
  deps: EnricherDeps,
  opts: EnricherOpts,
): Promise<EnrichmentResult> {
  const { budget, emit } = opts;
  const tiers: TierCoverage[] = [];
  // Every URL a completed tier cited, by urlKey — the cross-tier dedup set
  // (review finding C): a later tier's fetch that redirects onto one of these
  // is not counted as a new source. Read-only during each tier's parallel
  // dispatch (tiers run sequentially), so no race with foldTier.
  const cited = new Set<string>([urlKey(listingSource.url)]);
  if (profile.listingUrl) cited.add(urlKey(profile.listingUrl));

  const complete = (coverage: TierCoverage) => {
    tiers.push(coverage);
    for (const source of coverage.sources) cited.add(urlKey(source.url));
    emit({
      type: "enrichment.tier.completed",
      tier: coverage.tier,
      status: coverage.status,
      sources: coverage.sources,
    });
  };
  const budgetExhausted = (kind: "fetches" | "wall_clock", skippedTiers: TierNumber[]) =>
    emit({
      type: "budget.exhausted",
      kind,
      fetchesUsed: budget.fetchesUsed(),
      elapsedMs: opts.clock.now() - opts.runStartedAt,
      skippedTiers,
    });
  const result = (): EnrichmentResult => ({ tiers, fetchesUsed: budget.fetchesUsed() });

  // Tier 0 — the listing itself, found at zero cost (decision 33 fixed the
  // source: the fetched page's ref for URL input, listing:pasted for text).
  // Its extracted text is profile.rawText — exactly what Stage 1 analyzed.
  complete({
    tier: 0,
    status: "found",
    sources: [listingSource],
    extracted: { [listingSource.url]: profile.rawText },
  });

  // Candidate-URL dedup (distinct from `cited`, which dedups fetched final
  // URLs): a candidate whose URL was already tried is not dispatched again.
  const attempted = new Set<string>(cited);
  const tier1Pages: CleanPage[] = [];
  // budget.exhausted is emitted AT MOST ONCE PER KIND (§3), and a wall-clock
  // stop must never swallow a pending fetches notice (review finding) — so
  // skipped tiers accumulate per kind and both buckets flush at every exit.
  const skippedByKind: Record<"fetches" | "wall_clock", TierNumber[]> = {
    fetches: [],
    wall_clock: [],
  };
  const flushNotices = () => {
    for (const kind of ["fetches", "wall_clock"] as const) {
      if (skippedByKind[kind].length > 0) budgetExhausted(kind, skippedByKind[kind]);
      skippedByKind[kind] = [];
    }
  };

  for (const tier of [1, 2, 3] as const) {
    if (opts.cancel.aborted) return result();
    if (budget.remainingMs() <= MIN_USEFUL_MS) {
      // Wall-clock pre-check: nothing useful fits any more — mark this and
      // every remaining tier skipped, notify once, stop.
      const skipped = ([1, 2, 3] as const).filter((t) => t >= tier);
      for (const t of skipped) {
        complete({ tier: t, status: "skipped_budget", sources: [], extracted: {} });
      }
      skippedByKind.wall_clock.push(...skipped);
      flushNotices();
      return result();
    }

    const candidates = candidatesFor(tier, profile, tier1Pages, attempted);
    for (const candidate of candidates) attempted.add(urlKey(candidate.url));
    const outcomes = await dispatchTier(tier, candidates, profile.company, cited, deps, opts);
    if (opts.cancel.aborted) return result(); // dead sink — no more frames
    if (tier === 1) {
      tier1Pages.push(...outcomes.flatMap((o) => (o.page ? [o.page] : [])));
    }
    const coverage = foldTier(tier, outcomes);
    complete(coverage);
    if (coverage.status === "skipped_budget") {
      // Almost always the fetch counter — but tryAcquire also refuses once
      // the deadline signal has fired OR the remaining window has hit zero,
      // and the cache peeks (real disk I/O since increment 9) yield between
      // the wall-clock pre-check and acquisition, so the window can expire
      // before the route's deadline timer fires (review finding). When the
      // wall clock is spent it refused every token regardless of the
      // counter — record that, not 'fetches'.
      const wallClockStopped = budget.deadlineSignal.aborted || budget.remainingMs() <= 0;
      skippedByKind[wallClockStopped ? "wall_clock" : "fetches"].push(tier);
    }
  }

  flushNotices();
  return result();
}

function candidatesFor(
  tier: 1 | 2 | 3,
  profile: ListingProfile,
  tier1Pages: CleanPage[],
  attempted: ReadonlySet<string>,
): EnrichmentCandidate[] {
  if (tier === 1) {
    return tier1Candidates(profile.domain).filter((c) => !attempted.has(urlKey(c.url)));
  }
  const discovered = discoverCandidates(tier1Pages, { exclude: attempted });
  if (tier === 3) return discovered.tier3;
  if (discovered.tier2.length > 0) return discovered.tier2;
  // Discovery found nothing — fall back to slug guesses (decision 20), which
  // carry the loose-name-match requirement.
  return slugGuessCandidates(profile.domain).filter((c) => !attempted.has(urlKey(c.url)));
}
