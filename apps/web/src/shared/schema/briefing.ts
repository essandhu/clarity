import { z } from "zod";
import { SourceRefSchema } from "./sourceRef";

// Confidence is never decorative and never self-reported by the model: it is
// computed deterministically from coverage by domain code (confidenceRules).
export const ConfidenceSchema = z.enum(["high", "low", "none"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const SECTION_PLAN = [
  "what-they-do",
  "product-area",
  "stack",
  "team-signals",
  "seniority-fit",
  "recent-launches",
] as const;
export type SectionId = (typeof SECTION_PLAN)[number];

export const BriefingSectionSchema = z.object({
  id: z.enum(SECTION_PLAN),
  title: z.string().min(1),
  content: z.string().min(1),
  confidence: ConfidenceSchema,
  // Empty iff confidence === 'none'; 'low' sections always cite at least the
  // listing ref (real or pasted).
  sources: z.array(SourceRefSchema),
});
export type BriefingSection = z.infer<typeof BriefingSectionSchema>;

export const BriefingSchema = z.object({
  sections: z.array(BriefingSectionSchema),
});
export type Briefing = z.infer<typeof BriefingSchema>;
