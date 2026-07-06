import { describe, expect, it } from "vitest";
import { FakePageFetcher } from "@/providers/fetch/FakePageFetcher";
import { makePage, ofType, runEnricher } from "./enricherTestKit";

// Decision-20 wiring: tier 2/3 candidates come from real anchors on fetched
// tier-1 pages; slug guesses only when discovery found nothing, and a guessed
// page counts as found only on a loose company-name match.

const homepageWithLinks = makePage("https://acme.dev/", {
  links: [
    { url: "https://github.com/acme-io/robot-firmware", text: "Code" },
    { url: "https://acme.dev/blog", text: "Blog" },
    { url: "https://acme.dev/press", text: "Press" },
  ],
});

describe("enrichCompany — discovered tier 2/3", () => {
  it("fetches org/blog into tier 2 and news into tier 3, no name match required", async () => {
    const fetcher = new FakePageFetcher({
      "https://acme.dev/": homepageWithLinks,
      // Unrelated titles/text on purpose: DISCOVERED links carry no name-match
      // requirement (they came off the company's own page).
      "https://github.com/acme-io": makePage("https://github.com/acme-io", {
        title: "acme-io · GitHub",
        text: "Repositories: robot-firmware, warehouse-sdk. ".repeat(10),
      }),
      "https://acme.dev/blog": makePage("https://acme.dev/blog", {
        title: "Field Notes",
        text: "Posts about conveyor tuning and pallet vision. ".repeat(10),
      }),
      "https://acme.dev/press": makePage("https://acme.dev/press", {
        title: "Press",
        text: "Coverage and launch announcements. ".repeat(10),
      }),
    });
    const { events, result } = await runEnricher({ fetcher });

    const tiers = ofType(events, "enrichment.tier.completed");
    expect(tiers.find((t) => t.tier === 2)?.status).toBe("found");
    expect(tiers.find((t) => t.tier === 2)?.sources.map((s) => s.url)).toEqual([
      "https://github.com/acme-io",
      "https://acme.dev/blog",
    ]);
    expect(tiers.find((t) => t.tier === 3)?.status).toBe("found");
    expect(tiers.find((t) => t.tier === 3)?.sources.map((s) => s.url)).toEqual([
      "https://acme.dev/press",
    ]);
    // No slug guesses anywhere: discovery found real anchors.
    const urls = fetcher.calls.map((c) => c.url);
    expect(urls).not.toContain("https://github.com/acme");
    expect(urls).not.toContain("https://blog.acme.dev");
    expect(result.tiers.find((t) => t.tier === 2)?.extracted["https://github.com/acme-io"]).toContain(
      "robot-firmware",
    );
  });

  it("a discovered link equal to an already-attempted URL is never re-fetched", async () => {
    const selfLinking = makePage("https://acme.dev/", {
      links: [{ url: "https://acme.dev/about/", text: "Blog" }], // dup of tier-1 /about
    });
    const fetcher = new FakePageFetcher({
      "https://acme.dev/": selfLinking,
      "https://acme.dev/about": makePage("https://acme.dev/about"),
    });
    const { events } = await runEnricher({ fetcher });
    expect(fetcher.calls.filter((c) => c.url.includes("/about"))).toHaveLength(1);
    // Tier 2 fell back to slug guesses (discovery yielded only a duplicate).
    const tier2Steps = ofType(events, "step.started").filter((e) => e.tier === 2);
    expect(tier2Steps.map((e) => e.label)).toEqual([
      "Checking guessed GitHub org…",
      "Checking guessed blog…",
    ]);
  });
});

describe("enrichCompany — slug-guess fallback and the loose name match", () => {
  it("a guess matching the company name counts; a mismatching guess is an honest skip", async () => {
    const fetcher = new FakePageFetcher({
      "https://acme.dev/": makePage("https://acme.dev/"), // no links -> guesses
      "https://github.com/acme": makePage("https://github.com/acme", {
        title: "Acme Robotics · GitHub",
        text: "Acme Robotics has 12 repositories available. ".repeat(10),
      }),
      "https://blog.acme.dev": makePage("https://blog.acme.dev", {
        title: "Squatted Domain For Sale",
        text: "Buy this great domain today. Premium names available. ".repeat(10),
      }),
    });
    const { events } = await runEnricher({ fetcher });

    const tier2 = ofType(events, "enrichment.tier.completed").find((t) => t.tier === 2);
    expect(tier2?.status).toBe("found");
    expect(tier2?.sources.map((s) => s.url)).toEqual(["https://github.com/acme"]);

    const blogStep = ofType(events, "step.finished").find(
      (e) => e.skip?.url === "https://blog.acme.dev",
    );
    expect(blogStep?.status).toBe("skipped");
    expect(blogStep?.skip).toMatchObject({
      reason: "empty_content",
      detail: expect.stringContaining("never mentions"),
    });
  });

  it("both guesses mismatching leaves tier 2 honestly not_found", async () => {
    const squatted = {
      title: "Parked",
      text: "This domain is parked free, courtesy of a registrar. ".repeat(10),
    };
    const fetcher = new FakePageFetcher({
      "https://acme.dev/": makePage("https://acme.dev/"),
      "https://github.com/acme": makePage("https://github.com/acme", squatted),
      "https://blog.acme.dev": makePage("https://blog.acme.dev", squatted),
    });
    const { events } = await runEnricher({ fetcher });
    expect(ofType(events, "enrichment.tier.completed").find((t) => t.tier === 2)?.status).toBe(
      "not_found",
    );
  });
});
