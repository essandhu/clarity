"use client";

import { AgentStepTimeline } from "./AgentStepTimeline";
import { BriefingSectionCard } from "./BriefingSectionCard";
import { CancelButton } from "./CancelButton";
import { CoverageSummary } from "./CoverageSummary";
import { HookCard } from "./HookCard";
import { ListingInputForm } from "./ListingInputForm";
import { ProfileCard } from "./ProfileCard";
import { useAnalysisRun } from "./useAnalysisRun";

// Top-level client component (PLAN.md §6): wires useAnalysisRun to children.
// Progressive rendering — nothing here waits for run.completed.

const FATAL_TITLES: Record<string, string> = {
  INPUT_INVALID: "Could not read that listing",
  MODEL_UNCONFIGURED: "No model is configured",
  EXTRACTION_FAILED: "Extraction failed",
  INTERNAL: "Something went wrong",
};

export function AnalyzeView() {
  const { state, start, cancel, reset } = useAnalysisRun();
  const running = state.phase === "running";
  const finished =
    state.phase === "done" || state.phase === "error" || state.phase === "cancelled";

  return (
    <div className="analyze-view">
      <header className="app-header">
        <h1>Clarity</h1>
        <p className="tagline">
          Paste a job listing, get an interview-ready briefing with cited outreach hooks —
          local-first and free.
        </p>
      </header>

      <ListingInputForm disabled={running} onSubmit={start} />

      {running && <CancelButton onCancel={cancel} />}

      {state.fatal && (
        <div className="error-banner" role="alert">
          <strong>{FATAL_TITLES[state.fatal.code] ?? "Something went wrong"}</strong>
          <p>{state.fatal.message}</p>
          {state.fatal.hint && <p className="error-hint">{state.fatal.hint}</p>}
        </div>
      )}

      {state.phase === "cancelled" && (
        <p className="cancel-note">Run cancelled — showing what was found.</p>
      )}

      <AgentStepTimeline steps={state.steps} />

      {state.profile && <ProfileCard profile={state.profile} />}

      <CoverageSummary
        tiers={state.tiers}
        fetchesUsed={state.fetchesUsed}
        maxFetches={state.budget?.maxFetches}
        notice={state.budgetNotice}
      />

      {state.sectionOrder.length > 0 && (
        <section className="briefing" aria-label="Company briefing">
          <h2 className="section-heading">Briefing</h2>
          {state.sectionOrder.map((id) => {
            const section = state.sections[id];
            return section ? <BriefingSectionCard key={id} section={section} /> : null;
          })}
        </section>
      )}

      {state.hooks.length > 0 && (
        <section className="hooks" aria-label="Outreach hooks">
          <h2 className="section-heading">Outreach hooks</h2>
          {state.hooks.map((hook) => (
            <HookCard key={hook.text} hook={hook} />
          ))}
        </section>
      )}

      {finished && (
        <button type="button" className="ghost-button" onClick={reset}>
          Analyze another listing
        </button>
      )}
    </div>
  );
}
