// Inferred email patterns (spec §6.3, PLAN.md §4 Stage 4 candidate 4): given a
// real person name and the company domain, guess the common formats. Every
// guess is confidence 'guess' — never presented as fact, never SMTP-probed
// (§7). Pure: no I/O, no model.

export interface EmailGuess {
  pattern: "first.last" | "first" | "flast";
  value: string;
}

// One label + dot + TLD at minimum; the caller passes profile.domain, which
// domainDeriver already denylisted (job boards, freemail) — this only rejects
// shapes that could not be an email host at all.
const DOMAIN_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const LETTERS = /^[a-z]+$/;

/** Lowercased, diacritic-stripped alphabetic tokens of a person name.
 *  "José Núñez-Smith" → ["jose", "nunez", "smith"]. */
function nameTokens(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((token) => token.length > 0);
}

/**
 * Ordered guesses, most common pattern first. Empty when the inputs cannot
 * make one honestly: no alphabetic name tokens, a string that is already an
 * email (an address is not a person name), or a domain that is not shaped
 * like a mail host.
 */
export function inferEmailPatterns(name: string, domain: string): EmailGuess[] {
  if (name.includes("@")) return [];
  const host = domain.trim().toLowerCase();
  if (!DOMAIN_SHAPE.test(host)) return [];
  const tokens = nameTokens(name);
  const first = tokens[0];
  if (!first || !LETTERS.test(first)) return [];
  if (tokens.length === 1) return [{ pattern: "first", value: `${first}@${host}` }];
  const last = tokens[tokens.length - 1];
  return [
    { pattern: "first.last", value: `${first}.${last}@${host}` },
    { pattern: "first", value: `${first}@${host}` },
    { pattern: "flast", value: `${first[0]}${last}@${host}` },
  ];
}

const EMAIL_SHAPE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/** First email-shaped substring, if any — shared by the listing-contact and
 *  GitHub-org candidate builders. */
export function firstEmail(text: string): string | undefined {
  return text.match(EMAIL_SHAPE)?.[0];
}

/**
 * The one email a text publishes, or undefined when it publishes none or
 * several (several = ambiguous; picking one would be a guess, and this
 * feeds a 'public'-confidence candidate). Case-insensitive dedupe.
 */
export function soleEmail(text: string): string | undefined {
  const matches = text.match(EMAIL_SHAPE) ?? [];
  const distinct = new Set(matches.map((match) => match.toLowerCase()));
  return distinct.size === 1 ? matches[0] : undefined;
}
