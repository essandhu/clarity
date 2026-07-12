import type { ImportExtraction, ImportReport } from "@/shared/schema";

// The pasted-resume verbatim gate (PLAN-RESUME.md §4.5, decision 43). The
// model was told to copy; this gate makes copying MECHANICAL: every string
// the extraction carries must appear (whitespace/case-normalized) as a
// substring of the text the model actually saw, or it is dropped with a
// per-string report entry. The walk is SCHEMA-DRIVEN — it visits every
// string and string-array field of every entry generically — so a field
// added to ImportExtractionSchema later is gated automatically, never
// forgotten (the review-round rule: an enumerated field list is how a
// garbled date reaches the review UI unmarked).

type Dropped = ImportReport["droppedStrings"][number];

export interface GroundedImport {
  extraction: ImportExtraction;
  droppedStrings: Dropped[];
  /** ORIGINAL extraction index of each kept entry, per section — so every
   *  report path (not-verbatim AND the mapper's over-cap) shares ONE index
   *  base: the extraction the model actually emitted (review F8). */
  keptIndices: Record<"experience" | "projects" | "education" | "skills", number[]>;
}

/** Entry-fatal keys: an entry cannot render headed by an unverified
 *  employer/title/school/project name — the whole entry drops (§4.5). */
const FATAL_KEYS: ReadonlySet<string> = new Set(["org", "role", "name", "school"]);

/** Date keys get the date-aware rule (digit runs + alpha tokens), and a
 *  failing date drops to ABSENT rather than killing the entry. */
const DATE_KEYS: ReadonlySet<string> = new Set(["startDate", "endDate"]);

/** A model-invented skills heading is replaced by this mechanical constant —
 *  our label, not model text (the canned-copy precedent), and the invention
 *  is still reported. */
export const IMPORT_FALLBACK_CATEGORY = "Skills";

export function groundImportExtraction(
  extraction: ImportExtraction,
  sourceText: string,
): GroundedImport {
  const haystack = normalizeForMatch(sourceText);
  const droppedStrings: Dropped[] = [];
  const report = (path: string, text: string) => {
    droppedStrings.push({ path, text: text.slice(0, 120), reason: "not-verbatim" });
  };
  const grounds = (value: string) => haystack.includes(normalizeForMatch(value));

  const gateEntry = <T extends Record<string, unknown>>(entry: T, basePath: string): T | null => {
    const out: Record<string, unknown> = {};
    // A fatal-key failure drops the ENTRY, but the walk still visits every
    // remaining string first: the §3 report contract names EVERY string that
    // failed the gate, and a fabricated bullet inside a fabricated-org entry
    // is two fabrications, not one (review F3).
    let fatalFailed = false;
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed === "") {
          // Blank optionals are a schema-constrained-decoding artifact
          // (qwen3 fills "" — the extractionNormalize precedent): absent,
          // silently. A blank FATAL key still fails the entry.
          if (FATAL_KEYS.has(key)) {
            report(`${basePath}.${key}`, trimmed);
            fatalFailed = true;
          }
          continue;
        }
        const ok = DATE_KEYS.has(key) ? dateTokensAppear(trimmed, haystack) : grounds(trimmed);
        if (ok) {
          out[key] = trimmed;
        } else {
          report(`${basePath}.${key}`, trimmed);
          if (FATAL_KEYS.has(key)) fatalFailed = true;
          // optional string / date → absent
        }
      } else if (isStringArray(value)) {
        const kept: string[] = [];
        value.forEach((item, i) => {
          const trimmed = item.trim();
          if (trimmed === "") return;
          if (grounds(trimmed)) kept.push(trimmed);
          else report(`${basePath}.${key}[${i}]`, trimmed);
        });
        out[key] = kept;
      } else if (value !== undefined) {
        out[key] = value; // non-string leaves (none today) pass through
      }
    }
    return fatalFailed ? null : (out as T);
  };

  const gateSection = <T extends Record<string, unknown>>(
    section: "experience" | "projects" | "education",
    entries: T[],
  ): { kept: T[]; indices: number[] } => {
    const kept: T[] = [];
    const indices: number[] = [];
    entries.forEach((entry, i) => {
      const gated = gateEntry(entry, `${section}[${i}]`);
      if (gated !== null) {
        kept.push(gated);
        indices.push(i);
      }
    });
    return { kept, indices };
  };

  const experience = gateSection("experience", extraction.experience);
  const projects = gateSection("projects", extraction.projects);
  const education = gateSection("education", extraction.education);

  // Skills: items ride the generic gate; the CATEGORY heading gets fallback
  // semantics — a group whose items survived must not vanish because the
  // model invented a prettier heading.
  const skills: { kept: { category: string; items: string[] }[]; indices: number[] } = {
    kept: [],
    indices: [],
  };
  extraction.skills.forEach((group, i) => {
    const gated = gateEntry({ items: group.items }, `skills[${i}]`);
    const items = gated?.items ?? [];
    if (items.length === 0) return;
    let category = group.category.trim();
    if (category === "" || !grounds(category)) {
      if (category !== "") report(`skills[${i}].category`, category);
      category = IMPORT_FALLBACK_CATEGORY;
    }
    skills.kept.push({ category, items });
    skills.indices.push(i);
  });

  return {
    extraction: {
      experience: experience.kept,
      projects: projects.kept,
      education: education.kept,
      skills: skills.kept,
    },
    droppedStrings,
    keptIndices: {
      experience: experience.indices,
      projects: projects.indices,
      education: education.indices,
      skills: skills.indices,
    },
  };
}

