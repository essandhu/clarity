import { ZodError, type z } from "zod";
import { PipelineError } from "@/domain/pipeline/errors";
import type { RunBudget } from "@/domain/pipeline/RunBudget";
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
  type FetchSkipReason,
  type ListingProfile,
  type SourceRef,
} from "@/shared/schema";
import { deriveDomain } from "./domainDeriver";
import { capRawText, normalizeExtraction } from "./extractionNormalize";

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

const PASTE_HINT =
  "Paste the listing text instead — pasted text needs no fetch and always works.";

// Exhaustive by construction: adding a FetchSkipReason breaks this build until
// the new reason gets a human explanation (decision 23's spirit).
const SKIP_DESCRIPTIONS: Record<FetchSkipReason, string> = {
  robots_disallowed: "the site's robots.txt does not allow fetching it",
  timeout: "the page took too long to respond",
  http_status: "the server returned an error status",
  not_html: "the URL does not point to an HTML page",
  network: "the host could not be reached",
  too_large: "the page is too large to process",
  empty_content: "no readable listing text was found on the page",
  circuit_open: "repeated failures on this host paused fetching",
  budget_exhausted: "the run budget was exhausted",
  cancelled: "the run was cancelled",
};

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
  if (input.kind === "text") {
    const rawText = capRawText(input.text);
    const extracted = await extractFields(rawText, deps.model, opts.signal);
    return {
      profile: parseProfile({
        ...extracted,
        domain: deriveDomain({
          applicationContact: extracted.applicationContact,
          modelDomain: extracted.domain,
        }),
        rawText,
      }),
      listingSource: pastedListingRef(opts.submittedAt),
    };
  }

  const page = await fetchListingPage(input.url, deps.fetcher, opts.budget);
  const rawText = capRawText(page.text);
  const extracted = await extractFields(rawText, deps.model, opts.signal);
  return {
    profile: parseProfile({
      ...extracted,
      domain: deriveDomain({
        listingUrl: input.url,
        finalUrl: page.finalUrl,
        applicationContact: extracted.applicationContact,
        modelDomain: extracted.domain,
      }),
      listingUrl: input.url,
      rawText,
    }),
    listingSource: {
      url: page.finalUrl,
      label: (page.title.trim() || "Job listing").slice(0, MAX_LABEL_CHARS),
      fetchedAt: page.fetchedAt,
    },
  };
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
): Promise<CleanPage> {
  const token = budget.tryAcquire("listing page");
  if (token === null) {
    throw invalidInput({ kind: "skip", url, reason: "budget_exhausted" });
  }
  const result = await fetcher.fetchClean(url, token);
  if (result.kind === "skip") throw invalidInput(result);
  return result;
}

function invalidInput(skip: FetchSkip): PipelineError {
  return new PipelineError(
    "INPUT_INVALID",
    `Could not read the listing page: ${SKIP_DESCRIPTIONS[skip.reason]}` +
      `${skip.httpStatus !== undefined ? ` (HTTP ${skip.httpStatus})` : ""}.`,
    { hint: PASTE_HINT, stage: "extraction" },
  );
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
