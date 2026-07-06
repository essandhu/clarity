import { describe, expect, it } from "vitest";
import { createRunBudget } from "@/domain/pipeline/RunBudget";
import { FakePageFetcher } from "@/providers/fetch/FakePageFetcher";
import { PipelineEventSchema } from "@/shared/schema";
import { enrichCompany, type EnrichmentEvent } from "./CompanyEnricher";
import { makePage, makeProfile, ofType, pastedRef, runEnricher } from "./enricherTestKit";

// The §7 budget proofs: exact acquisition accounting with zero network for
// budget-skipped candidates, and the two budget.exhausted kinds — each
// emitted at most once.

describe("enrichCompany — fetch-count exhaustion", () => {
  it("2 acquired, 4 budget-skipped: zero network for the skipped, one 'fetches' notice", async () => {
    const homepage = makePage("https://acme.dev/", {
      links: [{ url: "https://acme.dev/blog", text: "Blog" }],
    });
    const fetcher = new FakePageFetcher({
      "https://acme.dev/": homepage,
      "https://acme.dev/about": makePage("https://acme.dev/about"),
    });
    const { events, result } = await runEnricher({ fetcher, maxFetches: 2 });

    // Exactly the two acquired candidates ever hit the fetcher.
    expect(fetcher.calls.map((c) => c.url)).toEqual([
      "https://acme.dev/",
      "https://acme.dev/about",
    ]);
    expect(result.fetchesUsed).toBe(2);

    const finished = ofType(events, "step.finished");
    const budgetSkips = finished.filter((e) => e.skip?.reason === "budget_exhausted");
    expect(budgetSkips).toHaveLength(4); // 3 tier-1 candidates + 1 discovered blog
    expect(finished.filter((e) => e.status === "ok")).toHaveLength(2);

    const tiers = ofType(events, "enrichment.tier.completed");
    expect(tiers.map((t) => [t.tier, t.status])).toEqual([
      [0, "found"],
      [1, "found"], // two pages landed before the counter ran out
      [2, "skipped_budget"], // its only candidate was budget-skipped
      [3, "not_found"], // the fetched pages carried no news links
    ]);

    const notices = ofType(events, "budget.exhausted");
    expect(notices).toEqual([
      {
        type: "budget.exhausted",
        kind: "fetches",
        fetchesUsed: 2,
        elapsedMs: 0,
        skippedTiers: [2],
      },
    ]);
  });
});

describe("enrichCompany — wall-clock exhaustion (MIN_USEFUL_MS pre-check)", () => {
  it("deadline already spent before tier 1: tiers 1–3 skipped, ONE wall_clock notice, zero steps", async () => {
    let now = 0;
    const clock = { now: () => now };
    const fetcher = new FakePageFetcher();
    // Budget epoch at 0, then the clock jumps past the deadline before the
    // enricher's first pre-check (a slow Stage-1 extract ate the run).
    const budget = createRunBudget({ maxFetches: 12, deadlineMs: 60_000 }, clock);
    now = 61_000;
    const { events } = await runEnricher({ fetcher, clock, budget, runStartedAt: 0 });
    expect(fetcher.calls).toHaveLength(0);
    expect(ofType(events, "step.started")).toHaveLength(0);
    const tiers = ofType(events, "enrichment.tier.completed");
    expect(tiers.map((t) => [t.tier, t.status])).toEqual([
      [0, "found"],
      [1, "skipped_budget"],
      [2, "skipped_budget"],
      [3, "skipped_budget"],
    ]);
    expect(ofType(events, "budget.exhausted")).toEqual([
      {
        type: "budget.exhausted",
        kind: "wall_clock",
        fetchesUsed: 0,
        elapsedMs: 61_000,
        skippedTiers: [1, 2, 3],
      },
    ]);
  });

  it("deadline crossed during tier 1: tier 1 stays honest, tiers 2–3 skipped with one notice", async () => {
    let now = 0;
    const clock = { now: () => now };
    const fetcher = new FakePageFetcher({ "https://acme.dev/": makePage("https://acme.dev/") });
    const original = fetcher.fetchClean.bind(fetcher);
    fetcher.fetchClean = async (url, token) => {
      now = 59_500; // the tier-1 burst eats almost the whole deadline
      return original(url, token);
    };
    const { events } = await runEnricher({ fetcher, clock, deadlineMs: 60_000 });
    const tiers = ofType(events, "enrichment.tier.completed");
    expect(tiers.map((t) => [t.tier, t.status])).toEqual([
      [0, "found"],
      [1, "found"],
      [2, "skipped_budget"],
      [3, "skipped_budget"],
    ]);
    const notices = ofType(events, "budget.exhausted");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "wall_clock", skippedTiers: [2, 3] });
    // No tier-2/3 steps: the pre-check refuses to start work it cannot finish.
    expect(ofType(events, "step.started").filter((e) => e.tier !== 1)).toHaveLength(0);
  });

  it("a wall-clock stop never swallows a pending fetches notice — both kinds, each once (review finding)", async () => {
    let now = 0;
    const clock = { now: () => now };
    const budget = createRunBudget({ maxFetches: 1, deadlineMs: 60_000 }, clock);
    budget.tryAcquire("stage-1 listing fetch"); // the counter is already spent
    const events: EnrichmentEvent[] = [];
    const result = await enrichCompany(
      makeProfile(),
      pastedRef,
      { fetcher: new FakePageFetcher() },
      {
        budget,
        clock,
        runStartedAt: 0,
        cancel: new AbortController().signal,
        emit: (event) => {
          events.push(PipelineEventSchema.parse(event) as EnrichmentEvent);
          // The deadline all but runs out while tier 1's budget skips emit.
          if (event.type === "enrichment.tier.completed" && event.tier === 1) now = 59_900;
        },
      },
    );
    expect(result.tiers.map((t) => t.status)).toEqual([
      "found",
      "skipped_budget",
      "skipped_budget",
      "skipped_budget",
    ]);
    expect(ofType(events, "budget.exhausted")).toEqual([
      expect.objectContaining({ kind: "fetches", skippedTiers: [1] }),
      expect.objectContaining({ kind: "wall_clock", skippedTiers: [2, 3] }),
    ]);
  });
});