/** Whitespace-collapsed, case-folded, NFC-normalized — the §4.5 match rule.
 *  Collapsing whitespace lets a bullet the paste wraps across lines ground
 *  against its single-line extraction. */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** ≥3-char prefix of a full month name → that month's index, else -1
 *  ("jan"/"january"/"sept" all resolve; "j"/"decreased" do not). */
function monthIndexOf(token: string): number {
  if (token.length < 3) return -1;
  return MONTHS.findIndex((month) => month.startsWith(token));
}

/** The date-aware rule (decision 43): every digit run AND every alphabetic
 *  token of an extracted date must appear in the pasted text as a WHOLE
 *  token — "Jan 2002" extracted from a paste that only says "Jan 2020"
 *  fails on "2002" (the recorded qwen3 garble class), and "Dec"/"2002" must
 *  not ground on fragments of "decreased"/"20024" (review F2). Month tokens
 *  additionally match across abbreviation ("Jan" ⇄ "January" both resolve
 *  to month 0). Digit runs use \p{Nd}, so a non-ASCII garble ("２０２８")
 *  is a real token that fails membership rather than being invisible; a
 *  symbols-only date falls back to the plain substring rule — never a
 *  vacuous pass. Over-dropping a date to ABSENT is the safe direction. */
export function dateTokensAppear(date: string, normalizedHaystack: string): boolean {
  const digitRuns = date.match(/[\p{Nd}]+/gu) ?? [];
  const alphaTokens = date.match(/[\p{L}]+/gu) ?? [];
  if (digitRuns.length === 0 && alphaTokens.length === 0) {
    return normalizedHaystack.includes(normalizeForMatch(date));
  }
  const haystackTokens = new Set(normalizedHaystack.split(/[^a-z0-9]+/).filter(Boolean));
  const monthAppears = (token: string): boolean => {
    const target = monthIndexOf(token);
    if (target < 0) return false;
    for (const candidate of haystackTokens) {
      if (monthIndexOf(candidate) === target) return true;
    }
    return false;
  };
  return (
    digitRuns.every((run) => haystackTokens.has(run)) &&
    alphaTokens.every((token) => {
      const normalized = normalizeForMatch(token);
      return haystackTokens.has(normalized) || monthAppears(normalized);
    })
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
