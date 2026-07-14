"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ContactCandidate, Hook, ListingProfile } from "@/shared/schema";
import { storeTailorHandoff } from "./resume/tailorHandoff";
import { AgentStepTimeline } from "./AgentStepTimeline";
import { BriefingSectionCard } from "./BriefingSectionCard";
import { CancelButton } from "./CancelButton";
import { ContactPanel } from "./ContactPanel";
import { CoverageSummary } from "./CoverageSummary";
import { DraftNotePanel } from "./DraftNotePanel";
import { HookCard } from "./HookCard";
import { ListingInputForm } from "./ListingInputForm";
import { ProfileCard } from "./ProfileCard";
import type { RunState } from "./runState";
import { useAnalysisRun } from "./useAnalysisRun";

// Top-level client component (PLAN.md §6): wires useAnalysisRun to children.
// Progressive rendering — nothing here waits for run.completed. The one
// exception is deliberate: ContactPanel and DraftNotePanel mount ONLY after
// run.completed (decision 27 — opt-in Stage 4 is structural).

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

  // Two-zone workspace once a run starts: a sticky activity rail (what the
  // agent did) beside the deliverables column (what you got). Before that it's
  // just the centered input intro. Layout only — progressive streaming and the
  // runId-keyed remount are unchanged.
  const started = state.phase !== "idle";

  return (
    <div className="analyze-view">
      <div className="analyze-intro">
        <header className="page-hero">
          <h1 className="page-title">Analyze</h1>
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
      </div>

      <div className={started ? "analyze-workspace started" : "analyze-workspace"}>
        <div className="activity-rail">
          <AgentStepTimeline steps={state.steps} />

          <CoverageSummary
            tiers={state.tiers}
            fetchesUsed={state.fetchesUsed}
            maxFetches={state.budget?.maxFetches}
            notice={state.budgetNotice}
          />
        </div>

        <div className="deliverables">
          {state.profile && <ProfileCard profile={state.profile} />}

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

          {state.phase === "done" && state.profile && (
            <PostRunPanels
              key={state.runId}
              profile={state.profile}
              tiers={state.tiers}
              hooks={state.hooks}
            />
          )}

          {finished && (
            <button type="button" className="ghost-button" onClick={reset}>
              Analyze another listing
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The opt-in Stage-4 surfaces, keyed by runId so a new run remounts them
 *  clean. Owns the one piece of cross-panel state: which candidate the user
 *  picked for the draft. The draft panel is ALSO keyed by that selection —
 *  a note drafted for contact A (greeting A by name) must not survive a
 *  switch to contact B and open in mail with B's address (review finding). */
function PostRunPanels({
  profile,
  tiers,
  hooks,
}: {
  profile: ListingProfile;
  tiers: RunState["tiers"];
  hooks: Hook[];
}) {
  const [contact, setContact] = useState<ContactCandidate | null>(null);
  const router = useRouter();
  const draftKey = contact
    ? `${contact.channel}:${contact.value ?? contact.name ?? ""}`
    : "no-contact";
  return (
    <>
      <div className="tailor-handoff-row">
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            // Decision 54: the profile rides read-once sessionStorage into
            // /resume's kind:'profile' role input — no re-extraction there.
            storeTailorHandoff(profile);
            router.push("/resume");
          }}
        >
          Tailor resume for this role
        </button>
      </div>
      <ContactPanel
        profile={profile}
        tiers={tiers}
        selectedContact={contact}
        onUseContact={setContact}
      />
      <DraftNotePanel key={draftKey} profile={profile} hooks={hooks} contact={contact} />
    </>
  );
}
