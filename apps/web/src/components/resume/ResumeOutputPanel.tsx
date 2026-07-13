"use client";

import { useMemo, useState } from "react";
import type { MasterProfile, TailorCoverage, TailoredResume } from "@/shared/schema";
import { DownloadsTab, type TectonicHealth } from "./DownloadsTab";
import { PdfPreview } from "./PdfPreview";
import { applyResumeToggles, emptyToggles, toggleId, type ResumeToggles } from "./resumeToggles";
import { TailorDiffView } from "./TailorDiffView";
import { usePdfCompile } from "./usePdfCompile";

// The tailored-output surface (PLAN-RESUME.md §6). Increment 13 shipped the
// [What changed] tab + toggle state; 14 added [Downloads] (.tex); 15 adds the
// [Preview] tab + PDF compile. The PARENT keys this component by the reducer-
// minted tailorRunId, so a re-run against the same role resets toggles.
// Toggling re-runs the pure fold with zero network; the counts line, every
// download, AND the compile all use exactly the TOGGLED resume — what ships is
// what is shown. The compile hook is shared so a compile started from Downloads
// renders in Preview and resets when a toggle edits the resume.

type OutputTab = "preview" | "changed" | "downloads";

export function ResumeOutputPanel(props: {
  resume: TailoredResume;
  coverage: TailorCoverage;
  master: MasterProfile;
  tectonic: TectonicHealth | undefined;
}) {
  const [toggles, setToggles] = useState<ResumeToggles>(emptyToggles);
  const [tab, setTab] = useState<OutputTab>("changed");
  const toggled = useMemo(
    () => applyResumeToggles(props.resume, props.coverage, props.master, toggles),
    [props.resume, props.coverage, props.master, toggles],
  );
  const compile = usePdfCompile(toggled.resume);
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

  const tabButton = (key: OutputTab, label: string) => (
    <button
      type="button"
      aria-pressed={tab === key}
      className={tab === key ? "mode-tab active" : "mode-tab"}
      onClick={() => setTab(key)}
    >
      {label}
    </button>
  );

  return (
    <section className="card resume-output-panel" aria-label="Tailored resume output">
      <h2 className="section-heading">Tailored resume</h2>
      <p className="profile-status" data-testid="toggled-counts">
        Now: {toggled.coverage.entriesSelected} entries · {toggled.coverage.bulletsSelected}{" "}
        bullets · {toggled.coverage.bulletsRephrased} rephrased ·{" "}
        {toggled.coverage.bulletsReverted} reverted
      </p>

      {/* Plain toggle buttons: tab ARIA would advertise a keyboard contract
          these don't implement (the ListingInputForm precedent). */}
      <div className="mode-toggle" aria-label="Output view">
        {tabButton("preview", "Preview")}
        {tabButton("changed", "What changed")}
        {tabButton("downloads", "Downloads")}
      </div>

      {tab === "preview" ? (
        <PdfPreview pdf={compile} />
      ) : tab === "changed" ? (
        <TailorDiffView
          master={props.master}
          toggled={toggled}
          onToggleEntry={onToggleEntry}
          onToggleBullet={onToggleBullet}
        />
      ) : (
        <DownloadsTab resume={toggled.resume} tectonic={props.tectonic} pdf={compile} />
      )}
    </section>
  );
}
