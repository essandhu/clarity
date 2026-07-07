import type { CleanPage } from "@/shared/schema";

// The §4 PageCache seam (PLAN.md decision 14). Types-only: it is one of the
// provider interface files src/domain/** is allowed to import (eslint layering
// rule) — the flat-JSON implementation is wired in by src/server/deps.
//
// Contract: 24h TTL keyed off CleanPage.fetchedAt — get() returns only FRESH
// pages and treats a corrupt, stale, or missing entry as a miss. Neither
// method ever throws: a broken cache degrades to a plain refetch, never a
// failed one.

export interface PageCache {
  /** A fresh, schema-valid CleanPage for this url, or null (= miss). */
  get(url: string): Promise<CleanPage | null>;
  /** Best-effort write; a failed cache write never fails the fetch. */
  set(page: CleanPage): Promise<void>;
}
