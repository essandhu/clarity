import type { Clock } from "@/domain/pipeline/clock";
import type { RunBudget } from "@/domain/pipeline/RunBudget";
import { stepOk, stepSkipped, stepStarted, type StepEvent } from "@/domain/pipeline/steps";
import type { PageFetcher } from "@/providers/fetch/PageFetcher";
import { pageSourceRef, type CleanPage, type FetchSkip, type PipelineEvent } from "@/shared/schema";
import { urlKey, type EnrichmentCandidate } from "./candidateUrls";
import type { CandidateOutcome } from "./coverage";
import { looseNameMatch } from "./linkDiscovery";

// The parallel per-tier fetch half of Stage 2 — split from CompanyEnricher.ts
// under the ~200-line ceiling (PLAN.md §2). CompanyEnricher owns the tier loop
// and coverage; this owns dispatch, the per-source step pair, and the
// candidate-level guards (budget, name match, cross-tier dedup).

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

export type EnricherOutcome = CandidateOutcome & { page?: CleanPage };

export async function dispatchTier(
  tier: 1 | 2 | 3,
  candidates: EnrichmentCandidate[],
  company: string,
  cited: ReadonlySet<string>,
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
    slots.map((slot) => attemptCandidate(slot, company, cited, deps, opts)),
  );
  return settled.map((entry, i): EnricherOutcome => {
    if (entry.status === "fulfilled") return entry.value;
    // attemptCandidate never throws — but if a future fetcher impl makes it,
    // Stage 2 must not kill the run AND must not orphan the started step
    // (§3 guarantee 3): pair it here before folding a network skip.
    opts.emit(stepSkipped(slots[i].stepId, { kind: "skip", reason: "network" }));
    return { kind: "skip", reason: "network" };
  });
}

async function attemptCandidate(
  slot: {
    candidate: EnrichmentCandidate;
    stepId: string;
    token: ReturnType<RunBudget["tryAcquire"]>;
  },
  company: string,
  cited: ReadonlySet<string>,
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
  // Cross-tier dedup (review finding C): a discovered/guessed URL that
  // redirects onto a page an EARLIER tier already cited must not flip this
  // tier to a false `found` (risk 4: honest not_found beats cleverness), nor
  // re-store its text for increment-7 prompts. `cited` holds only completed
  // tiers, so within-tier convergence is left to foldTier's urlKey dedup.
  if (cited.has(urlKey(outcome.finalUrl))) {
    return finish({
      kind: "skip",
      url: candidate.url,
      reason: "empty_content",
      detail: `resolved to ${outcome.finalUrl}, already cited by an earlier tier`,
    });
  }
  if (candidate.requiresNameMatch && !looseNameMatch(company, outcome)) {
    return finish({
      kind: "skip",
      url: candidate.url,
      reason: "empty_content",
      detail: `guessed URL — the page never mentions "${company}", so it is not counted as found`,
    });
  }
  const source = pageSourceRef(outcome);
  opts.emit(stepOk(stepId, { source }));
  return { kind: "page", source, text: outcome.text, page: outcome };
}
