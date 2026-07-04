import { describe, expect, it } from "vitest";
import { applyCrawlDelay, HOST_MIN_TIME_MS, hostLimiter } from "./hostRateLimiter";

// Unique hosts per test: the Bottleneck Group is deliberately process-global.

async function measureSpacing(host: string): Promise<number> {
  const starts: number[] = [];
  const job = () => {
    starts.push(Date.now());
    return Promise.resolve();
  };
  await Promise.all([hostLimiter(host).schedule(job), hostLimiter(host).schedule(job)]);
  return Math.abs(starts[1] - starts[0]);
}

describe("hostRateLimiter", () => {
  it("returns the same limiter instance for the same host", () => {
    expect(hostLimiter("hl-same.test")).toBe(hostLimiter("hl-same.test"));
  });

  it("spaces same-host job starts by the politeness minimum", async () => {
    const spacing = await measureSpacing("hl-default.test");
    expect(spacing).toBeGreaterThanOrEqual(HOST_MIN_TIME_MS - 50);
  });

  it("applyCrawlDelay raises a host's spacing above the default", async () => {
    await applyCrawlDelay("hl-raised.test", 1_500);
    const spacing = await measureSpacing("hl-raised.test");
    expect(spacing).toBeGreaterThanOrEqual(1_450);
  });

  it("ignores crawl delays at or below the default (never lowers politeness)", async () => {
    await applyCrawlDelay("hl-low.test", 10);
    const spacing = await measureSpacing("hl-low.test");
    expect(spacing).toBeGreaterThanOrEqual(HOST_MIN_TIME_MS - 50);
  });
});
