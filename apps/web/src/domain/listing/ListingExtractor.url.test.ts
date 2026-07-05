import { describe, expect, it } from "vitest";
import { isPipelineError, PipelineError } from "@/domain/pipeline/errors";
import type { CleanPage, FetchSkip } from "@/shared/schema";
import { extraction, page, stubBudget, stubFetcher, stubModel, SUBMITTED_AT } from "./extractorTestKit";
import { extractListing, RAW_TEXT_CAP } from "./ListingExtractor";

describe("extractListing — URL path", () => {
  it("spends one budgeted fetch and cites the fetched page as the Tier-0 ref", async () => {
    const model = stubModel([{ ...extraction, company: "Tessellate", role: "Senior Platform Engineer" }]);
    const fetcher = stubFetcher(page);
    const budget = stubBudget();
    const { profile, listingSource } = await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher },
      { budget, submittedAt: SUBMITTED_AT },
    );

    expect(budget.labels).toEqual(["listing page"]);
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0].url).toBe(page.url);
    // The ACQUIRED token, not a fabricated one — deadline/cancel ride in it.
    expect(fetcher.calls[0].token).toBe(budget.issued[0]);
    expect(listingSource).toEqual({
      url: page.finalUrl,
      label: page.title,
      fetchedAt: page.fetchedAt,
    });
    expect(profile.listingUrl).toBe(page.url);
    expect(profile.rawText).toBe(page.text);
  });

  it("never derives the company domain from an ATS listing URL (greenhouse run)", async () => {
    const model = stubModel([
      { ...extraction, company: "Tessellate", applicationContact: "talent@tessellate.dev" },
    ]);
    const { profile } = await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher: stubFetcher(page) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT },
    );

    expect(profile.domain).toBe("tessellate.dev");
  });

  it("derives the domain from a company-owned listing URL", async () => {
    const companyPage: CleanPage = {
      ...page,
      url: "https://www.acme.dev/careers/1",
      finalUrl: "https://www.acme.dev/careers/1",
    };
    const model = stubModel([extraction]);
    const { profile } = await extractListing(
      { kind: "url", url: companyPage.url },
      { model, fetcher: stubFetcher(companyPage) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT },
    );

    expect(profile.domain).toBe("acme.dev");
  });

  it("lets the model's own domain win when both URL hosts are ATS and no email exists", async () => {
    const model = stubModel([{ ...extraction, company: "Tessellate", domain: "tessellate.dev" }]);
    const { profile } = await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher: stubFetcher(page) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT },
    );

    expect(profile.domain).toBe("tessellate.dev");
  });

  it("derives the domain from the redirect target when the submitted URL is ATS-hosted", async () => {
    const redirected: CleanPage = { ...page, finalUrl: "https://careers.acme.dev/roles/1" };
    const model = stubModel([extraction]);
    const { profile, listingSource } = await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher: stubFetcher(redirected) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT },
    );

    expect(profile.domain).toBe("careers.acme.dev");
    expect(listingSource.url).toBe(redirected.finalUrl);
  });

  it("caps rawText AND the model input for a long fetched page", async () => {
    const longPage: CleanPage = { ...page, text: "y".repeat(RAW_TEXT_CAP + 4_000) };
    const model = stubModel([extraction]);
    const { profile } = await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher: stubFetcher(longPage) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT },
    );

    expect(profile.rawText).toHaveLength(RAW_TEXT_CAP);
    expect(model.calls[0].input).not.toContain("y".repeat(RAW_TEXT_CAP + 1));
  });

  it("threads the caller's abort signal into model.extract", async () => {
    const controller = new AbortController();
    const model = stubModel([extraction]);
    await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher: stubFetcher(page) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT, signal: controller.signal },
    );

    expect(model.calls[0].opts?.abortSignal).toBe(controller.signal);
  });

  it("throws fatal INPUT_INVALID with the paste-steering hint on a fetch skip", async () => {
    const skip: FetchSkip = { kind: "skip", url: page.url, reason: "robots_disallowed" };
    const err = await extractListing(
      { kind: "url", url: page.url },
      { model: stubModel([]), fetcher: stubFetcher(skip) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT },
    ).catch((e: unknown) => e);

    expect(isPipelineError(err) && err.code).toBe("INPUT_INVALID");
    expect((err as PipelineError).message).toContain("robots.txt");
    expect((err as PipelineError).hint).toContain("Paste the listing text");
    expect((err as PipelineError).stage).toBe("extraction");
  });

  it("renders the HTTP status into the INPUT_INVALID message when present", async () => {
    const skip: FetchSkip = { kind: "skip", url: page.url, reason: "http_status", httpStatus: 503 };
    const err = await extractListing(
      { kind: "url", url: page.url },
      { model: stubModel([]), fetcher: stubFetcher(skip) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT },
    ).catch((e: unknown) => e);

    expect(isPipelineError(err) && err.code).toBe("INPUT_INVALID");
    expect((err as PipelineError).message).toContain("(HTTP 503)");
  });

  it("throws INPUT_INVALID when the budget refuses the listing fetch (no dispatch)", async () => {
    const fetcher = stubFetcher();
    const err = await extractListing(
      { kind: "url", url: page.url },
      { model: stubModel([]), fetcher },
      { budget: stubBudget({ exhausted: true }), submittedAt: SUBMITTED_AT },
    ).catch((e: unknown) => e);

    expect(isPipelineError(err) && err.code).toBe("INPUT_INVALID");
    expect(fetcher.calls).toHaveLength(0);
  });

  it("clips an unbounded attacker-controlled page title in the Tier-0 label", async () => {
    const hostile: CleanPage = { ...page, title: "A".repeat(5_000) };
    const model = stubModel([extraction]);
    const { listingSource } = await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher: stubFetcher(hostile) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT },
    );

    expect(listingSource.label).toHaveLength(200);
  });

  it("falls back to a generic label when the page title is blank", async () => {
    const blankTitle: CleanPage = { ...page, title: "   " };
    const model = stubModel([extraction]);
    const { listingSource } = await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher: stubFetcher(blankTitle) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT },
    );

    expect(listingSource.label).toBe("Job listing");
  });

  it("fails as EXTRACTION_FAILED (never a raw ZodError) when a required field trims to empty", async () => {
    const model = stubModel([{ ...extraction, company: "   " }]);
    const err = await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher: stubFetcher(page) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT },
    ).catch((e: unknown) => e);

    expect(isPipelineError(err) && err.code).toBe("EXTRACTION_FAILED");
  });

  it("trims whitespace-padded required fields", async () => {
    const model = stubModel([{ ...extraction, company: "  Tessellate  ", role: " Engineer " }]);
    const { profile } = await extractListing(
      { kind: "url", url: page.url },
      { model, fetcher: stubFetcher(page) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT },
    );

    expect(profile.company).toBe("Tessellate");
    expect(profile.role).toBe("Engineer");
  });

  it("lets model-layer PipelineErrors (EXTRACTION_FAILED) bubble untouched", async () => {
    const failure = new PipelineError("EXTRACTION_FAILED", "no schema-valid output");
    const err = await extractListing(
      { kind: "url", url: page.url },
      { model: stubModel([failure]), fetcher: stubFetcher(page) },
      { budget: stubBudget(), submittedAt: SUBMITTED_AT },
    ).catch((e: unknown) => e);

    expect(err).toBe(failure);
  });
});
