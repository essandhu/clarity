import { PipelineError } from "@/domain/pipeline/errors";
import type { FetchSkip, FetchSkipReason } from "@/shared/schema";

// The fatal half of Stage 1's URL path: a skip on the LISTING fetch is
// INPUT_INVALID (the listing is the run's entire subject, unlike every later
// fetch), with copy steering to the paste path. Pre-split from
// ListingExtractor.ts under the ~200-line ceiling.

export const PASTE_HINT =
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

export function invalidInput(skip: FetchSkip): PipelineError {
  // "cancelled" alone would mislead on the one non-user path that reaches a
  // live stream — the run DEADLINE firing mid-listing-fetch — so that reason
  // surfaces its detail ("Run deadline reached after N ms."). A user cancel
  // never renders this message: the pipeline returns silently on abort.
  const detail =
    skip.reason === "cancelled" && skip.detail ? ` (${skip.detail.slice(0, 200)})` : "";
  return new PipelineError(
    "INPUT_INVALID",
    `Could not read the listing page: ${SKIP_DESCRIPTIONS[skip.reason]}` +
      `${skip.httpStatus !== undefined ? ` (HTTP ${skip.httpStatus})` : ""}.${detail}`,
    { hint: PASTE_HINT, stage: "extraction" },
  );
}
