"use client";

import type { TailorCoverage, TailoredResume } from "@/shared/schema";

// The honesty surface for a tailor run (PLAN-RESUME.md §6, decisions 39(e) +
// 57): mode banner, counts, every reverted bullet with the exact blocked
// tokens, dropped skills NAMED, the role↔profile keyword gap, and the
// prompt-cap truncation note. Renders the RUN's canonical coverage; the
// output panel re-derives counts as toggles change.

const DROP_COPY: Record<string, (count: number, samples: string[]) => string> = {
  "skill|not_subset": (count, samples) =>
    `Not added (not in your profile): ${samples.join(", ")}${count > samples.length ? ` and ${count - samples.length} more` : ""}.`,
  "skill|over_cap": (count) => `${count} skill item${count === 1 ? "" : "s"} beyond the 30-item group cap left off.`,
  "entry|unknown_id": (count) => `${count} selection${count === 1 ? "" : "s"} referenced no known entry — ignored.`,
  "bullet|unknown_id": (count) => `${count} bullet selection${count === 1 ? "" : "s"} referenced no known bullet — ignored.`,
  "entry|over_cap": (count, samples) =>
    `${count} ${count === 1 ? "entry" : "entries"} beyond the 10-entry resume cap left off${samples.length > 0 ? ` (${samples.join(", ")})` : ""}.`,
};

export function CoveragePanel(props: { coverage: TailorCoverage; resume: TailoredResume }) {
  const { coverage, resume } = props;
  const reverted = resume.entries.flatMap((entry) =>
    entry.bullets
      .filter((bullet) => bullet.disposition === "reverted")
      .map((bullet) => ({ entry: entry.heading, bullet })),
  );

  return (
    <section className="card coverage-panel" aria-label="Tailoring coverage">
      <h2 className="section-heading">Coverage</h2>

      {coverage.mode === "fallback-untailored" && (
        <div className="coverage-notice" role="status">
          Untailored — model selection failed; your most recent entries were used verbatim
          instead.
        </div>
      )}

      <p className="profile-status">
        Selected {coverage.entriesSelected} of {coverage.entriesOffered} entries offered ·{" "}
        {coverage.bulletsSelected} bullets · {coverage.bulletsRephrased} rephrased ·{" "}
        {coverage.bulletsReverted} reverted
      </p>

      {coverage.entriesOffered < coverage.entriesTotal && (
        <p className="coverage-notice">
          Only the first {coverage.entriesOffered} of {coverage.entriesTotal} profile entries fit
          the local model&apos;s prompt window — most-recent-first. Reorder your profile to
          change what is offered.
        </p>
      )}

      {reverted.length > 0 && (
        <ul className="coverage-reverted" aria-label="Reverted rephrases">
          {reverted.map(({ entry, bullet }) => (
            <li key={bullet.bulletId}>
              <span className="reverted-entry">{entry}:</span> kept your wording — would have
              added: {(bullet.offendingTokens ?? []).join(", ") || "(unverifiable wording)"}
            </li>
          ))}
        </ul>
      )}

      {coverage.dropped.length > 0 && (
        <ul className="coverage-drops" aria-label="Dropped selections">
          {coverage.dropped.map((record) => (
            <li key={`${record.kind}-${record.reason}`}>
              {(DROP_COPY[`${record.kind}|${record.reason}`] ??
                ((count: number) => `${count} ${record.kind} selection(s) dropped (${record.reason}).`))(
                record.count,
                record.samples,
              )}
            </li>
          ))}
        </ul>
      )}

      {coverage.keywords.missing.length > 0 && (
        <p className="coverage-keywords">
          In the role, not in your profile: {coverage.keywords.missing.join(", ")} — not added.
        </p>
      )}
      {coverage.keywords.matched.length > 0 && (
        <p className="coverage-keywords muted">
          Covered: {coverage.keywords.matched.join(", ")}
        </p>
      )}
    </section>
  );
}
