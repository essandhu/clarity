import type { PageFetcher } from "@/providers/fetch/PageFetcher";
import type { CleanPage } from "@/shared/schema";

// The one pre-acquisition cache peek (increment 9), shared by every
// fetchClean call site: Stage 1's listing fetch, Stage 2's tier dispatch,
// and Stage 4's contact re-reads. A hit is served WITHOUT budget.tryAcquire
// — cache hits bypass budget and limiter entirely (PLAN.md §4 run-budget
// rules) — so the peek must come first, and it must never throw: a broken
// or absent cache is a miss, and the caller fetches as if increment 9 never
// happened.
//
// Peeks happen BEFORE a token exists, so no BudgetToken signal bounds them —
// callers pass the run's deadline signal instead (review finding: fs reads
// are not cancellable, and a pathologically stalled disk must not hold a run
// open past the wall clock the plan promises is a ceiling, decision 15).

export async function peekCached(
  fetcher: PageFetcher,
  url: string,
  signal?: AbortSignal,
): Promise<CleanPage | null> {
  try {
    return await settleByAbort(Promise.resolve(fetcher.cached?.(url) ?? null), null, signal);
  } catch {
    return null;
  }
}

/**
 * Resolve with `work`'s value, or with `fallback` the moment `signal` aborts
 * (or if `work` rejects) — never rejects, never waits past the signal. The
 * abandoned promise keeps running (fs I/O cannot be cancelled) but both of
 * its arms are handled, so a late failure can never surface as an unhandled
 * rejection. Also used by the fetcher's gate-0 read and write-through.
 */
export function settleByAbort<T>(
  work: Promise<T>,
  fallback: T,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work.catch(() => fallback);
  return new Promise<T>((resolve) => {
    const onAbort = () => resolve(fallback);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(fallback);
      },
    );
  });
}
