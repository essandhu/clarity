import { describe, expect, it } from "vitest";
import { createRunBudget, type CreatedRunBudget } from "@/domain/pipeline/RunBudget";
import type { PageFetcher } from "@/providers/fetch/PageFetcher";
import { FakePageFetcher } from "@/providers/fetch/FakePageFetcher";
import { makePage, ofType, runEnricher } from "./enricherTestKit";

// Increment 9's §7 proof: cache hits bypass tryAcquire entirely — served
// without a token, without the limiter, without network — while every
// candidate-level guard (cross-tier dedup, loose name match) still applies
// to a cached page exactly as it would to a fresh one.

const TIER1 = [
  "https://acme.dev/",
  "https://acme.dev/about",
  "https://acme.dev/careers",
  "https://acme.dev/jobs",
  "https://acme.dev/product",
];

function spiedBudget(maxFetches = 12): { budget: CreatedRunBudget; acquired: string[] } {
  const real = createRunBudget({ maxFetches, deadlineMs: 60_000 }, { now: () => 1_000 });
  const acquired: string[] = [];
  return {
    acquired,
    budget: {
      ...real,
      tryAcquire: (label) => {
        acquired.push(label);
        return real.tryAcquire(label);
      },
    },
  };
}

describe("enrichCompany — cache hits bypass the budget", () => {
  it("a fully warm cache enriches with ZERO tryAcquire calls and zero network", async () => {
    const fetcher = new FakePageFetcher();
    const homepage = makePage("https://acme.dev/", {
      links: [
        { url: "https://github.com/acme", text: "GitHub" },
        { url: "https://acme.dev/news", text: "News" },
      ],
    });
    fetcher.setCached("https://acme.dev/", homepage);
    for (const url of TIER1.slice(1)) fetcher.setCached(url, makePage(url));
    fetcher.setCached("https://github.com/acme", makePage("https://github.com/acme"));
    fetcher.setCached("https://acme.dev/news", makePage("https://acme.dev/news"));

    const { budget, acquired } = spiedBudget();
    const { events, result } = await runEnricher({ fetcher, budget });

    expect(acquired).toEqual([]); // the §7 bypass proof
    expect(fetcher.calls).toHaveLength(0);
    expect(result.fetchesUsed).toBe(0);
    // Tier-2/3 discovery mined the CACHED homepage's links — a cache that
    // dropped links would have made these tiers silently not_found.
    expect(ofType(events, "enrichment.tier.completed").map((t) => [t.tier, t.status])).toEqual([
      [0, "found"],
      [1, "found"],
      [2, "found"],
      [3, "found"],
    ]);
    const finished = ofType(events, "step.finished");
    expect(finished).toHaveLength(7); // 5 tier-1 + github + news
    for (const step of finished) {
      expect(step.status).toBe("ok");
      expect(step.cached).toBe(true);
    }
    expect(ofType(events, "budget.exhausted")).toHaveLength(0);
  });

  it("mixed tier: cached candidates are free, only misses consume the counter", async () => {
    const fetcher = new FakePageFetcher({
      "https://acme.dev/careers": makePage("https://acme.dev/careers"),
    });
    fetcher.setCached("https://acme.dev/", makePage("https://acme.dev/"));
    fetcher.setCached("https://acme.dev/about", makePage("https://acme.dev/about"));

    const { budget, acquired } = spiedBudget(1);
    const { events, result } = await runEnricher({ fetcher, budget });

    // Only the three uncached tier-1 candidates plus the two slug guesses
    // ever reached the budget; both cached candidates are absent.
    expect(acquired).toHaveLength(5);
    expect(result.fetchesUsed).toBe(1);
    expect(fetcher.calls.map((c) => c.url)).toEqual(["https://acme.dev/careers"]);

    const finished = ofType(events, "step.finished");
    expect(finished.filter((e) => e.status === "ok" && e.cached === true)).toHaveLength(2);
    expect(finished.filter((e) => e.status === "ok" && e.cached !== true)).toHaveLength(1);
    expect(finished.filter((e) => e.skip?.reason === "budget_exhausted")).toHaveLength(4);

    const tiers = ofType(events, "enrichment.tier.completed");
    expect(tiers.map((t) => [t.tier, t.status])).toEqual([
      [0, "found"],
      [1, "found"], // 2 cached + 1 fetched beat the 2 budget-skipped
      [2, "skipped_budget"],
      [3, "not_found"],
    ]);
    expect(ofType(events, "budget.exhausted")).toMatchObject([
      { kind: "fetches", fetchesUsed: 1, skippedTiers: [2] },
    ]);
  });
});

