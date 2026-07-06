import type { Clock } from "@/domain/pipeline/clock";
import type { RunBudget } from "@/domain/pipeline/RunBudget";
import { stepOk, stepSkipped, stepStarted, type StepEvent } from "@/domain/pipeline/steps";
import type { PageFetcher } from "@/providers/fetch/PageFetcher";
import type {
  CleanPage,
  EnrichmentResult,
  FetchSkip,
  ListingProfile,
  PipelineEvent,
  SourceRef,
  TierCoverage,
  TierNumber,
} from "@/shared/schema";
import { tier1Candidates, urlKey, type EnrichmentCandidate } from "./candidateUrls";
import { foldTier, type CandidateOutcome } from "./coverage";
import { discoverCandidates, looseNameMatch, slugGuessCandidates } from "./linkDiscovery";

// Stage 2 (PLAN.md §4): the tier loop. Tier 0 is the listing itself at zero
// cost; tiers 1–3 are budgeted parallel fetches with per-source step events.
// Structurally incapable of killing a run (decision 21): every failure mode
// here is a typed skip folded into coverage, never a throw.

/** Below this much remaining wall clock, no tier is worth starting. */
export const MIN_USEFUL_MS = 1_500;

const MAX_LABEL_CHARS = 200;

export type EnrichmentEvent =
  | StepEvent
  | Extract<PipelineEvent, { type: "enrichment.tier.completed" | "budget.exhausted" }>;

export interface EnricherDeps {
  fetcher: PageFetcher;
}

export interface EnricherOpts {
  budget: RunBudget;
  clock: Clock;
  /** clock.now() at run start — budget.exhausted reports elapsedMs from it. */
  runStartedAt: number;
  /** User cancel. Checked at tier boundaries; in-flight fetches abort through
   *  the BudgetToken signal (cancel + deadline composed in RunBudget). */
  cancel: AbortSignal;
  emit: (event: EnrichmentEvent) => void;
}

export async function enrichCompany(
  profile: ListingProfile,
  listingSource: SourceRef,
  deps: EnricherDeps,
  opts: EnricherOpts,
): Promise<EnrichmentResult> {
  const { budget, emit } = opts;
  const tiers: TierCoverage[] = [];
  const complete = (coverage: TierCoverage) => {
    tiers.push(coverage);
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

  const attempted = new Set<string>([urlKey(listingSource.url)]);
  if (profile.listingUrl) attempted.add(urlKey(profile.listingUrl));
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
    const outcomes = await dispatchTier(tier, candidates, profile.company, deps, opts);
    if (opts.cancel.aborted) return result(); // dead sink — no more frames
    if (tier === 1) {
      tier1Pages.push(...outcomes.flatMap((o) => (o.page ? [o.page] : [])));
    }
    const coverage = foldTier(tier, outcomes);
    complete(coverage);
    if (coverage.status === "skipped_budget") {
      // Almost always the fetch counter — but tryAcquire also refuses once
      // the deadline SIGNAL has fired, which can beat the wall-clock
      // pre-check while the remaining window is still above MIN_USEFUL_MS.
      // Record what actually stopped this tier.
      skippedByKind[budget.deadlineSignal.aborted ? "wall_clock" : "fetches"].push(tier);
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

type EnricherOutcome = CandidateOutcome & { page?: CleanPage };

async function dispatchTier(
  tier: 1 | 2 | 3,
  candidates: EnrichmentCandidate[],
  company: string,
  deps: EnricherDeps,
  opts: EnricherOpts,
): Promise<EnricherOutcome[]> {
  // Acquire synchronously BEFORE any dispatch: a parallel burst can never
  // overshoot maxFetches, and — because the wall-clock pre-check just passed
  // and nothing yields to the deadline timer between here and dispatch — a
  // null token inside a tier can only mean the fetch counter is spent, which
  // is what lets the post-loop notice say kind: 'fetches' truthfully.
  const slots = candidates.map((candidate, i) => ({
    candidate,
    stepId: `enrich-${tier}-${i}`,
    token: opts.budget.tryAcquire(candidate.label),
  }));
  const settled = await Promise.allSettled(
    slots.map((slot) => attemptCandidate(slot, company, deps, opts)),
  );
  return settled.map(
    (entry): EnricherOutcome =>
      // attemptCandidate never throws; this arm is pure belt-and-braces.
      entry.status === "fulfilled" ? entry.value : { kind: "skip", reason: "network" },
  );
}

async function attemptCandidate(
  slot: {
    candidate: EnrichmentCandidate;
    stepId: string;
    token: ReturnType<RunBudget["tryAcquire"]>;
  },
  company: string,
  deps: EnricherDeps,
  opts: EnricherOpts,
): Promise<EnricherOutcome> {
  const { candidate, stepId, token } = slot;
  const finish = (skip: FetchSkip): EnricherOutcome => {
    opts.emit(stepSkipped(stepId, skip));
    return { kind: "skip", reason: skip.reason };
  };
  opts.emit(
    stepStarted(stepId, "enrichment", candidate.label, { url: candidate.url, tier: candidate.tier }),
  );
  if (token === null) {
    return finish({ kind: "skip", url: candidate.url, reason: "budget_exhausted" });
  }
  let outcome: CleanPage | FetchSkip;
  try {
    outcome = await deps.fetcher.fetchClean(candidate.url, token);
  } catch (err) {
    // fetchClean's contract is "never throws" (decision 21), but Stage 2 must
    // be structurally incapable of killing a run — even a broken fetcher
    // becomes a typed skip.
    const detail = err instanceof Error ? err.message : String(err);
    outcome = { kind: "skip", url: candidate.url, reason: "network", detail: `fetcher threw: ${detail}` };
  }
  if (outcome.kind === "skip") return finish(outcome);
  if (candidate.requiresNameMatch && !looseNameMatch(company, outcome)) {
    return finish({
      kind: "skip",
      url: candidate.url,
      reason: "empty_content",
      detail: `guessed URL — the page never mentions "${company}", so it is not counted as found`,
    });
  }
  const source: SourceRef = {
    url: outcome.finalUrl,
    label: sourceLabel(outcome),
    fetchedAt: outcome.fetchedAt,
  };
  opts.emit(stepOk(stepId, { source }));
  return { kind: "page", source, text: outcome.text, page: outcome };
}

/** Page <title> is attacker-controlled and unbounded — clip at ref
 *  construction (the Stage-1 rule); fall back to host+path when empty. */
function sourceLabel(page: CleanPage): string {
  const title = page.title.trim();
  if (title) return title.slice(0, MAX_LABEL_CHARS);
  try {
    const url = new URL(page.finalUrl);
    return `${url.host}${url.pathname.replace(/\/$/, "")}`.slice(0, MAX_LABEL_CHARS);
  } catch {
    return page.finalUrl.slice(0, MAX_LABEL_CHARS);
  }
}
