"use client";

import { useEffect, useRef, useState } from "react";
import { resumeFilenameSlug } from "@/domain/resume/resumeLatex";
import type { TailoredResume } from "@/shared/schema";
import type { PdfCompile } from "./usePdfCompile";

// The [Downloads] tab (PLAN-RESUME.md §6, decisions 50/51). The .tex download
// always works (the honest floor without a compiler). The PDF compile is gated
// on health.tectonic.available: absent ⇒ per-OS install copy (Scoop / Homebrew
// / pacman-or-conda / GitHub — never winget/Chocolatey); present ⇒ a compile
// button, the CDN-egress disclosure whenever the compile would open network
// (unwarmed, or a re-warm), and — on a cache_missing_offline failure — the
// explicit re-download action that is the ONLY path re-opening the CDN.

export interface TectonicHealth {
  available: boolean;
  version?: string;
  warmed: boolean;
}

const DISCLOSURE =
  "This compile downloads ~290 LaTeX support files (~43 MB) from Tectonic's package CDN — " +
  "your resume content is not sent anywhere.";

export function DownloadsTab(props: {
  resume: TailoredResume;
  tectonic: TectonicHealth | undefined;
  pdf: PdfCompile;
}) {
  const { resume, tectonic, pdf } = props;
  const cacheMiss = pdf.status === "error" && pdf.error?.reason === "cache_missing_offline";
  // Warmed = the marker existed at mount OR a compile this session wrote it; a
  // cache miss re-opens the disclosure for the explicit re-download (decision 51).
  const warmed = Boolean(tectonic?.warmed) || pdf.warmed;
  const showDisclosure = Boolean(tectonic?.available) && (!warmed || cacheMiss);

  return (
    <div className="resume-downloads">
      <p className="contact-blurb">
        The .tex is regenerated on the server from exactly the entries and bullets shown above — your
        edits are included. It contains only your own resume content; nothing is sent anywhere else.
      </p>

      <TexDownload resume={resume} />

      <div className="pdf-compile">
        {tectonic === undefined ? (
          <p className="profile-status">Checking for Tectonic…</p>
        ) : tectonic.available ? (
          <>
            {showDisclosure && (
              <p className="disclosure-note" role="note">
                {DISCLOSURE}
              </p>
            )}
            <div className="draft-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => pdf.compile()}
                disabled={pdf.status === "compiling"}
              >
                {pdf.status === "compiling" ? "Compiling…" : "Compile PDF"}
              </button>
              {pdf.status === "ready" && pdf.pdfUrl && (
                <a className="secondary-button" href={pdf.pdfUrl} download={pdf.filename}>
                  Download .pdf
                </a>
              )}
            </div>
            {pdf.status === "error" && pdf.error && (
              <div className="compile-error" role="alert">
                <p className="error-hint">{pdf.error.message}</p>
                {pdf.error.diagnostics.length > 0 && (
                  <pre className="compile-diagnostics">{pdf.error.diagnostics.join("\n")}</pre>
                )}
                {cacheMiss && (
                  <button type="button" className="secondary-button" onClick={() => pdf.compile(true)}>
                    Re-download LaTeX packages (~43 MB)
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <TectonicMissing />
        )}
      </div>
    </div>
  );
}

/** The .tex download — self-contained (its own fetch + unmount abort); the PDF
 *  path is the shared usePdfCompile hook so the Preview tab reflects it. */
function TexDownload(props: { resume: TailoredResume }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
      // Defer cleanup: revoking synchronously on the click tick can cancel the
      // download in WebKit (which reads the URL asynchronously).
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
    <div className="draft-actions">
      <button type="button" className="primary-button" onClick={downloadTex} disabled={busy}>
        {busy ? "Rendering…" : "Download .tex"}
      </button>
      {error && (
        <p className="error-hint" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Honest degradation (decision 50): the feature works without a compiler — the
 *  .tex download stays primary and we name the install paths, never winget or
 *  Chocolatey (verified absent/stale). */
function TectonicMissing() {
  return (
    <div className="tectonic-missing">
      <p className="contact-blurb">
        Tectonic isn&apos;t installed, so PDF compile is off — the .tex download above still works.
        Install it, then set <code>TECTONIC_PATH</code> (or put it on your PATH) and reload:
      </p>
      <ul className="install-copy">
        <li>
          <strong>Windows:</strong> <code>scoop install tectonic</code>
        </li>
        <li>
          <strong>macOS:</strong> <code>brew install tectonic</code>
        </li>
        <li>
          <strong>Linux:</strong> <code>pacman -S tectonic</code> or <code>conda install -c conda-forge tectonic</code>
        </li>
        <li>
          <strong>Any OS:</strong> the release binary from{" "}
          <a href="https://github.com/tectonic-typesetting/tectonic/releases" target="_blank" rel="noreferrer">
            github.com/tectonic-typesetting/tectonic
          </a>
        </li>
      </ul>
    </div>
  );
}