describe("enrichCompany — cached pages face the same guards as fresh ones", () => {
  it("a cached page resolving to an already-cited URL is an honest dedup skip, not a found", async () => {
    const fetcher = new FakePageFetcher();
    fetcher.setCached(
      "https://acme.dev/",
      makePage("https://acme.dev/", {
        links: [{ url: "https://blog.acme.dev/", text: "Blog" }],
      }),
    );
    for (const url of TIER1.slice(1)) fetcher.setCached(url, makePage(url));
    // The cached blog entry redirects onto the homepage tier 1 already cited.
    fetcher.setCached(
      "https://blog.acme.dev/",
      makePage("https://blog.acme.dev/", { finalUrl: "https://acme.dev/" }),
    );

    const { budget, acquired } = spiedBudget();
    const { events } = await runEnricher({ fetcher, budget });

    expect(acquired).toEqual([]);
    const dedupSkip = ofType(events, "step.finished").find(
      (e) => e.skip?.detail?.includes("already cited"),
    );
    expect(dedupSkip).toMatchObject({ status: "skipped", skip: { reason: "empty_content" } });
    expect(
      ofType(events, "enrichment.tier.completed").find((t) => t.tier === 2)?.status,
    ).toBe("not_found");
  });

  it("a cached slug-guess page that never mentions the company still fails the name match", async () => {
    // Tier 1 is a dead domain (default network skips) so tier 2 falls back to
    // slug guesses; the guessed GitHub org is WARM but belongs to a stranger.
    const fetcher = new FakePageFetcher();
    fetcher.setCached(
      "https://github.com/acme",
      makePage("https://github.com/acme", {
        title: "someone-else · GitHub",
        text: "Unrelated project pages with no company mention at all.",
      }),
    );

    const { budget, acquired } = spiedBudget();
    const { events } = await runEnricher({ fetcher, budget });

    // The warm guess never touched the budget…
    expect(acquired).not.toContain("Checking guessed GitHub org…");
    // …but it also never counted as found: same guard, same honest skip.
    const nameSkip = ofType(events, "step.finished").find(
      (e) => e.skip?.detail?.includes("never mentions"),
    );
    expect(nameSkip).toMatchObject({ status: "skipped", skip: { reason: "empty_content" } });
  });

  it("a HUNG cache peek is bounded by the deadline signal — the run ends, wall_clock reported", async () => {
    const fetcher: PageFetcher = {
      cached: () => new Promise(() => {}), // never settles — stalled disk
      fetchClean: async () => {
        throw new Error("unreachable: no token should ever be issued");
      },
    };
    const budget = createRunBudget({ maxFetches: 12, deadlineMs: 60_000 }, { now: () => 1_000 });
    // enrichCompany is already suspended on the peek Promise.all when this
    // fires — exactly the review's stalled-fs scenario.
    const pending = runEnricher({ fetcher, budget });
    budget.fireDeadline();
    const { events, result } = await pending;
    expect(result.fetchesUsed).toBe(0);
    // The clock is frozen, so tiers 2–3 pass the pre-check and take the
    // dispatch path: tier 2's slug guesses are refused by the aborted
    // signal; tier 3 has zero candidates, and the zero-candidate rule says
    // not_found — a skip chip must not claim the budget stopped work that
    // never existed.
    expect(
      ofType(events, "enrichment.tier.completed").map((t) => [t.tier, t.status]),
    ).toEqual([
      [0, "found"],
      [1, "skipped_budget"],
      [2, "skipped_budget"],
      [3, "not_found"],
    ]);
    expect(ofType(events, "budget.exhausted")).toMatchObject([
      { kind: "wall_clock", skippedTiers: [1, 2] },
    ]);
  });

  it("the wall clock expiring DURING peeks reports wall_clock, never a false 'fetches'", async () => {
    // Review finding: tryAcquire refuses on remainingMs() <= 0 before the
    // route's deadline timer fires, and the kind attribution consulted only
    // deadlineSignal.aborted — slow peeks made the mislabel reachable.
    let now = 0;
    const clock = { now: () => now };
    const budget = createRunBudget({ maxFetches: 12, deadlineMs: 60_000 }, clock);
    const fetcher: PageFetcher = {
      cached: async () => {
        now = 61_000; // the peek itself eats the whole window
        return null;
      },
      fetchClean: async () => {
        throw new Error("unreachable: the window is spent before any dispatch");
      },
    };
    const { events } = await runEnricher({ fetcher, clock, budget, runStartedAt: 0 });
    const notices = ofType(events, "budget.exhausted");
    expect(notices).toMatchObject([{ kind: "wall_clock", skippedTiers: [1, 2, 3] }]);
  });

  it("a fetcher whose cached() throws degrades to plain fetching, never a dead run", async () => {
    const inner = new FakePageFetcher({ "https://acme.dev/": makePage("https://acme.dev/") });
    const fetcher: PageFetcher = {
      cached: async () => {
        throw new Error("cache exploded");
      },
      fetchClean: (url, token) => inner.fetchClean(url, token),
    };
    const { events, result } = await runEnricher({ fetcher });
    expect(result.fetchesUsed).toBeGreaterThan(0);
    expect(
      ofType(events, "enrichment.tier.completed").find((t) => t.tier === 1)?.status,
    ).toBe("found");
  });
});
