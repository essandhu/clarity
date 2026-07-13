"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { resumeFilenameSlug } from "@/domain/resume/resumeLatex";
import type { MasterProfile, TailorCoverage, TailoredResume } from "@/shared/schema";
import { applyResumeToggles, emptyToggles, toggleId, type ResumeToggles } from "./resumeToggles";
import { TailorDiffView } from "./TailorDiffView";

// The tailored-output surface (PLAN-RESUME.md §6). Increment 13 shipped the
// [What changed] tab + toggle state; 14 adds the [Downloads] tab (.tex only —
// the PDF preview lands in 15). The PARENT keys this component by the reducer-
// minted tailorRunId, so a re-run against the same role resets toggles.
// Toggling re-runs the pure fold with zero network; the counts line and every
// download use exactly the TOGGLED resume, so what ships is what is shown.

type OutputTab = "changed" | "downloads";

export function ResumeOutputPanel(props: {
  resume: TailoredResume;
  coverage: TailorCoverage;
  master: MasterProfile;
}) {
  const [toggles, setToggles] = useState<ResumeToggles>(emptyToggles);
  const [tab, setTab] = useState<OutputTab>("changed");
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
      <h2 className="section-heading">Tailored resume</h2>
      <p className="profile-status" data-testid="toggled-counts">
        Now: {toggled.coverage.entriesSelected} entries · {toggled.coverage.bulletsSelected}{" "}
        bullets · {toggled.coverage.bulletsRephrased} rephrased ·{" "}
        {toggled.coverage.bulletsReverted} reverted
      </p>

      {/* Plain toggle buttons: tab ARIA would advertise a keyboard contract
          these don't implement (the ListingInputForm precedent). */}
      <div className="mode-toggle" aria-label="Output view">
        <button
          type="button"
          aria-pressed={tab === "changed"}
          className={tab === "changed" ? "mode-tab active" : "mode-tab"}
          onClick={() => setTab("changed")}
        >
          What changed
        </button>
        <button
          type="button"
          aria-pressed={tab === "downloads"}
          className={tab === "downloads" ? "mode-tab active" : "mode-tab"}
          onClick={() => setTab("downloads")}
        >
          Downloads
        </button>
      </div>

      {tab === "changed" ? (
        <TailorDiffView
          master={props.master}
          toggled={toggled}
          onToggleEntry={onToggleEntry}
          onToggleBullet={onToggleBullet}
        />
      ) : (
        <DownloadsTab resume={toggled.resume} />
      )}
    </section>
  );
}

/** The .tex download (decision 41 — uses the TOGGLED resume via the render
 *  route; nothing is compiled client-side). The PDF compile + preview arrive
 *  with Tectonic in increment 15. */
function DownloadsTab(props: { resume: TailoredResume }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort an in-flight render on unmount (the useDraftRun precedent).
  useEffect(() => () => abortRef.current?.abort(), []);

  async function downloadTex() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/resume/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resume: props.resume, format: "tex" }),
        signal: controller.signal,
      });
      if (!res.ok) {
        setError(`Couldn't render the .tex (HTTP ${res.status}).`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `resume-${resumeFilenameSlug(props.resume.roleLabel)}.tex`;
      document.body.appendChild(anchor);
      anchor.click();
      // Defer cleanup: revoking the object URL synchronously on the same tick
      // as click() can cancel the download in WebKit (which reads the URL
      // asynchronously). A stale revoke/remove later is harmless.
      setTimeout(() => {
        anchor.remove();
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") setError("Couldn't reach the render endpoint.");
    } finally {
      if (abortRef.current === controller) setBusy(false);
    }
  }

  return (
    <div className="resume-downloads">
      <p className="contact-blurb">
        The .tex is regenerated on the server from exactly the entries and bullets shown above —
        your edits are included. Compile it with Tectonic locally (PDF compile + preview arrive
        in the next increment). It contains only your own resume content; nothing is sent
        anywhere else.
      </p>
      <div className="draft-actions">
        <button type="button" className="primary-button" onClick={downloadTex} disabled={busy}>
          {busy ? "Rendering…" : "Download .tex"}
        </button>
      </div>
      {error && (
        <p className="error-hint" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
