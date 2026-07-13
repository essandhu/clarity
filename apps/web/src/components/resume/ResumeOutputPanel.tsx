"use client";

import { useMemo, useState } from "react";
import type { MasterProfile, TailorCoverage, TailoredResume } from "@/shared/schema";
import { applyResumeToggles, emptyToggles, toggleId, type ResumeToggles } from "./resumeToggles";
import { TailorDiffView } from "./TailorDiffView";

// The tailored-output surface (PLAN-RESUME.md §6), increment-13 scope: the
// [What changed] tab + toggle state only — the downloads tab lands in 14,
// the preview tab in 15. The PARENT keys this component by the reducer-
// minted tailorRunId, so a re-run against the same role resets toggles.
// Toggling re-runs the pure fold with zero network; the counts line below
// re-derives from the toggled resume so what is shown stays truthful.

export function ResumeOutputPanel(props: {
  resume: TailoredResume;
  coverage: TailorCoverage;
  master: MasterProfile;
}) {
  const [toggles, setToggles] = useState<ResumeToggles>(emptyToggles);
  const toggled = useMemo(
    () => applyResumeToggles(props.resume, props.coverage, props.master, toggles),
    [props.resume, props.coverage, props.master, toggles],
  );
  const canonicalEntryIds = useMemo(
    () => new Set(props.resume.entries.map((entry) => entry.entryId)),
    [props.resume],
  );
  const canonicalBulletIds = useMemo(
    () => new Set(props.resume.entries.flatMap((entry) => entry.bullets.map((b) => b.bulletId))),
    [props.resume],
  );

  const onToggleEntry = (id: string, present: boolean) =>
    setToggles((t) => toggleId(t, "entry", id, present, canonicalEntryIds.has(id)));

  const onToggleBullet = (id: string, present: boolean) =>
    setToggles((t) => toggleId(t, "bullet", id, present, canonicalBulletIds.has(id)));

  return (
    <section className="card resume-output-panel" aria-label="Tailored resume output">
      <h2 className="section-heading">Tailored resume — what changed</h2>
      <p className="profile-status" data-testid="toggled-counts">
        Now: {toggled.coverage.entriesSelected} entries · {toggled.coverage.bulletsSelected}{" "}
        bullets · {toggled.coverage.bulletsRephrased} rephrased ·{" "}
        {toggled.coverage.bulletsReverted} reverted
      </p>
      <p className="contact-blurb">
        Untick to leave something off; tick a skipped line to add it back verbatim. Downloads
        (.tex) arrive in the next increment and will use exactly this toggled selection.
      </p>
      <TailorDiffView
        master={props.master}
        toggled={toggled}
        onToggleEntry={onToggleEntry}
        onToggleBullet={onToggleBullet}
      />
    </section>
  );
}
