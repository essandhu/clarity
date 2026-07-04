import Bottleneck from "bottleneck";

// Gate 2 (PLAN.md decision 11): per-host politeness via a Bottleneck Group —
// library-first, no hand-rolled limiter. The Group lives on globalThis so
// Next dev-mode HMR cannot reset queue state (risk 11). The limiter is used
// INSIDE the cockatiel policy execute, so retry attempts also queue behind
// the politeness delay.

export const HOST_MIN_TIME_MS = 1_000;
export const HOST_MAX_CONCURRENT = 2;

const GROUP_KEY = Symbol.for("clarity.fetch.hostLimiters");
const store = globalThis as { [GROUP_KEY]?: Bottleneck.Group };

function group(): Bottleneck.Group {
  // Fresh options literal on construction — Group.key() mutates the options
  // object it was constructed with (writes id/timeout into it per key).
  return (store[GROUP_KEY] ??= new Bottleneck.Group({
    minTime: HOST_MIN_TIME_MS,
    maxConcurrent: HOST_MAX_CONCURRENT,
  }));
}

/**
 * The limiter for one host. Re-fetched on every use — the Group garbage-
 * collects idle limiters after ~5 minutes, so held references go stale.
 */
export function hostLimiter(host: string): Bottleneck {
  return group().key(host);
}

/**
 * robots.txt Crawl-delay raises this host's politeness spacing above the
 * 1s default. updateSettings is declared sync in the .d.ts but is async at
 * runtime — awaiting covers both. New spacing applies to jobs queued after
 * this call, which is exactly when the caller dispatches its fetch.
 */
export async function applyCrawlDelay(host: string, crawlDelayMs: number): Promise<void> {
  if (crawlDelayMs > HOST_MIN_TIME_MS) {
    await group().key(host).updateSettings({ minTime: crawlDelayMs });
  }
}
