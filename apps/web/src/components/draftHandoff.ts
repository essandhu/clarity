import type { ContactCandidate, DraftNote } from "@/shared/schema";

// The mail-client hand-off rules (spec §7: the app drafts, the USER sends).
// Pure and exported so decision 28 — a guessed email enters a mailto: target
// only after an explicit "use this guess" click — is unit-testable.

const EMAIL_VALUE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Does this candidate carry an email address usable as a mailto target?
 *  (A LinkedIn search URL or a bare name does not.) */
export function hasEmailValue(contact: ContactCandidate | null | undefined): boolean {
  return !!contact?.value && EMAIL_VALUE.test(contact.value);
}

/**
 * The address allowed into the mailto target. A 'guess' address requires the
 * explicit accept click (decision 28) — until then the note opens with no
 * recipient rather than presenting a guess as fact.
 */
export function mailtoEmail(
  contact: ContactCandidate | null | undefined,
  guessAccepted: boolean,
): string | undefined {
  if (!contact || !hasEmailValue(contact)) return undefined;
  if (contact.confidence === "guess" && !guessAccepted) return undefined;
  return contact.value;
}

/** RFC 6068 mailto link: subject/body percent-encoded (encodeURIComponent
 *  encodes newlines as %0A, which mail clients decode back into line breaks).
 *  The recipient's '@' must stay LITERAL — %40 in the addr-spec is invalid
 *  per RFC 6068 §2 and some clients refuse it (review finding); the rest of
 *  the address is still encoded (EMAIL_VALUE already excludes ?, &, spaces). */
export function mailtoHref(note: DraftNote, email?: string): string {
  const params = [
    note.subject ? `subject=${encodeURIComponent(note.subject)}` : undefined,
    `body=${encodeURIComponent(note.body)}`,
  ]
    .filter((param): param is string => param !== undefined)
    .join("&");
  const to = email ? encodeURIComponent(email).replace(/%40/g, "@") : "";
  return `mailto:${to}?${params}`;
}
