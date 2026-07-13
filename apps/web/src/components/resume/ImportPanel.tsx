"use client";

import { useState } from "react";
import type { ImportedEntries } from "@/shared/schema";
import { GithubImportSection } from "./GithubImportSection";
import { DropReport } from "./importReport";
import { LinkedinImportSection } from "./LinkedinImportSection";
import { useResumeImportRun } from "./useResumeImportRun";

// The three import affordances (§6): pasted resume (increment 11), GitHub +
// LinkedIn (increment 12) — each section pre-split under the 200-line
// ceiling. The report blocks are the honesty surface: every dropped string
// NAMED, truncation disclosed, files-read-vs-ignored visible, and nothing
// lands in the profile without the explicit merge click (decision 42).

const MIN_CHARS = 40;
const MAX_CHARS = 50_000;

export function ImportPanel(props: {
  canMerge: boolean;
  onMerge(entries: ImportedEntries): void;
}) {
  const { state, start, cancel, dismiss } = useResumeImportRun();
  const [text, setText] = useState("");
  const [inputError, setInputError] = useState<string>();

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed.length < MIN_CHARS) {
      setInputError(`Paste your full resume text — at least ${MIN_CHARS} characters.`);
      return;
    }
    if (trimmed.length > MAX_CHARS) {
      setInputError(`That paste is over the ${MAX_CHARS.toLocaleString()}-character limit.`);
      return;
    }
    setInputError(undefined);
    start(trimmed);
  };

  const entryCount = state.entries
    ? state.entries.experience.length +
      state.entries.projects.length +
      state.entries.education.length +
      state.entries.skills.length
    : 0;

  return (
    <section className="card import-panel" aria-label="Import into your profile">
      <h2 className="section-heading">Import</h2>
      <div className="import-section">
        <h3 className="import-subheading">From a pasted resume</h3>
        <p className="contact-blurb">
          Paste your current resume — entries are extracted locally and every line is verified
          verbatim against your paste before it can enter your profile. Nothing is saved until you
          review and hit Save.
        </p>

      {state.phase === "idle" || state.phase === "error" ? (
        <div className="input-form">
          <textarea
            rows={8}
            aria-label="Pasted resume text"
            placeholder="Paste your resume text here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {inputError && <p className="input-error">{inputError}</p>}
          <button type="button" className="primary-button" onClick={submit}>
            Import from pasted resume
          </button>
        </div>
      ) : null}

      {state.phase === "streaming" && (
        <div className="import-progress">
          <span className="dot pulse" aria-hidden />
          <span>
            Extracting your resume locally… on a CPU-only model this can take a few minutes.
          </span>
          <button type="button" className="cancel-button" onClick={cancel}>
            Cancel import
          </button>
        </div>
      )}

      {state.phase === "error" && (
        <div className="error-banner" role="alert">
          <strong>Import failed</strong>
          <p>{state.error}</p>
        </div>
      )}

      {state.phase === "done" && state.entries && state.report && (
        <div className="import-result">
          <p className="profile-status">
            Extracted {entryCount} {entryCount === 1 ? "entry" : "entries"} from your paste.
          </p>
          {state.report.truncated && (
            <p className="coverage-notice">{state.report.notes[0] ?? "The paste was truncated."}</p>
          )}
          <DropReport droppedStrings={state.report.droppedStrings} />
          <div className="draft-actions">
            <button
              type="button"
              className="primary-button"
              disabled={!props.canMerge || entryCount === 0}
              onClick={() => {
                if (state.entries) props.onMerge(state.entries);
                dismiss();
              }}
            >
              Add {entryCount} {entryCount === 1 ? "entry" : "entries"} to profile
            </button>
            <button type="button" className="ghost-button" onClick={dismiss}>
              Discard
            </button>
          </div>
        </div>
      )}
      </div>

      <GithubImportSection canMerge={props.canMerge} onMerge={props.onMerge} />
      <LinkedinImportSection canMerge={props.canMerge} onMerge={props.onMerge} />
    </section>
  );
}
