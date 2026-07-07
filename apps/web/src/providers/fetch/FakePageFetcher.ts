import type { BudgetToken } from "@/domain/pipeline/RunBudget";
import type { CleanPage, FetchSkip } from "@/shared/schema";
import type { PageFetcher } from "./PageFetcher";

// Map<url, CleanPage | FetchSkip> + a call log (PLAN.md §2): budget tests
// assert EXACTLY which URLs were dispatched — and that budget-skipped
// candidates produced zero calls. Deliberately vendor-free: the domain-test
// eslint carve-out admits this fake only because it imports nothing but the
// interface seams and schema.

export class FakePageFetcher implements PageFetcher {
  readonly calls: { url: string; token: BudgetToken }[] = [];
  /** Every cached() peek, hit or miss — bypass tests assert peeks happened
   *  INSTEAD of fetches, not merely that fetches are absent. */
  readonly peeks: string[] = [];
  private readonly results = new Map<string, CleanPage | FetchSkip>();
  private readonly cachedPages = new Map<string, CleanPage>();

  constructor(fixtures: Record<string, CleanPage | FetchSkip> = {}) {
    for (const [url, result] of Object.entries(fixtures)) this.results.set(url, result);
  }

  set(url: string, result: CleanPage | FetchSkip): this {
    this.results.set(url, result);
    return this;
  }

  /** Script a warm cache entry: cached(url) will hit without a fetch. */
  setCached(url: string, page: CleanPage): this {
    this.cachedPages.set(url, page);
    return this;
  }

  async cached(url: string): Promise<CleanPage | null> {
    this.peeks.push(url);
    return this.cachedPages.get(url) ?? null;
  }

  async fetchClean(url: string, token: BudgetToken): Promise<CleanPage | FetchSkip> {
    this.calls.push({ url, token });
    if (token.signal.aborted) {
      return {
        kind: "skip",
        url,
        reason: "cancelled",
        detail:
          token.signal.reason instanceof Error ? token.signal.reason.message : "aborted",
      };
    }
    return (
      this.results.get(url) ?? {
        kind: "skip",
        url,
        reason: "network",
        detail: `FakePageFetcher: no fixture for ${url}`,
      }
    );
  }
}
