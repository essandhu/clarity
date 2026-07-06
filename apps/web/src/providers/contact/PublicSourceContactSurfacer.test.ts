import { describe, expect, it } from "vitest";
import { makeProfile, pastedRef, webRef } from "@/domain/synthesis/synthesisTestKit";
import { FakePageFetcher } from "@/providers/fetch/FakePageFetcher";
import { coverageOf, makeSurfacer } from "./contactTestKit";

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
