import { z } from "zod";
import { HttpUrlSchema } from "./sourceRef";

// Stage 1 output. Missing optionals stay absent — the extraction prompt forbids
// inventing fields, and this shape is what makes that checkable.

// Exported so the extractor slices to EXACTLY this bound: a diverging literal
// would turn a successful extract into a schema failure on long pages.
export const RAW_TEXT_MAX = 20_000;

export const ListingProfileSchema = z.object({
  company: z.string().min(1),
  domain: z.string().optional(),
  role: z.string().min(1),
  seniority: z.string().optional(),
  namedTechnologies: z.array(z.string()).default([]),
  productArea: z.string().optional(),
  teamSignals: z.string().optional(),
  applicationContact: z.string().optional(),
  listingUrl: HttpUrlSchema.optional(),
  rawText: z.string().max(RAW_TEXT_MAX),
});
export type ListingProfile = z.infer<typeof ListingProfileSchema>;
