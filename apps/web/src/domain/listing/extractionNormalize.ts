import { RAW_TEXT_MAX } from "@/shared/schema";

// Post-extraction normalization for Stage 1. Structural cleanup the prompt
// alone cannot guarantee on small schema-constrained models (all
// live-verified on qwen3:4b, 2026-07-04/05):
//  - optional fields come back as "" instead of being omitted, but absence
//    must mean "not stated in the listing" (confidence rules and contact
//    surfacing depend on it);
//  - required fields can arrive whitespace-padded (or whitespace-only, which
//    the final profile parse then fails as an honest EXTRACTION_FAILED);
//  - technology lists come back with repeats (small models loop), and
//    trimming can itself manufacture duplicates ("Go", "Go ") — the schema
//    allows them, so they are dropped here once for every consumer (React
//    keys, briefing prompts, chips).

/** The extraction fields normalization touches — structural on purpose, so
 *  this file needs no import from ListingExtractor (no cycle). */
export interface ExtractedFields {
  company: string;
  role: string;
  domain?: string;
  seniority?: string;
  productArea?: string;
  teamSignals?: string;
  applicationContact?: string;
  namedTechnologies: string[];
}

export function normalizeExtraction<T extends ExtractedFields>(extracted: T): T {
  return {
    ...extracted,
    company: extracted.company.trim(),
    role: extracted.role.trim(),
    domain: blankToUndefined(extracted.domain),
    seniority: blankToUndefined(extracted.seniority),
    productArea: blankToUndefined(extracted.productArea),
    teamSignals: blankToUndefined(extracted.teamSignals),
    applicationContact: blankToUndefined(extracted.applicationContact),
    namedTechnologies: [
      ...new Set(extracted.namedTechnologies.map((tech) => tech.trim()).filter((tech) => tech !== "")),
    ],
  };
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Cap listing text to the ListingProfile.rawText schema bound (the SAME text
 * is what the model extracts from — 20k chars ≈ 5k tokens keeps 8k-window
 * local models viable, risk 14). A cut mid-astral-character would leave a
 * trailing lone high surrogate; strip it rather than ship malformed text.
 */
export function capRawText(text: string): string {
  return text.slice(0, RAW_TEXT_MAX).replace(/[\uD800-\uDBFF]$/, "");
}
