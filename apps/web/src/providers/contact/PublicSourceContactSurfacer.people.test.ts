import { describe, expect, it } from "vitest";
import { PipelineError } from "@/domain/pipeline/errors";
import { makeProfile, pastedRef, scriptedModel, webRef } from "@/domain/synthesis/synthesisTestKit";
import { FakePageFetcher } from "@/providers/fetch/FakePageFetcher";
import { coverageOf, makePage, makeSurfacer, spentBudget } from "./contactTestKit";

// The careers-page re-read + named-people extraction half of the surfacer
// tests — split from PublicSourceContactSurfacer.test.ts (~200-line ceiling).

const CAREERS_URL = "https://acme.dev/careers";

describe("PublicSourceContactSurfacer — careers page + named people", () => {
  const peopleFromCareers = {
    people: [{ name: "Sam Lee", role: "Recruiter", sourceUrl: CAREERS_URL }],
  };

  it("re-reads the careers page and fans a named person into guess candidates", async () => {
    const { surfacer, tried, deps } = makeSurfacer({
      model: scriptedModel({ extractions: [peopleFromCareers] }),
      fetcher: new FakePageFetcher({
        [CAREERS_URL]: makePage(CAREERS_URL, "Recruiting is led by Sam Lee."),
      }),
    });
    const candidates = await surfacer.find(
      makeProfile({ domain: "acme.dev" }),
      coverageOf({ 0: [pastedRef], 1: [webRef(CAREERS_URL)] }),
    );
    expect(candidates).toContainEqual(
      expect.objectContaining({
        channel: "linkedin",
        confidence: "guess",
        name: "Sam Lee",
        value: expect.stringContaining("linkedin.com/search/results/people"),
      }),
    );
    expect(candidates).toContainEqual(
      expect.objectContaining({
        channel: "inferred-email",
        confidence: "guess",
        value: "sam.lee@acme.dev",
      }),
    );
    expect(tried).toContainEqual({ id: "careers", status: "found" });
    expect((deps.fetcher as FakePageFetcher).calls.map((c) => c.url)).toEqual([CAREERS_URL]);
  });

  it("keeps a published person email as a public careers candidate and skips the inferred guess", async () => {
    const { surfacer } = makeSurfacer({
      model: scriptedModel({
        extractions: [
          { people: [{ name: "Sam Lee", email: "sam@acme.dev", sourceUrl: CAREERS_URL }] },
        ],
      }),
      fetcher: new FakePageFetcher({
        [CAREERS_URL]: makePage(CAREERS_URL, "Reach Sam Lee at sam@acme.dev."),
      }),
    });
    const candidates = await surfacer.find(
      makeProfile({ domain: "acme.dev" }),
      coverageOf({ 0: [pastedRef], 1: [webRef(CAREERS_URL)] }),
    );
    expect(candidates).toContainEqual(
      expect.objectContaining({ channel: "careers", confidence: "public", value: "sam@acme.dev" }),
    );
    expect(candidates.some((c) => c.channel === "inferred-email")).toBe(false);
  });

  it("downgrades a hallucinated person email to honest guesses — never a 'public' badge", async () => {
    // The model claims an address the careers page never publishes: exactly
    // the pattern inferEmailPatterns would guess, but wearing 'public' it
    // would bypass decision 28's accept click (review finding, HIGH).
    const { surfacer } = makeSurfacer({
      model: scriptedModel({
        extractions: [
          { people: [{ name: "Sam Lee", email: "sam.lee@acme.dev", sourceUrl: CAREERS_URL }] },
        ],
      }),
      fetcher: new FakePageFetcher({
        [CAREERS_URL]: makePage(CAREERS_URL, "Recruiting is led by Sam Lee — no email here."),
      }),
    });
    const candidates = await surfacer.find(
      makeProfile({ domain: "acme.dev" }),
      coverageOf({ 0: [pastedRef], 1: [webRef(CAREERS_URL)] }),
    );
    expect(candidates.some((c) => c.confidence === "public")).toBe(false);
    expect(candidates).toContainEqual(
      expect.objectContaining({
        channel: "inferred-email",
        confidence: "guess",
        value: "sam.lee@acme.dev",
      }),
    );
  });

  it("refuses careers content when the fetch redirected to a non-public host", async () => {
    const page = makePage(CAREERS_URL, "Internal wiki. Reach ops@internal.");
    const { surfacer, tried } = makeSurfacer({
      fetcher: new FakePageFetcher({
        [CAREERS_URL]: { ...page, finalUrl: "http://192.168.1.10/wiki" },
      }),
    });
    await surfacer.find(makeProfile(), coverageOf({ 0: [pastedRef], 1: [webRef(CAREERS_URL)] }));
    expect(tried).toContainEqual(
      expect.objectContaining({
        id: "careers",
        status: "skipped",
        skip: expect.objectContaining({
          reason: "empty_content",
          detail: expect.stringContaining("non-public host"),
        }),
      }),
    );
  });

  it("drops people with fabricated source attributions", async () => {
    const { surfacer } = makeSurfacer({
      model: scriptedModel({
        extractions: [
          { people: [{ name: "Made Up", sourceUrl: "https://elsewhere.example/x" }] },
        ],
      }),
    });
    const candidates = await surfacer.find(makeProfile(), coverageOf({ 0: [pastedRef] }));
    expect(candidates).toEqual([]);
  });

  it("reports a careers fetch skip honestly and still extracts from the listing", async () => {
    const { surfacer, tried } = makeSurfacer({
      model: scriptedModel({
        extractions: [{ people: [{ name: "Jane Doe", sourceUrl: "listing:pasted" }] }],
      }),
      fetcher: new FakePageFetcher({
        [CAREERS_URL]: { kind: "skip", url: CAREERS_URL, reason: "http_status", httpStatus: 404 },
      }),
    });
    const candidates = await surfacer.find(
      makeProfile(),
      coverageOf({ 0: [pastedRef], 1: [webRef(CAREERS_URL)] }),
    );
    expect(tried).toContainEqual(
      expect.objectContaining({ id: "careers", status: "skipped", skip: expect.objectContaining({ reason: "http_status" }) }),
    );
    expect(candidates).toContainEqual(
      expect.objectContaining({ channel: "linkedin", name: "Jane Doe", source: pastedRef }),
    );
  });

  it("skips the careers fetch as budget_exhausted with zero network when the budget is spent", async () => {
    const { surfacer, tried, deps } = makeSurfacer({ budget: spentBudget() });
    await surfacer.find(makeProfile(), coverageOf({ 0: [pastedRef], 1: [webRef(CAREERS_URL)] }));
    expect(tried).toContainEqual(
      expect.objectContaining({ id: "careers", status: "skipped", skip: expect.objectContaining({ reason: "budget_exhausted" }) }),
    );
    expect((deps.fetcher as FakePageFetcher).calls).toHaveLength(0);
  });

  it("never fetches a private-host careers ref from client-supplied coverage", async () => {
    const { surfacer, deps } = makeSurfacer();
    await surfacer.find(
      makeProfile(),
      coverageOf({ 0: [pastedRef], 1: [webRef("https://it.corp/careers")] }),
    );
    expect((deps.fetcher as FakePageFetcher).calls).toHaveLength(0);
  });

  it("degrades to zero people when the extract fails, without killing the search", async () => {
    const { surfacer, tried } = makeSurfacer({
      model: scriptedModel({
        extractions: [new PipelineError("EXTRACTION_FAILED", "no valid people")],
      }),
    });
    const candidates = await surfacer.find(
      makeProfile({ applicationContact: "recruiting@acme.dev" }),
      coverageOf({ 0: [pastedRef] }),
    );
    expect(candidates).toHaveLength(1); // the listing candidate survives
    expect(tried).toContainEqual({ id: "careers", status: "none" });
  });

  it("rethrows aborts — a cancelled search must not read as a clean empty result", async () => {
    const cancel = new AbortController();
    cancel.abort();
    const { surfacer } = makeSurfacer({ cancel: cancel.signal });
    await expect(
      surfacer.find(makeProfile(), coverageOf({ 0: [pastedRef] })),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
