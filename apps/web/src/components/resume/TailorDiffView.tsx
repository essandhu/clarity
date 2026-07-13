"use client";

import type { MasterProfile, TailoredBullet } from "@/shared/schema";
import { entryMoves, type ToggledResume } from "./resumeToggles";
import { wordDiff } from "./wordDiff";

// The "what changed vs master" tab (decision 41): every master entry in
// master order with include/exclude toggles, moved-up/moved-down badges,
// word-level verbatim-vs-rephrased diffs, and reverted bullets naming their
// offendingTokens. Toggles are zero-model-call — the parent re-runs the pure
// fold on every change.

export function TailorDiffView(props: {
  master: MasterProfile;
  toggled: ToggledResume;
  onToggleEntry(id: string, present: boolean): void;
  onToggleBullet(id: string, present: boolean): void;
}) {
  const { master, toggled } = props;
  const moves = entryMoves(toggled.resume, master);
  const byId = new Map(toggled.resume.entries.map((entry) => [entry.entryId, entry]));

  const sections: {
    title: string;
    rows: { id: string; heading: string; bullets: { id: string; text: string }[] }[];
  }[] = [
    {
      title: "Experience",
      rows: master.experience.map((entry) => ({
        id: entry.id,
        heading: `${entry.role} — ${entry.org}`,
        bullets: entry.bullets.map((bullet) => ({ id: bullet.id, text: bullet.text })),
      })),
    },
    {
      title: "Projects",
      rows: master.projects.map((entry) => ({
        id: entry.id,
        heading: entry.name,
        bullets: entry.bullets.map((bullet) => ({ id: bullet.id, text: bullet.text })),
      })),
    },
  ];

  return (
    <div className="tailor-diff" aria-label="What changed vs your master profile">
      {sections.map((section) =>
        section.rows.length === 0 ? null : (
          <div key={section.title} className="diff-section">
            <h4 className="diff-heading">{section.title}</h4>
            {section.rows.map((row) => {
              const included = byId.get(row.id);
              return (
                <div key={row.id} className={`diff-entry ${included ? "" : "diff-excluded"}`}>
                  <label className="diff-toggle">
                    <input
                      type="checkbox"
                      checked={included !== undefined}
                      aria-label={`Include ${row.heading}`}
                      onChange={() => props.onToggleEntry(row.id, included !== undefined)}
                    />
                    <span className="diff-entry-heading">{row.heading}</span>
                  </label>
                  {moves[row.id] && (
                    <span className={`move-badge move-${moves[row.id]}`}>
                      moved {moves[row.id]}
                    </span>
                  )}
                  {!included && <span className="diff-note">not selected</span>}
                  {included && (
                    <ul className="diff-bullets">
                      {row.bullets.map((bullet) => {
                        const resolved = included.bullets.find(
                          (b) => b.bulletId === bullet.id,
                        );
                        return (
                          <li key={bullet.id} className={resolved ? "" : "diff-excluded"}>
                            <label className="diff-toggle">
                              <input
                                type="checkbox"
                                checked={resolved !== undefined}
                                aria-label={`Include bullet: ${bullet.text.slice(0, 60)}`}
                                onChange={() =>
                                  props.onToggleBullet(bullet.id, resolved !== undefined)
                                }
                              />
                              <BulletBody masterText={bullet.text} resolved={resolved} />
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        ),
      )}

      {(toggled.rejected.entryIds.length > 0 || toggled.rejected.bulletIds.length > 0) && (
        <p className="coverage-notice" role="status">
          {toggled.rejected.entryIds.length > 0 &&
            `Couldn't add ${toggled.rejected.entryIds.length} ${toggled.rejected.entryIds.length === 1 ? "entry" : "entries"} — the resume holds at most 10. `}
          {toggled.rejected.bulletIds.length > 0 &&
            `Couldn't add ${toggled.rejected.bulletIds.length} bullet${toggled.rejected.bulletIds.length === 1 ? "" : "s"} — an entry holds at most 6.`}
        </p>
      )}
    </div>
  );
}

function BulletBody({
  masterText,
  resolved,
}: {
  masterText: string;
  resolved: TailoredBullet | undefined;
}) {
  if (!resolved) return <span className="diff-bullet-text muted">{masterText}</span>;
  if (resolved.disposition === "rephrased") {
    return (
      <span className="diff-bullet-text">
        {wordDiff(masterText, resolved.text).map((span, i) =>
          span.kind === "same" ? (
            <span key={i}> {span.text}</span>
          ) : span.kind === "added" ? (
            <ins key={i}> {span.text}</ins>
          ) : (
            <del key={i}> {span.text}</del>
          ),
        )}
      </span>
    );
  }
  if (resolved.disposition === "reverted") {
    return (
      <span className="diff-bullet-text">
        {masterText}{" "}
        <span className="diff-note reverted-note">
          kept your wording — would have added:{" "}
          {(resolved.offendingTokens ?? []).join(", ") || "(unverifiable wording)"}
        </span>
      </span>
    );
  }
  return <span className="diff-bullet-text">{resolved.text}</span>;
}
