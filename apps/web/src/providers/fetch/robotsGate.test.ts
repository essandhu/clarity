import { describe, expect, it, vi } from "vitest";
import { ATTEMPTS_PER_FETCH } from "./resilience";
import { MAX_CRAWL_DELAY_MS, robotsGate } from "./robotsGate";

// Each test uses a unique origin: the robots cache is deliberately
// process-global (globalThis), so shared hosts would couple tests.

const live = () => new AbortController().signal;

const robotsFetch = (respond: () => Response | Promise<Response>) =>
  vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toMatch(/\/robots\.txt$/);
    return respond();
  });

describe("robotsGate", () => {
  it("allows a permitted path and blocks a disallowed one from the same rules", async () => {
    const fetchImpl = robotsFetch(
      () => new Response("User-agent: *\nDisallow: /private/", { status: 200 }),
    );
    const allowed = await robotsGate("https://r-rules.test/careers", live(), fetchImpl);
    expect(allowed.skip).toBeUndefined();
    const blocked = await robotsGate("https://r-rules.test/private/x", live(), fetchImpl);
    expect(blocked.skip).toMatchObject({ kind: "skip", reason: "robots_disallowed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // per-origin cache: one lookup
  });

  it("matches rules addressed to the ClarityBot product token", async () => {
    const fetchImpl = robotsFetch(
      () => new Response("User-agent: ClarityBot\nDisallow: /\n\nUser-agent: *\nAllow: /", { status: 200 }),
    );
    const verdict = await robotsGate("https://r-token.test/", live(), fetchImpl);
    expect(verdict.skip?.reason).toBe("robots_disallowed");
  });

  it("parallel same-origin gates share one in-flight robots lookup", async () => {
    const fetchImpl = robotsFetch(() => new Response("User-agent: *\nDisallow:", { status: 200 }));
    const verdicts = await Promise.all([
      robotsGate("https://r-parallel.test/a", live(), fetchImpl),
      robotsGate("https://r-parallel.test/b", live(), fetchImpl),
      robotsGate("https://r-parallel.test/c", live(), fetchImpl),
    ]);
    expect(verdicts.every((v) => v.skip === undefined)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a 404 (and the 4xx class) as allow-all, cached per origin", async () => {
    const fetchImpl = robotsFetch(() => new Response("nope", { status: 404 }));
    expect((await robotsGate("https://r-404.test/a", live(), fetchImpl)).skip).toBeUndefined();
    expect((await robotsGate("https://r-404.test/b", live(), fetchImpl)).skip).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips conservatively on a 5xx robots.txt and retries on the next call", async () => {
    const fetchImpl = robotsFetch(() => new Response("boom", { status: 503 }));
    const verdict = await robotsGate("https://r-5xx.test/page", live(), fetchImpl);
    expect(verdict.skip).toMatchObject({ reason: "robots_disallowed" });
    expect(verdict.skip?.detail).toMatch(/couldn't verify/i);
    // The unreachable record is evicted — a later call re-fetches.
    await robotsGate("https://r-5xx.test/page", live(), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports a network-dead host as `network` (not a robots verdict), after retry backoff", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND r-dead.test") });
    });
    const verdict = await robotsGate("https://r-dead.test/page", live(), fetchImpl);
    expect(verdict.skip).toMatchObject({ reason: "network" });
    expect(verdict.skip?.detail).toContain("ENOTFOUND");
    // The robots lookup itself runs through the resilience policy.
    expect(fetchImpl).toHaveBeenCalledTimes(ATTEMPTS_PER_FETCH);
  });

  it("reports Crawl-delay converted from seconds to ms", async () => {
    const fetchImpl = robotsFetch(
      () => new Response("User-agent: *\nCrawl-delay: 2\nDisallow:", { status: 200 }),
    );
    const verdict = await robotsGate("https://r-delay.test/", live(), fetchImpl);
    expect(verdict.skip).toBeUndefined();
    expect(verdict.crawlDelayMs).toBe(2_000);
  });

  it("caps a hostile Crawl-delay", async () => {
    const fetchImpl = robotsFetch(
      () => new Response("User-agent: *\nCrawl-delay: 9999", { status: 200 }),
    );
    const verdict = await robotsGate("https://r-hostile.test/", live(), fetchImpl);
    expect(verdict.crawlDelayMs).toBe(MAX_CRAWL_DELAY_MS);
  });

  it("reclassifies an abort during the lookup as cancelled, not a robots verdict", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })),
            { once: true },
          );
        }),
    );
    const pending = robotsGate("https://r-cancel.test/page", controller.signal, fetchImpl);
    setTimeout(() => controller.abort(new Error("user cancelled the run")), 30);
    const verdict = await pending;
    expect(verdict.skip).toMatchObject({ reason: "cancelled" });
  });

  it("parses only the first 512 KiB of an oversized robots.txt (RFC 9309 truncation)", async () => {
    // A Disallow rule inside the cap applies; one past the cap is ignored.
    const padding = "# padding\n".repeat(60_000); // ~600 KB of comments
    const fetchImpl = robotsFetch(
      () =>
        new Response(`User-agent: *\nDisallow: /private/\n${padding}\nDisallow: /late/`, {
          status: 200,
        }),
    );
    const blocked = await robotsGate("https://r-huge.test/private/x", live(), fetchImpl);
    expect(blocked.skip?.reason).toBe("robots_disallowed");
    const lateRule = await robotsGate("https://r-huge.test/late/x", live(), fetchImpl);
    expect(lateRule.skip).toBeUndefined();
  });
});
