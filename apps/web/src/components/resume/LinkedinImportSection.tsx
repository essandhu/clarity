"use client";

import { useEffect, useRef, useState } from "react";
import {
  ImportedEntriesSchema,
  ImportReportSchema,
  type ImportedEntries,
  type ImportReport,
} from "@/shared/schema";
import { z } from "zod";
import { readErrorMessage } from "../sseClient";
import { countEntries, DropReport, ImportNotes } from "./importReport";

// LinkedIn export import affordance (§6): the official data-export ZIP,
// parsed in memory server-side. The copy explains how to get the export and
// exactly which files are read — DMs, connections, and registration data are
// never opened (decision 46), and the report renders the whitelist visibly.

const ImportResponseSchema = z.object({
  entries: ImportedEntriesSchema,
  report: ImportReportSchema,
});

type Phase =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "done"; entries: ImportedEntries; report: ImportReport };

export function LinkedinImportSection(props: {
  canMerge: boolean;
  onMerge(entries: ImportedEntries): void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string>();
  // Abort the in-flight upload on unmount (the increment-8 lesson): a
  // 100+ MiB archive must not keep uploading with nobody listening.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const submit = async () => {
    if (!file) {
      setError("Choose your LinkedIn data-export ZIP first.");
      return;
    }
    setError(undefined);
    setPhase({ kind: "uploading" });
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/profile/import/linkedin", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        setError(await readErrorMessage(res));
        setPhase({ kind: "idle" });
        return;
      }
      const parsed = ImportResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        setError("Unexpected response shape from the LinkedIn import.");
        setPhase({ kind: "idle" });
        return;
      }
      setPhase({ kind: "done", entries: parsed.data.entries, report: parsed.data.report });
    } catch {
      if (controller.signal.aborted) return; // unmounted — say nothing
      setError("Could not reach /api/profile/import/linkedin.");
      setPhase({ kind: "idle" });
    }
  };

  return (
    <div className="import-section">
      <h3 className="import-subheading">From LinkedIn</h3>
      <p className="contact-blurb">
        In LinkedIn: Settings &amp; Privacy → Data privacy → “Get a copy of your data”. The
        10-minute fast tier covers most of your resume; Volunteering and your profile summary need
        the full (~24h) archive. Only the 9 resume CSVs are read — messages, connections, and
        registration data are never opened, and nothing leaves this machine.
      </p>
      {phase.kind !== "done" && (
        <div className="import-inline-form">
          <input
            type="file"
            accept=".zip,application/zip"
            aria-label="LinkedIn export ZIP"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={phase.kind === "uploading"}
          />
          <button
            type="button"
            className="secondary-button"
            onClick={() => void submit()}
            disabled={phase.kind === "uploading" || !file}
          >
            {phase.kind === "uploading" ? "Importing…" : "Import from LinkedIn export"}
          </button>
        </div>
      )}

      {phase.kind === "done" && (
        <div className="import-result">
          <p className="profile-status">
            Extracted {countEntries(phase.entries)}{" "}
            {countEntries(phase.entries) === 1 ? "entry" : "entries"} from your export.
          </p>
          <DropReport droppedStrings={phase.report.droppedStrings} />
          <ImportNotes notes={phase.report.notes} />
          <div className="draft-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!props.canMerge || countEntries(phase.entries) === 0}
              onClick={() => {
                props.onMerge(phase.entries);
                setPhase({ kind: "idle" });
                setFile(null);
              }}
            >
              Add to profile
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                setPhase({ kind: "idle" });
                setFile(null);
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="input-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
