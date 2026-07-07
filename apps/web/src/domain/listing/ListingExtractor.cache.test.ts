import { describe, expect, it } from "vitest";
import type { StepEvent } from "@/domain/pipeline/steps";
import { PipelineEventSchema } from "@/shared/schema";
import { extraction, page, stubBudget, stubFetcher, stubModel, SUBMITTED_AT } from "./extractorTestKit";
import { extractListing, STEP_LISTING_FETCH } from "./ListingExtractor";

// Increment 9: a cached listing page is served BEFORE budget acquisition —
// re-analyzing yesterday's listing costs no budget slot and no network, and
// the step row says so with the cached tag.

describe("extractListing — cached listing page", () => {
  it("a warm cache serves the listing without tryAcquire, network, or a fetchClean call", async () => {
    const model = stubModel([{ ...extraction, company: "Tessellate" }]);
    // stubFetcher with no result THROWS on fetchClean — reaching it fails the test.
    const fetcher = Object.assign(stubFetcher(), { cached: async () => page });
    const budget = stubBudget();
    const steps: StepEvent[] = [];

    const { profile, listingSource } = await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher },
      {
        budget,
        submittedAt: SUBMITTED_AT,
        onStep: (event) => steps.push(PipelineEventSchema.parse(event) as StepEvent),
      },
    );

    expect(budget.labels).toEqual([]); // the bypass proof
    expect(fetcher.calls).toHaveLength(0);
    expect(listingSource).toEqual({
      url: page.finalUrl,
      label: page.title,
      fetchedAt: page.fetchedAt,
    });
    expect(profile.rawText).toBe(page.text);
    const fetchStep = steps.find(
      (e) => e.type === "step.finished" && e.stepId === STEP_LISTING_FETCH,
    );
    expect(fetchStep).toMatchObject({ status: "ok", cached: true });
  });

  it("a warm cache rescues a run whose budget is already spent", async () => {
    const model = stubModel([extraction]);
    const fetcher = Object.assign(stubFetcher(), { cached: async () => page });
    // Uncached, this budget makes the listing fetch a fatal budget_exhausted
    // INPUT_INVALID — cached, the run proceeds as if the fetch were free.
    const budget = stubBudget({ exhausted: true });

    const { profile } = await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher },
      { budget, submittedAt: SUBMITTED_AT },
    );
    expect(profile.company).toBe("Driftlock");
  });

  it("a throwing cached() is a miss: the listing fetch proceeds normally", async () => {
    const model = stubModel([extraction]);
    const fetcher = Object.assign(stubFetcher(page), {
      cached: async () => {
        throw new Error("cache exploded");
      },
    });
    const budget = stubBudget();

    const { listingSource } = await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher },
      { budget, submittedAt: SUBMITTED_AT },
    );
    expect(budget.labels).toEqual(["listing page"]);
    expect(fetcher.calls).toHaveLength(1);
    expect(listingSource.url).toBe(page.finalUrl);
  });
});
