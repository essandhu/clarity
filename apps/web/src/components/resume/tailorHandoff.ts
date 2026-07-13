import { z } from "zod";
import { ListingProfileSchema, type ListingProfile } from "@/shared/schema";

// Post-run handoff (decision 54): read-once sessionStorage, zod-parsed,
// corrupt ⇒ ignored — the paste path is always available. The draftHandoff
// precedent: pure module, no React.

const KEY = "clarity:tailor-handoff";

const HandoffSchema = z.object({ profile: ListingProfileSchema });

export function storeTailorHandoff(profile: ListingProfile): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ profile }));
  } catch {
    // Storage denied/full — the /resume paste path still works.
  }
}

/** Read-once: the key is removed BEFORE parsing, so corrupt payloads are
 *  consumed too, never re-offered on the next visit. */
export function consumeTailorHandoff(): ListingProfile | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(KEY);
    const parsed = HandoffSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.profile : null;
  } catch {
    return null;
  }
}
