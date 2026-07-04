import { z } from "zod";

export const PASTED_LISTING_URL = "listing:pasted" as const;

// Every "real" URL in the system is a fetchable web page. WHATWG URL parsing
// (which z.url() follows) would otherwise admit any scheme — including
// javascript: — into citation links.
export const HttpUrlSchema = z.url({ protocol: /^https?$/ });

export const SourceRefSchema = z.object({
  // Either a real fetched URL or the canonical synthetic id for pasted listing
  // text (PLAN.md decision 33) — the only non-URL value that may ever appear
  // here. The UI renders it as a non-link chip.
  url: z.union([HttpUrlSchema, z.literal(PASTED_LISTING_URL)]),
  label: z.string().min(1),
  // For pasted text this is the submission timestamp.
  fetchedAt: z.iso.datetime(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const pastedListingRef = (submittedAt: string): SourceRef => ({
  url: PASTED_LISTING_URL,
  label: "Pasted listing text",
  fetchedAt: submittedAt,
});
