import { z } from "zod";
import { ConfidenceSchema } from "./briefing";
import { SourceRefSchema } from "./sourceRef";

export const HookSchema = z.object({
  text: z.string().min(1),
  basis: z.string().min(1),
  confidence: ConfidenceSchema.exclude(["none"]),
  // An uncited hook cannot exist. Listing-grounded hooks cite the listing ref
  // ('listing:pasted' on the paste path).
  sources: z.array(SourceRefSchema).min(1),
});
export type Hook = z.infer<typeof HookSchema>;
