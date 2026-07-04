import { z } from "zod";
import { ContactCandidateSchema } from "./contact";
import { HookSchema } from "./hook";
import { ListingProfileSchema } from "./listingProfile";

export const DraftNoteSchema = z.object({
  subject: z.string().optional(),
  body: z.string().min(1),
  // Validated verbatim subset of the hook texts the user was shown.
  groundedHooks: z.array(z.string()),
});
export type DraftNote = z.infer<typeof DraftNoteSchema>;

// POST /api/draft request shape. The response is the draft.* SSE stream.
export const DraftRequestSchema = z.object({
  profile: ListingProfileSchema,
  hooks: z.array(HookSchema),
  contact: ContactCandidateSchema.optional(),
});
export type DraftRequest = z.infer<typeof DraftRequestSchema>;
