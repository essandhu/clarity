import type { CleanPage, FetchSkip } from "@/shared/schema";
import type { BudgetToken } from "@/domain/pipeline/RunBudget";

// The §4.2 PageFetcher seam. This file is types-only: it is one of the five
// provider interface files src/domain/** is allowed to import (eslint layering
// rule) — implementations are wired in by src/server/deps.
//
// fetchClean NEVER throws into the pipeline: every failure mode comes back as
// a typed FetchSkip (returned, not thrown — PLAN.md decision 21). Skips flow
// into coverage; only PipelineError terminates a run.

export interface PageFetcher {
  fetchClean(url: string, token: BudgetToken): Promise<CleanPage | FetchSkip>;
  /**
   * Increment 9: a FRESH page-cache hit for this url, or null. Callers peek
   * BEFORE budget.tryAcquire and serve a hit without a token — cache hits
   * bypass budget and limiter entirely (PLAN.md §4 run-budget rules), which
   * is what makes re-runs near-free. Optional so cacheless implementations
   * (and existing test fakes) need no stub; absent ⇒ always a miss. Must not
   * throw — but call sites go through peekCached(), which guards anyway.
   */
  cached?(url: string): Promise<CleanPage | null>;
}
