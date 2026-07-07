import type { BudgetToken } from "@/domain/pipeline/RunBudget";

// The future-search seam (PLAN.md decision 32; the spec §3 free-search note):
// v1 derives candidate URLs from the company domain instead of calling a paid
// search API, so this interface is REFERENCED BY NOTHING — it exists so a
// search backend can be plugged in later without touching the pipeline. It is
// types-only and, like the other provider interfaces, importable from
// src/domain/** under the eslint layering rule.

export interface SearchResult {
  url: string;
  title: string;
  snippet?: string;
}

export interface SearchProvider {
  id: string;
  search(query: string, token: BudgetToken): Promise<SearchResult[]>;
}
