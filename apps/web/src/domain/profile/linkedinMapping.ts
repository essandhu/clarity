import type { ImportedEntries, ImportReport } from "@/shared/schema";
import {
  LINKEDIN_PII_COLUMNS,
  type LinkedinFileKind,
  type LinkedinRow,
  type LinkedinRows,
} from "./linkedinCsv";
import {
  educationEntries,
  positionEntries,
  projectEntries,
  skillGroups,
  type LinkedinMapContext,
  type LinkedinMappingDeps,
} from "./linkedinEntries";

// LinkedIn export mapping (PLAN-RESUME.md §4.7) — pure: parsed CSV rows ->
// profile entries. The vocabulary (whitelist, signatures, PII columns, date
// formats) lives in linkedinCsv.ts and the row->entry builders in
// linkedinEntries.ts (200-line pre-splits); this module owns the fold and
// the PII boundary.

export {
  LINKEDIN_HEADER_SIGNATURES,
  LINKEDIN_PII_COLUMNS,
  linkedinFileKind,
  parseLinkedinDate,
  type LinkedinFileKind,
  type LinkedinRow,
  type LinkedinRows,
} from "./linkedinCsv";
export type { LinkedinMappingDeps } from "./linkedinEntries";

export interface LinkedinMapResult {
  entries: ImportedEntries;
  droppedStrings: ImportReport["droppedStrings"];
  notes: string[];
}

export function mapLinkedinRows(rows: LinkedinRows, deps: LinkedinMappingDeps): LinkedinMapResult {
  const ctx: LinkedinMapContext = { deps, dropped: [], notes: [] };
  const sanitized = sanitizeRows(rows);

  const positions = positionEntries(ctx, sanitized.positions ?? [], false);
  const volunteering = positionEntries(ctx, sanitized.volunteering ?? [], true);
  return {
    entries: {
      experience: [...positions, ...volunteering],
      projects: projectEntries(ctx, sanitized.projects ?? []),
      education: educationEntries(ctx, sanitized.education ?? []),
      skills: skillGroups(ctx, sanitized),
    },
    droppedStrings: ctx.dropped,
    notes: ctx.notes,
  };
}

/** The PII boundary (decision 46): every row of every file loses the pinned
 *  columns before mapping — Profile.csv contributes nothing to entries
 *  anyway, but the deletion is uniform so a future mapper cannot
 *  reintroduce them. Exported for its direct unit pin (review C6: no
 *  current mapper reads a PII column, so end-to-end output scans alone
 *  cannot detect this boundary's deletion — the defense-in-depth needs its
 *  own test). */
export function sanitizeRows(rows: LinkedinRows): LinkedinRows {
  const out: LinkedinRows = {};
  for (const [kind, kindRows] of Object.entries(rows) as [LinkedinFileKind, LinkedinRow[]][]) {
    out[kind] = kindRows.map((row) => {
      const clean: LinkedinRow = { ...row };
      for (const column of LINKEDIN_PII_COLUMNS) delete clean[column];
      return clean;
    });
  }
  return out;
}
