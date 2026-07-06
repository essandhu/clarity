import { ZodError, type z } from "zod";
import { PipelineError } from "@/domain/pipeline/errors";
import type { RunBudget } from "@/domain/pipeline/RunBudget";
import { stepOk, stepSkipped, stepStarted, type StepEmit } from "@/domain/pipeline/steps";
import { listingExtractionPrompt } from "@/domain/synthesis/prompts";
import type { PageFetcher } from "@/providers/fetch/PageFetcher";
import type { ModelProvider } from "@/providers/model/ModelProvider";
import {
  ListingProfileSchema,
  pastedListingRef,
  RAW_TEXT_MAX,
  type AnalyzeInput,
  type CleanPage,
  type FetchSkip,
  type ListingProfile,
  type SourceRef,
} from "@/shared/schema";
import { deriveDomain } from "./domainDeriver";
import { capRawText, normalizeExtraction } from "./extractionNormalize";
import { invalidInput } from "./listingFetchError";

// Stage 1 (PLAN.md §4): (url | text) -> fetch/clean -> extract -> ListingProfile.
// Text input goes straight to the model; URL input spends exactly one budgeted
// fetch, and a skip there IS fatal (INPUT_INVALID steering to the paste path) —
// the listing is the run's entire subject, unlike every later fetch.

// ListingProfile.rawText's schema cap, single-sourced from the schema itself.
// The SAME capped text is what the model extracts from, so profile.rawText is
// exactly the text that was analyzed. Pasted text beyond it (input allows 50k)
// is deliberately not analyzed — documented in CLAUDE.md.
export const RAW_TEXT_CAP = RAW_TEXT_MAX;

// SourceRef labels reach the wire and the UI; a page <title> is attacker-
// controlled and unbounded, so it is clipped here at ref construction.
const MAX_LABEL_CHARS = 200;

// What the model is asked for. rawText and listingUrl are code-owned (the
// model must never echo 20k chars back or fabricate a URL), and `domain` is
// post-processed by domainDeriver rather than trusted as extracted.
const ListingExtractionSchema = ListingProfileSchema.omit({
  rawText: true,
  listingUrl: true,
});
type ListingExtraction = z.infer<typeof ListingExtractionSchema>;

// Stage-1 step ids, unique per run. The timeline shows the fetch and the
// model call as separate live rows (§8's agent-step showpiece).
export const STEP_LISTING_FETCH = "listing-fetch";
export const STEP_LISTING_EXTRACT = "listing-extract";

export interface ListingExtractorDeps {
  model: ModelProvider;
  fetcher: PageFetcher;
}

export interface ListingExtractorOpts {
  budget: RunBudget;
  /** ISO timestamp of run submission — becomes pastedListingRef.fetchedAt. */
  submittedAt: string;
  /** User-cancel signal for the model call; the wall-clock deadline never
   *  touches model calls (decision 15) — it rides in via the BudgetToken. */
  signal?: AbortSignal;
  /** Step-event sink. Skip-terminated steps are finished here before the
   *  throw; a step open when an error propagates is paired by the PIPELINE's
   *  terminal teardown (§3 ordering guarantee 3), deliberately not here. */
  onStep?: StepEmit;
}

export interface ExtractedListing {
  profile: ListingProfile;
  /** The run's Tier-0 source (decision 33): the fetched page's ref for URL
   *  input, the canonical `listing:pasted` ref for pasted text. */
  listingSource: SourceRef;
}

export async function extractListing(
  input: AnalyzeInput,
  deps: ListingExtractorDeps,
  opts: ListingExtractorOpts,
): Promise<ExtractedListing> {
  const onStep = opts.onStep ?? (() => {});
  if (input.kind === "text") {
    const rawText = capRawText(input.text);
    onStep(stepStarted(STEP_LISTING_EXTRACT, "extraction", "Extracting listing details…"));
    const extracted = await extractFields(rawText, deps.model, opts.signal);
    const profile = parseProfile({
      ...extracted,
      // rawText competes ONLY on the paste path: the pasted listing is
      // user-chosen material, while a fetched page's cleaned text is
      // third-party (its sole-URL fallback could crown a stranger's link).
      domain: deriveDomain({
        applicationContact: extracted.applicationContact,
        modelDomain: extracted.domain,
        rawText,
      }),
      rawText,
    });
    onStep(stepOk(STEP_LISTING_EXTRACT));
    return { profile, listingSource: pastedListingRef(opts.submittedAt) };
  }

  const { page, listingSource } = await fetchListingPage(
    input.url,
    deps.fetcher,
    opts.budget,
    onStep,
  );
  const rawText = capRawText(page.text);
  onStep(stepStarted(STEP_LISTING_EXTRACT, "extraction", "Extracting listing details…"));
  const extracted = await extractFields(rawText, deps.model, opts.signal);
  const profile = parseProfile({
    ...extracted,
    domain: deriveDomain({
      listingUrl: input.url,
      finalUrl: page.finalUrl,
      applicationContact: extracted.applicationContact,
      modelDomain: extracted.domain,
    }),
    listingUrl: input.url,
    rawText,
  });
  onStep(stepOk(STEP_LISTING_EXTRACT));
  return { profile, listingSource };
}

// The composed profile can still fail the full schema after a schema-valid
// extract (e.g. a required field that trims to empty). That is an honest
// extraction failure — never a raw ZodError escaping the 4-code taxonomy.
function parseProfile(candidate: unknown): ListingProfile {
  try {
    return ListingProfileSchema.parse(candidate);
  } catch (err) {
    if (!(err instanceof ZodError)) throw err;
    throw new PipelineError(
      "EXTRACTION_FAILED",
      "The model's extraction did not yield a valid listing profile.",
      {
        hint: "Retry, or switch to a stronger model — the README names known-good local tags.",
        stage: "extraction",
        cause: err,
      },
    );
  }
}

async function fetchListingPage(
  url: string,
  fetcher: PageFetcher,
  budget: RunBudget,
  onStep: StepEmit,
): Promise<{ page: CleanPage; listingSource: SourceRef }> {
  onStep(stepStarted(STEP_LISTING_FETCH, "extraction", "Reading listing page…", { url }));
  const token = budget.tryAcquire("listing page");
  if (token === null) {
    const skip: FetchSkip = { kind: "skip", url, reason: "budget_exhausted" };
    onStep(stepSkipped(STEP_LISTING_FETCH, skip));
    throw invalidInput(skip);
  }
  const result = await fetcher.fetchClean(url, token);
  if (result.kind === "skip") {
    onStep(stepSkipped(STEP_LISTING_FETCH, result));
    throw invalidInput(result);
  }
  const listingSource: SourceRef = {
    url: result.finalUrl,
    label: (result.title.trim() || "Job listing").slice(0, MAX_LABEL_CHARS),
    fetchedAt: result.fetchedAt,
  };
  onStep(stepOk(STEP_LISTING_FETCH, { source: listingSource }));
  return { page: result, listingSource };
}

async function extractFields(
  listingText: string,
  model: ModelProvider,
  signal?: AbortSignal,
): Promise<ListingExtraction> {
  const { system, prompt } = listingExtractionPrompt(listingText);
  const extracted = await model.extract(prompt, ListingExtractionSchema, {
    system,
    temperature: 0,
    abortSignal: signal,
  });
  return normalizeExtraction(extracted);
}
