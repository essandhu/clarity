"use client";

import { useState } from "react";
import type { ListingProfile } from "@/shared/schema";
import { ProfileCard } from "../ProfileCard";
import { StepRow } from "../StepRow";
import type { TailorRun } from "./useTailorRun";

// The tailor entry surface (PLAN-RESUME.md §6): the handoff banner when an
// analyze run sent a role over, else the role paste box; StepRow reuse gives
// the skip labels + hover details — the fallback-untailored skip detail
// surfaces here — and ProfileCard renders tailor.role.completed.

const MIN_CHARS = 40;
const MAX_CHARS = 50_000;

export function TailorPanel(props: { run: TailorRun; handoff: ListingProfile | null; onDismissHandoff(): void }) {
  const { state, start, cancel } = props.run;
  const [text, setText] = useState("");
  const [inputError, setInputError] = useState<string>();
  const running = state.phase === "running";

  const submitText = () => {
    const trimmed = text.trim();
    if (trimmed.length < MIN_CHARS) {
      setInputError(`Paste the role listing text — at least ${MIN_CHARS} characters.`);
      return;
    }
    if (trimmed.length > MAX_CHARS) {
      setInputError(`That paste is over the ${MAX_CHARS.toLocaleString()}-character limit.`);
      return;
    }
    setInputError(undefined);
    start({ kind: "text", text: trimmed });
  };

  return (
    <section className="card tailor-panel" aria-label="Tailor resume to a role">
      <h2 className="section-heading">Tailor to a role</h2>
      <p className="contact-blurb">
        Selects and reorders entries from your saved profile for one role. Nothing is ever
        invented: every line is your own wording or a rephrase gated word-by-word against it.
      </p>

      {props.handoff && !running ? (
        <div className="handoff-banner">
          <p>
            Tailoring for: <strong>{props.handoff.role}</strong> at{" "}
            <strong>{props.handoff.company}</strong> — from your analysis.
          </p>
          <div className="draft-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => props.handoff && start({ kind: "profile", profile: props.handoff })}
            >
              Tailor resume
            </button>
            <button type="button" className="ghost-button" onClick={props.onDismissHandoff}>
              Paste a role instead
            </button>
          </div>
        </div>
      ) : null}

      {!props.handoff && !running && (
        <div className="input-form">
          <textarea
            rows={6}
            aria-label="Pasted role listing text"
            placeholder="Paste the job listing you are tailoring for…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {inputError && <p className="input-error">{inputError}</p>}
          <button type="button" className="primary-button" onClick={submitText}>
            Tailor resume
          </button>
        </div>
      )}

      {running && (
        <div className="import-progress">
          <span className="dot pulse" aria-hidden />
          <span>Tailoring locally… on a CPU-only model this can take a few minutes.</span>
          <button type="button" className="cancel-button" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}

      {state.steps.length > 0 && (
        <ul className="step-list" aria-label="Tailor steps">
          {state.steps.map((step) => (
            <StepRow key={step.stepId} step={step} />
          ))}
        </ul>
      )}

      {state.error && (
        <div className="error-banner" role="alert">
          <strong>Tailoring failed</strong>
          <p>{state.error.message}</p>
          {state.error.hint && <p className="error-hint">{state.error.hint}</p>}
        </div>
      )}

      {state.roleProfile && <ProfileCard profile={state.roleProfile} />}
    </section>
  );
}
