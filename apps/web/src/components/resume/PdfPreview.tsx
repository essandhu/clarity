"use client";

import type { PdfCompile } from "./usePdfCompile";

// The [Preview] tab (PLAN-RESUME.md §6, decision 53). Native Blob-URL
// rendering: an UNSANDBOXED same-origin blob iframe (tier 2 of the pre-decided
// fallback chain) — Chromium/Edge disable the built-in PDF viewer inside a
// sandboxed iframe (grey box), and the blob is our own server-generated PDF on
// our own origin, so there is no cross-origin content to sandbox. A download
// link is the honest floor beneath it (chain tier 3's fallback content), and
// the object URL is revoked by usePdfCompile on unmount/replace. No pdf.js.
//
// Recorded shipped tier: 2 (unsandboxed same-origin blob iframe) — see the
// increment-15 browser proof in CLAUDE.md.

export function PdfPreview(props: { pdf: PdfCompile }) {
  const { status, pdfUrl, pageCount, filename } = props.pdf;

  if (status === "ready" && pdfUrl) {
    return (
      <div className="pdf-preview-wrap">
        {pageCount > 1 && (
          <p className="page-note" role="status">
            This resume runs to {pageCount} pages — trim entries or bullets in the What changed tab to
            fit one page.
          </p>
        )}
        <iframe className="pdf-preview" src={pdfUrl} title="Compiled resume preview" />
        <p className="contact-blurb">
          If the preview is blank,{" "}
          <a href={pdfUrl} download={filename}>
            download the PDF
          </a>{" "}
          to open it in your system viewer.
        </p>
      </div>
    );
  }

  if (status === "compiling") {
    return <p className="profile-status">Compiling the PDF…</p>;
  }
  if (status === "error") {
    return (
      <p className="profile-status">
        The last compile failed — see the Downloads tab for details and to retry.
      </p>
    );
  }
  return (
    <p className="profile-status">
      Compile the PDF from the Downloads tab to preview it here. The .tex is always available without a
      compiler.
    </p>
  );
}
