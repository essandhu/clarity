import { describe, expect, it } from "vitest";
import { FakePageFetcher } from "@/providers/fetch/FakePageFetcher";
import { SOURCE_TEXT_CAP } from "./coverage";
import { makePage, makeProfile, ofType, pastedRef, runEnricher } from "./enricherTestKit";

describe("enrichCompany — Tier 0, the listing itself", () => {
  it("text input: found at zero cost, citing the pasted-listing ref, rawText as extracted", async () => {
    const profile = makeProfile({ domain: undefined });
    const { events, result } = await runEnricher({ fetcher: new FakePageFetcher(), profile });
    expect(events[0]).toEqual({
      type: "enrichment.tier.completed",
      tier: 0,
      status: "found",
      sources: [pastedRef],
    });
    expect(result.tiers[0]?.extracted["listing:pasted"]).toBe(profile.rawText);
    expect(result.fetchesUsed).toBe(0);
  });

  it("url input: Tier 0 cites the fetched listing ref, and its URL is never re-fetched in tier 1", async () => {
    const listingSource = {
      url: "https://acme.dev/jobs",
      label: "Backend Engineer — Acme",
      fetchedAt: "2026-07-05T11:59:00.000Z",
    };
    const fetcher = new FakePageFetcher();
    const profile = makeProfile({ listingUrl: "https://acme.dev/jobs" });
    const { events } = await runEnricher({ fetcher, profile, listingSource });
    expect(events[0]).toMatchObject({ tier: 0, status: "found", sources: [listingSource] });
    const tier1Urls = ofType(events, "step.started")
      .filter((e) => e.tier === 1)
      .map((e) => e.url);
    expect(tier1Urls).toHaveLength(4); // /jobs excluded — it IS the listing
    expect(tier1Urls).not.toContain("https://acme.dev/jobs");
    expect(fetcher.calls.map((c) => c.url)).not.toContain("https://acme.dev/jobs");
  });
});

describe("enrichCompany — Tier 1", () => {
  it("no domain: tiers 1–3 are honest not_found with zero steps and zero network", async () => {
    const fetcher = new FakePageFetcher();
    const { events, result } = await runEnricher({
      fetcher,
      profile: makeProfile({ domain: undefined }),
    });
    const tiers = ofType(events, "enrichment.tier.completed");
    expect(tiers.map((t) => [t.tier, t.status])).toEqual([
      [0, "found"],
      [1, "not_found"],
      [2, "not_found"],
      [3, "not_found"],
    ]);
    expect(ofType(events, "step.started")).toHaveLength(0);
    expect(ofType(events, "budget.exhausted")).toHaveLength(0);
    expect(fetcher.calls).toHaveLength(0);
    expect(result.fetchesUsed).toBe(0);
  });

  it("one dead page never sinks a tier with live siblings — and every step pairs", async () => {
    const fetcher = new FakePageFetcher({
      "https://acme.dev/": makePage("https://acme.dev/"),
      "https://acme.dev/about": {
        kind: "skip",
        url: "https://acme.dev/about",
        reason: "http_status",
        httpStatus: 500,
      },
      "https://acme.dev/careers": makePage("https://acme.dev/careers"),
      // /jobs and /product fall through to the fake's default network skip.
    });
    const { events, result } = await runEnricher({ fetcher });
    const tier1 = ofType(events, "enrichment.tier.completed").find((t) => t.tier === 1);
    expect(tier1?.status).toBe("found");
    expect(tier1?.sources.map((s) => s.url)).toEqual([
      "https://acme.dev/",
      "https://acme.dev/careers",
    ]);
    const started = ofType(events, "step.started");
    const finished = ofType(events, "step.finished");
    // Every started step pairs (tier-2 slug-guess steps included).
    expect(finished.map((e) => e.stepId).sort()).toEqual(started.map((e) => e.stepId).sort());
    const tier1Ids = new Set(started.filter((e) => e.tier === 1).map((e) => e.stepId));
    expect(tier1Ids.size).toBe(5);
    const tier1Finished = finished.filter((e) => tier1Ids.has(e.stepId));
    expect(tier1Finished.filter((e) => e.status === "ok")).toHaveLength(2);
    expect(
      tier1Finished.filter((e) => e.status === "skipped").map((e) => e.skip?.reason),
    ).toEqual(expect.arrayContaining(["http_status", "network", "network"]));
    // 5 tier-1 dispatches + 2 tier-2 slug guesses (both default network skips)
    // — acquisition counts dispatches, not successes.
    expect(result.fetchesUsed).toBe(7);
  });

  it("caps extracted text per source and keys it by final URL", async () => {
    const fetcher = new FakePageFetcher({
      "https://acme.dev/": makePage("https://acme.dev/", {
        finalUrl: "https://www.acme.dev/home",
        text: "x".repeat(SOURCE_TEXT_CAP + 1_000),
      }),
    });
    const { result } = await runEnricher({ fetcher });
    const tier1 = result.tiers.find((t) => t.tier === 1);
    const stored = tier1?.extracted["https://www.acme.dev/home"];
    expect(typeof stored).toBe("string");
    expect((stored as string).length).toBe(SOURCE_TEXT_CAP);
  });

  it("step.started rows carry url + tier for the timeline", async () => {
    const fetcher = new FakePageFetcher({ "https://acme.dev/": makePage("https://acme.dev/") });
    const { events } = await runEnricher({ fetcher });
    const homepage = ofType(events, "step.started").find(
      (e) => e.url === "https://acme.dev/",
    );
    expect(homepage).toMatchObject({
      stage: "enrichment",
      tier: 1,
      label: "Reading company homepage…",
    });
  });
});

describe("enrichCompany — cancellation", () => {
  it("user cancel mid-tier: in-flight steps close as cancelled skips, then silence", async () => {
    const cancel = new AbortController();
    const fetcher = new FakePageFetcher({ "https://acme.dev/": makePage("https://acme.dev/") });
    const original = fetcher.fetchClean.bind(fetcher);
    fetcher.fetchClean = async (url, token) => {
      cancel.abort(); // the user clicks Cancel while tier 1 is in flight
      return original(url, token);
    };
    const { events } = await runEnricher({ fetcher, cancel: cancel.signal });
    const tiers = ofType(events, "enrichment.tier.completed");
    expect(tiers.map((t) => t.tier)).toEqual([0]); // nothing after the abort
    expect(ofType(events, "budget.exhausted")).toHaveLength(0);
    const started = ofType(events, "step.started");
    const finished = ofType(events, "step.finished");
    expect(started.length).toBeGreaterThan(0);
    expect(finished.map((e) => e.stepId).sort()).toEqual(started.map((e) => e.stepId).sort());
    expect(finished.every((e) => e.skip?.reason === "cancelled")).toBe(true);
  });
});
