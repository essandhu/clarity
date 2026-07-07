import { describe, expect, it } from "vitest";
import { makeProfile, pastedRef, scriptedModel, webRef } from "@/domain/synthesis/synthesisTestKit";
import { FakePageFetcher } from "@/providers/fetch/FakePageFetcher";
import { coverageOf, makePage, makeSurfacer, spentBudget } from "./contactTestKit";

// The careers-page + named-people paths live in
// PublicSourceContactSurfacer.people.test.ts (~200-line ceiling split).

describe("PublicSourceContactSurfacer — listing channel", () => {
  it("surfaces applicationContact as a public listing candidate citing the pasted ref", async () => {
    const { surfacer, tried, deps } = makeSurfacer();
    const candidates = await surfacer.find(
      makeProfile({ applicationContact: "recruiting@acme.dev" }),
      coverageOf({ 0: [pastedRef] }),
    );
    expect(candidates).toContainEqual({
      channel: "listing",
      confidence: "public",
      name: undefined,
      value: "recruiting@acme.dev",
      source: pastedRef,
    });
    expect(tried).toContainEqual({ id: "listing", status: "found" });
    // The pasted sentinel is NEVER fetched; with no careers/org page in
    // coverage there is nothing to fetch at all.
    expect((deps.fetcher as FakePageFetcher).calls).toHaveLength(0);
  });

  it("cites the real listing ref on the URL path", async () => {
    const listingRef = webRef("https://boards.example.com/acme/1", "Backend Engineer — Acme");
    const { surfacer } = makeSurfacer();
    const candidates = await surfacer.find(
      makeProfile({ applicationContact: "recruiting@acme.dev" }),
      coverageOf({ 0: [listingRef] }),
    );
    expect(candidates[0].source).toBe(listingRef);
  });

  it("reports listing none when the profile has no applicationContact", async () => {
    const { surfacer, tried } = makeSurfacer();
    const candidates = await surfacer.find(makeProfile(), coverageOf({ 0: [pastedRef] }));
    expect(candidates).toEqual([]);
    expect(tried).toContainEqual({ id: "listing", status: "none" });
  });
});

describe("PublicSourceContactSurfacer — cached careers page (increment 9)", () => {
  const careersRef = webRef("https://acme.dev/careers");

  it("a warm cache re-reads the careers page without spending the contact budget", async () => {
    const fetcher = new FakePageFetcher();
    fetcher.setCached(
      careersRef.url,
      makePage(careersRef.url, "Acme Robotics careers. Talk to our team."),
    );
    const { surfacer, tried } = makeSurfacer({ fetcher, budget: spentBudget() });
    await surfacer.find(makeProfile(), coverageOf({ 0: [pastedRef], 1: [careersRef] }));
    // Read, not skipped: with this spent budget an UNCACHED careers ref is a
    // budget_exhausted skip (asserted below); no fetchClean call happened.
    expect(tried).toContainEqual({ id: "careers", status: "none" });
    expect(fetcher.calls).toHaveLength(0);
    expect(fetcher.peeks).toContain(careersRef.url);
  });

  it("a cached careers page feeds people extraction — a published email surfaces public", async () => {
    const fetcher = new FakePageFetcher();
    fetcher.setCached(
      careersRef.url,
      makePage(careersRef.url, "Reach our recruiter Sam Lee at sam@acme.dev."),
    );
    const { surfacer, tried } = makeSurfacer({
      fetcher,
      budget: spentBudget(),
      model: scriptedModel({
        extractions: [
          { people: [{ name: "Sam Lee", email: "sam@acme.dev", sourceUrl: careersRef.url }] },
        ],
      }),
    });
    const candidates = await surfacer.find(
      makeProfile(),
      coverageOf({ 0: [pastedRef], 1: [careersRef] }),
    );
    // The positive warm path end-to-end: cached page → excerpt → grounded
    // person → public careers candidate — all without a budget slot.
    expect(candidates).toContainEqual(
      expect.objectContaining({ channel: "careers", confidence: "public", value: "sam@acme.dev" }),
    );
    expect(tried).toContainEqual({ id: "careers", status: "found" });
    expect(fetcher.calls).toHaveLength(0);
  });

  it("uncached control: the same spent budget skips the careers read", async () => {
    const { surfacer, tried } = makeSurfacer({ budget: spentBudget() });
    await surfacer.find(makeProfile(), coverageOf({ 0: [pastedRef], 1: [careersRef] }));
    expect(tried).toContainEqual({
      id: "careers",
      status: "skipped",
      skip: { kind: "skip", url: careersRef.url, reason: "budget_exhausted" },
    });
  });

  it("a cached careers page whose finalUrl is non-public is refused like a fresh one", async () => {
    const fetcher = new FakePageFetcher();
    fetcher.setCached(careersRef.url, {
      ...makePage(careersRef.url, "internal snapshot"),
      finalUrl: "http://127.0.0.1/admin",
    });
    const { surfacer, tried } = makeSurfacer({ fetcher });
    await surfacer.find(makeProfile(), coverageOf({ 0: [pastedRef], 1: [careersRef] }));
    expect(tried).toContainEqual({
      id: "careers",
      status: "skipped",
      skip: expect.objectContaining({ reason: "empty_content" }),
    });
  });
});

describe("PublicSourceContactSurfacer — github gate", () => {
  it("tries GitHub only for engineering roles", async () => {
    const org = webRef("https://github.com/acme");
    const engineering = makeSurfacer();
    await engineering.surfacer.find(makeProfile(), coverageOf({ 0: [pastedRef], 2: [org] }));
    expect(engineering.tried.map((t) => t.id)).toEqual(["listing", "careers", "github"]);

    const sales = makeSurfacer();
    await sales.surfacer.find(
      makeProfile({ role: "Account Executive" }),
      coverageOf({ 0: [pastedRef], 2: [org] }),
    );
    expect(sales.tried.map((t) => t.id)).toEqual(["listing", "careers"]);
    expect((sales.deps.fetcher as FakePageFetcher).calls).toHaveLength(0);
  });
});
