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
}
