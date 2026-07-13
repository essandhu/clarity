"use client";

import type { ImportedEntries, ImportReport } from "@/shared/schema";

// Shared honesty surfaces for the three import affordances (paste / GitHub /
// LinkedIn): the per-string drop report partitioned by reason (review F9 —
// over-cap entries DID verify), and the report.notes list (quota skips,
// files read vs ignored, raw-date keeps — §3).

export function countEntries(entries: ImportedEntries): number {
  return (
    entries.experience.length +
    entries.projects.length +
    entries.education.length +
    entries.skills.length
  );
}

/** The per-string honesty surface, partitioned by reason: over-cap entries
 *  DID verify verbatim — lumping them under the verbatim-failure header
 *  would accuse the gate of a drop it never made (review F9). */
export function DropReport({ droppedStrings }: { droppedStrings: ImportReport["droppedStrings"] }) {
  const notVerbatim = droppedStrings.filter((drop) => drop.reason === "not-verbatim");
  const overCap = droppedStrings.filter((drop) => drop.reason === "over-cap");
  if (droppedStrings.length === 0) return null;
  return (
    <div className="import-drops">
      {notVerbatim.length > 0 && (
        <>
          <p className="coverage-notice">
            {notVerbatim.length} {notVerbatim.length === 1 ? "string" : "strings"} couldn&apos;t be
            verified verbatim against your paste and {notVerbatim.length === 1 ? "was" : "were"}{" "}
            dropped:
          </p>
          <ul className="import-drop-list">
            {notVerbatim.map((drop, i) => (
              <li key={i}>
                <code>{drop.path}</code> — “{drop.text}”
              </li>
            ))}
          </ul>
        </>
      )}
      {overCap.length > 0 && (
        <>
          <p className="coverage-notice">
            {overCap.length} {overCap.length === 1 ? "value" : "values"} didn&apos;t fit the
            profile caps and {overCap.length === 1 ? "was" : "were"} not imported:
          </p>
          <ul className="import-drop-list">
            {overCap.map((drop, i) => (
              <li key={i}>
                <code>{drop.path}</code> — “{drop.text}”
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** report.notes, rendered verbatim — the whitelist/quota/raw-date honesty
 *  channel (§3). */
export function ImportNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="import-drop-list import-notes">
      {notes.map((note, i) => (
        <li key={i}>{note}</li>
      ))}
    </ul>
  );
}
