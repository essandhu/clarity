"use client";

import { useEffect, useRef, useState } from "react";
import type { TailoredResume } from "@/shared/schema";
import { resumeFilenameSlug } from "@/domain/resume/resumeLatex";
import { pdfPageCount } from "./pdfPageCount";

// The PDF compile lifecycle (PLAN-RESUME.md decisions 51/52/53), shared by the
// Preview and Downloads tabs so a compile started from one shows in the other.
// A blob object URL is revoked on unmount and on every replace; an in-flight
// compile is aborted on unmount (the useDraftRun precedent). The output is
// reset whenever the (toggled) resume changes — a stale preview must never be
// downloaded as the current resume.

export interface PdfCompileError {
  reason?: string; // the COMPILE_FAILED taxonomy (decision 51); undefined for transport errors
  message: string;
  diagnostics: string[];
}

export interface PdfCompile {
  status: "idle" | "compiling" | "ready" | "error";
  pdfUrl: string | null;
  pageCount: number; // 0 = unknown (compressed object streams) — the caller shows no page note (decision 52)
  filename: string;
  error: PdfCompileError | null;
  // A successful compile always writes the server's warmed marker, so every
  // later compile passes --only-cached and opens no network. Surfacing it lets
  // the disclosure line clear without re-polling /api/health (decision 51). Not
  // reset on a resume change — the marker persists across toggle edits.
  warmed: boolean;
  compile: (allowBundleDownload?: boolean) => Promise<void>;
}

export function usePdfCompile(resume: TailoredResume): PdfCompile {
  const [status, setStatus] = useState<PdfCompile["status"]>("idle");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<PdfCompileError | null>(null);
  const [warmed, setWarmed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);

  const revoke = () => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  };

  // Reset the VISIBLE output when the resume changes (a toggle edit): the old
  // PDF no longer matches what would ship. This is the sanctioned "adjust state
  // during render" pattern (a single guarded pass, no effect) — the blob-URL
  // revoke + in-flight abort are side effects and stay in the effect below.
  const [prevResume, setPrevResume] = useState(resume);
  if (prevResume !== resume) {
    setPrevResume(resume);
    setStatus("idle");
    setPdfUrl(null);
    setPageCount(0);
    setError(null);
  }

  // Side effects only (no setState): free the previous blob URL and abort an
  // in-flight compile when the resume changes (cleanup fires before the next
  // effect) or the hook unmounts (Analyze-another / navigation).
  useEffect(
    () => () => {
      abortRef.current?.abort();
      revoke();
    },
    [resume],
  );

  const filename = `resume-${resumeFilenameSlug(resume.roleLabel)}.pdf`;

  async function compile(allowBundleDownload?: boolean): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("compiling");
    setError(null);
    try {
      const res = await fetch("/api/resume/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resume, format: "pdf", ...(allowBundleDownload ? { allowBundleDownload } : {}) }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          reason?: string;
          diagnostics?: string[];
        };
        setError({
          reason: body.reason,
          message: body.message ?? `Couldn't compile the PDF (HTTP ${res.status}).`,
          diagnostics: body.diagnostics ?? [],
        });
        setStatus("error");
        return;
      }
      const buffer = await res.arrayBuffer();
      if (controller.signal.aborted) return;
      const bytes = new Uint8Array(buffer);
      const url = URL.createObjectURL(new Blob([buffer], { type: "application/pdf" }));
      revoke();
      urlRef.current = url;
      setPdfUrl(url);
      setPageCount(pdfPageCount(bytes));
      setWarmed(true); // the server wrote the marker; further compiles are --only-cached
      setStatus("ready");
    } catch (err) {
      if ((err as Error)?.name === "AbortError" || controller.signal.aborted) return;
      setError({ message: "Couldn't reach the render endpoint.", diagnostics: [] });
      setStatus("error");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  return { status, pdfUrl, pageCount, filename, error, warmed, compile };
}
