import { z } from "zod";
import { HttpUrlSchema, type SourceRef } from "./sourceRef";

// One shared taxonomy for fetcher-produced AND pipeline-produced skips.
// Skips are data, not errors: returned, never thrown, folded into coverage.
export const FetchSkipReasonSchema = z.enum([
  "robots_disallowed",
  "timeout",
  "http_status",
  "not_html",
  "network",
  "too_large",
  "empty_content",
  "circuit_open",
  "budget_exhausted",
  "cancelled",
]);
export type FetchSkipReason = z.infer<typeof FetchSkipReasonSchema>;

export const FetchSkipSchema = z.object({
  kind: z.literal("skip"),
  // Always set by the fetcher; optional because pipeline-produced skips on
  // non-fetch steps (a cancelled hooks/synthesis step) have no URL to cite.
  url: HttpUrlSchema.optional(),
  reason: FetchSkipReasonSchema,
  detail: z.string().optional(),
  httpStatus: z.number().int().optional(),
});
export type FetchSkip = z.infer<typeof FetchSkipSchema>;

// One anchor captured from a fetched page's RAW html. The cleaners strip
// hrefs, so link capture happens in the fetcher before cleaning — increment
// 6's tier-2/3 discovery mines these "real anchors" (decision 20).
export const PageLinkSchema = z.object({
  url: HttpUrlSchema,
  /** Anchor text, whitespace-collapsed and clipped at capture time. */
  text: z.string(),
});
export type PageLink = z.infer<typeof PageLinkSchema>;

export const CleanPageSchema = z.object({
  kind: z.literal("page"),
  url: HttpUrlSchema,
  finalUrl: HttpUrlSchema,
  title: z.string(),
  text: z.string(),
  fetchedAt: z.iso.datetime(),
  // Optional: absent means "not captured" (pre-increment-6 shapes, thin test
  // fixtures). CleanPage never rides the wire, so links stay server-side.
  links: z.array(PageLinkSchema).optional(),
});
export type CleanPage = z.infer<typeof CleanPageSchema>;

/** Page <title> is attacker-controlled and unbounded — every SourceRef built
 *  from a fetched page clips it at construction. */
export const MAX_SOURCE_LABEL_CHARS = 200;

/** The ONE CleanPage → SourceRef factory (the pastedListingRef precedent):
 *  the enricher's tier dispatch and increment 8's contact surfacing must
 *  build byte-identical refs for the same page. */
export function pageSourceRef(page: CleanPage): SourceRef {
  return { url: page.finalUrl, label: pageLabel(page), fetchedAt: page.fetchedAt };
}

function pageLabel(page: CleanPage): string {
  const title = page.title.trim();
  if (title) return title.slice(0, MAX_SOURCE_LABEL_CHARS);
  try {
    const url = new URL(page.finalUrl);
    return `${url.host}${url.pathname.replace(/\/$/, "")}`.slice(0, MAX_SOURCE_LABEL_CHARS);
  } catch {
    return page.finalUrl.slice(0, MAX_SOURCE_LABEL_CHARS);
  }
}
